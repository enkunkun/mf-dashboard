import type {
  CategoryCandidate,
  CategoryDecision,
  CategoryDecisionUsage,
  LLMCategoryDecision,
  LLMCategoryBatchDecider,
  LLMCategoryDecider,
  NormalizedCategoryDecisionConfig,
  ResolvedCategoryDecision,
  TransactionForCategorization,
} from "./types.js";

interface CategoryDecisionEngineOptions {
  config: NormalizedCategoryDecisionConfig;
  candidates: CategoryCandidate[];
  llmDecider?: LLMCategoryDecider;
  llmBatchDecider?: LLMCategoryBatchDecider;
  warn?: (...args: unknown[]) => void;
  usage?: CategoryDecisionUsage;
  now?: () => Date;
}

export function selectTransactionsForCategorization(
  transactions: TransactionForCategorization[],
  existingMfIds: Set<string>,
): TransactionForCategorization[] {
  return transactions.filter(
    (transaction) =>
      transaction.mfId.length > 0 &&
      !transaction.mfId.startsWith("unknown") &&
      !existingMfIds.has(transaction.mfId) &&
      transaction.category === "未分類" &&
      !transaction.isTransfer &&
      !transaction.isExcludedFromCalculation,
  );
}

function candidateTypeMatches(
  candidate: CategoryCandidate,
  transaction: TransactionForCategorization,
): boolean {
  return candidate.isIncome === (transaction.type === "income");
}

function findCandidateByName(
  candidates: CategoryCandidate[],
  transaction: TransactionForCategorization,
  category: string,
  subCategory: string,
): CategoryCandidate | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.largeCategoryName === category &&
        candidate.middleCategoryName === subCategory &&
        candidateTypeMatches(candidate, transaction),
    ) ?? null
  );
}

function findCandidateById(
  candidates: CategoryCandidate[],
  transaction: TransactionForCategorization,
  decision: LLMCategoryDecision,
): CategoryCandidate | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.largeCategoryId === decision.largeCategoryId &&
        candidate.middleCategoryId === decision.middleCategoryId &&
        candidateTypeMatches(candidate, transaction),
    ) ?? null
  );
}

function subtractMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() - months);
  return result;
}

function isOlderThanMonths(value: string, months: number, now: Date): boolean {
  const cutoff = subtractMonths(now, months).toISOString().slice(0, 10);
  return value < cutoff;
}

function ruleMatches(
  transaction: TransactionForCategorization,
  rule: NormalizedCategoryDecisionConfig["rules"][number],
  now: Date,
): boolean {
  if (!rule.accountName && !rule.descriptionContains && rule.olderThanMonths === undefined) {
    return false;
  }
  if (rule.accountName && transaction.accountName !== rule.accountName) return false;
  if (rule.descriptionContains && !transaction.description.includes(rule.descriptionContains)) {
    return false;
  }
  if (
    rule.olderThanMonths !== undefined &&
    !isOlderThanMonths(transaction.date, rule.olderThanMonths, now)
  ) {
    return false;
  }
  return true;
}

export class CategoryDecisionEngine {
  static readonly #batchSize = 20;
  readonly #config: NormalizedCategoryDecisionConfig;
  readonly #candidates: CategoryCandidate[];
  readonly #llmDecider: LLMCategoryDecider | undefined;
  readonly #llmBatchDecider: LLMCategoryBatchDecider | undefined;
  readonly #warn: (...args: unknown[]) => void;
  readonly #usage: CategoryDecisionUsage;
  readonly #now: () => Date;
  readonly #warnedInvalidRules = new Set<string>();

  constructor(options: CategoryDecisionEngineOptions) {
    this.#config = options.config;
    this.#candidates = options.candidates;
    this.#llmDecider = options.llmDecider;
    this.#llmBatchDecider = options.llmBatchDecider;
    this.#warn = options.warn ?? (() => {});
    this.#usage = options.usage ?? { llmCallsUsed: 0 };
    this.#now = options.now ?? (() => new Date());
  }

  async decideMany(
    transactions: TransactionForCategorization[],
  ): Promise<ResolvedCategoryDecision[]> {
    if (this.#llmBatchDecider) return this.#decideManyInBatches(transactions);

    const results: ResolvedCategoryDecision[] = [];

    for (const transaction of transactions) {
      const decision = await this.#decide(transaction);
      if (decision) {
        results.push(decision);
      }
    }

    return results;
  }

  async #decideManyInBatches(
    transactions: TransactionForCategorization[],
  ): Promise<ResolvedCategoryDecision[]> {
    const results: ResolvedCategoryDecision[] = [];
    const targets: Array<{
      transaction: TransactionForCategorization;
      candidates: CategoryCandidate[];
    }> = [];

    for (const transaction of transactions) {
      const ruleDecision = this.#decideByRule(transaction);
      if (ruleDecision) {
        results.push(ruleDecision);
        continue;
      }
      if (!this.#config.llm.enabled) continue;

      const matchingCandidates = this.#candidates.filter((candidate) =>
        candidateTypeMatches(candidate, transaction),
      );
      if (matchingCandidates.length > 0) {
        targets.push({ transaction, candidates: this.#candidates });
      }
    }

    for (let offset = 0; offset < targets.length; offset += CategoryDecisionEngine.#batchSize) {
      if (this.#usage.llmCallsUsed >= this.#config.llm.maxPerRun) break;
      const batch = targets.slice(offset, offset + CategoryDecisionEngine.#batchSize);
      this.#usage.llmCallsUsed += 1;

      try {
        const decisions = await this.#llmBatchDecider!(batch);
        const seenIndexes = new Set<number>();
        let answeredCount = 0;
        for (const decision of decisions) {
          if (seenIndexes.has(decision.index)) continue;
          seenIndexes.add(decision.index);
          const target = batch[decision.index];
          if (!target) continue;
          answeredCount += 1;
          if (decision.confidence < this.#config.llm.minConfidence) {
            this.#countSkipped("skippedLowConfidence", 1);
            continue;
          }

          const resolved = this.#resolveLLMDecision(target.transaction, decision);
          if (resolved) results.push(resolved);
        }
        this.#countSkipped("skippedUndecided", batch.length - answeredCount);
      } catch {
        this.#warn("LLM category decision failed (code: LLM_REQUEST_FAILED).");
      }
    }

    return results;
  }

  async #decide(
    transaction: TransactionForCategorization,
  ): Promise<ResolvedCategoryDecision | null> {
    const ruleDecision = this.#decideByRule(transaction);
    if (ruleDecision) return ruleDecision;

    if (!this.#config.llm.enabled || !this.#llmDecider) return null;
    if (this.#usage.llmCallsUsed >= this.#config.llm.maxPerRun) return null;

    try {
      const llmCandidates = this.#candidates.filter((candidate) =>
        candidateTypeMatches(candidate, transaction),
      );
      if (llmCandidates.length === 0) return null;

      this.#usage.llmCallsUsed += 1;
      const llmDecision = await this.#llmDecider(transaction, llmCandidates);
      if (!llmDecision) {
        this.#countSkipped("skippedUndecided", 1);
        return null;
      }

      if (llmDecision.confidence < this.#config.llm.minConfidence) {
        this.#countSkipped("skippedLowConfidence", 1);
        return null;
      }

      return this.#resolveLLMDecision(transaction, llmDecision);
    } catch {
      this.#warn("LLM category decision failed (code: LLM_REQUEST_FAILED).");
      return null;
    }
  }

  #countSkipped(kind: "skippedLowConfidence" | "skippedUndecided", count: number): void {
    this.#usage[kind] = (this.#usage[kind] ?? 0) + count;
  }

  #decideByRule(transaction: TransactionForCategorization): ResolvedCategoryDecision | null {
    for (const rule of this.#config.rules) {
      if (!ruleMatches(transaction, rule, this.#now())) continue;

      const candidate = findCandidateByName(
        this.#candidates,
        transaction,
        rule.category,
        rule.subCategory,
      );

      if (!candidate) {
        // 収入と支出で候補が分かれるため、反対側の候補しか持たないルールは正常に起きる。
        // 同じルールでログを埋めないよう、ルールごとに一度だけ警告する
        const key = `${rule.accountName ?? ""}|${rule.descriptionContains ?? ""}|${rule.olderThanMonths ?? ""}|${rule.category}|${rule.subCategory}`;
        if (!this.#warnedInvalidRules.has(key)) {
          this.#warnedInvalidRules.add(key);
          this.#warn(
            `Invalid category rule ignored: ${rule.category} > ${rule.subCategory} is not in Money Forward candidates`,
          );
        }
        continue;
      }

      const decision: CategoryDecision = {
        source: "rule",
        category: rule.category,
        subCategory: rule.subCategory,
        confidence: 1,
        reason: `Matched rule: ${[
          rule.accountName ? `accountName=${rule.accountName}` : null,
          rule.descriptionContains ? `descriptionContains=${rule.descriptionContains}` : null,
        ]
          .filter(Boolean)
          .join(" + ")}`,
      };

      return {
        transaction,
        decision,
        candidate,
      };
    }

    return null;
  }

  #resolveLLMDecision(
    transaction: TransactionForCategorization,
    decision: LLMCategoryDecision,
  ): ResolvedCategoryDecision | null {
    const candidate = findCandidateById(this.#candidates, transaction, decision);

    if (!candidate) {
      this.#warn(
        `LLM category decision ignored: ${decision.largeCategoryId} > ${decision.middleCategoryId} is not in Money Forward candidates`,
      );
      return null;
    }

    return {
      transaction,
      decision: {
        source: "llm",
        category: candidate.largeCategoryName,
        subCategory: candidate.middleCategoryName,
        confidence: decision.confidence,
        reason: decision.reason,
      },
      candidate,
    };
  }
}
