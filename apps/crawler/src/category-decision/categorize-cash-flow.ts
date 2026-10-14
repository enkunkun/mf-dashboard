import { generateCategoryDecisionsWithLLM } from "@mf-dashboard/analytics/categorization";
import type { Db } from "@mf-dashboard/db";
import { findExistingTransactionMfIds } from "@mf-dashboard/db/repository/transactions";
import type { CashFlowItem, CashFlowSummary } from "@mf-dashboard/db/types";
import type { Page } from "playwright";
import { getCsrfToken } from "../hooks/helpers.js";
import { info, warn } from "../logger.js";
import { goToCashFlowMonth } from "../scrapers/cash-flow-history.js";
import { scrapeCategoryCandidates } from "../scrapers/category-candidates.js";
import { applyCategoryDecisions } from "./apply.js";
import { CategoryDecisionEngine, selectTransactionsForCategorization } from "./engine.js";
import type {
  CategoryCandidate,
  CategoryDecisionUsage,
  NormalizedCategoryDecisionConfig,
  ResolvedCategoryDecision,
  TransactionForCategorization,
} from "./types.js";

function toTransactionForCategorization(item: CashFlowItem): TransactionForCategorization | null {
  if (item.type === "transfer") return null;

  return {
    mfId: item.mfId,
    date: item.date,
    amount: item.amount,
    type: item.type,
    accountName: item.accountName,
    description: item.description,
    category: item.category,
    subCategory: item.subCategory,
    isTransfer: item.isTransfer,
    isExcludedFromCalculation: item.isExcludedFromCalculation,
  };
}

function toCategorizationTargets(
  items: CashFlowItem[],
  existingMfIds: Set<string>,
  includeExisting: boolean,
): TransactionForCategorization[] {
  return selectTransactionsForCategorization(
    items
      .map(toTransactionForCategorization)
      .filter((item): item is TransactionForCategorization => item !== null),
    includeExisting ? new Set() : existingMfIds,
  );
}

async function findCategorizationTargets(
  db: Db,
  cashFlow: CashFlowSummary,
  includeExisting: boolean,
): Promise<TransactionForCategorization[]> {
  const mfIds = cashFlow.items.map((item) => item.mfId);
  const existingMfIds = await findExistingTransactionMfIds(db, mfIds);
  return toCategorizationTargets(cashFlow.items, existingMfIds, includeExisting);
}

function applyDecisionsToCashFlow(
  cashFlow: CashFlowSummary,
  decisions: ResolvedCategoryDecision[],
): CashFlowSummary {
  if (decisions.length === 0) return cashFlow;

  const decisionsByMfId = new Map(
    decisions.map((item) => [
      item.transaction.mfId,
      {
        category: item.candidate.largeCategoryName,
        subCategory: item.candidate.middleCategoryName,
      },
    ]),
  );

  return {
    ...cashFlow,
    items: cashFlow.items.map((item) => {
      const decision = decisionsByMfId.get(item.mfId);
      if (!decision) return item;

      return {
        ...item,
        category: decision.category,
        subCategory: decision.subCategory,
      };
    }),
  };
}

async function applyResolvedDecisions(
  page: Page,
  month: string,
  decisions: ResolvedCategoryDecision[],
): Promise<ResolvedCategoryDecision[]> {
  if (decisions.length === 0) return [];

  // 更新は表示中の行の編集フォームを土台にするため、その月の明細を開いておく
  await goToCashFlowMonth(page, month);
  const csrfToken = await getCsrfToken(page);
  if (!csrfToken) {
    warn("Skipped category update because CSRF token was not found.");
    return [];
  }

  const { appliedDecisions } = await applyCategoryDecisions({ page, csrfToken, decisions });
  return appliedDecisions;
}

export async function categorizeCashFlowMonth(options: {
  page: Page;
  db: Db;
  cashFlow: CashFlowSummary;
  config: NormalizedCategoryDecisionConfig;
  usage: CategoryDecisionUsage;
  includeExisting?: boolean;
  candidates?: CategoryCandidate[];
  onAppliedDecisions?: (decisions: ResolvedCategoryDecision[]) => Promise<void>;
}): Promise<CashFlowSummary> {
  const {
    page,
    db,
    cashFlow,
    config,
    usage,
    includeExisting = false,
    candidates: providedCandidates,
    onAppliedDecisions,
  } = options;

  try {
    const targets = includeExisting
      ? toCategorizationTargets(cashFlow.items, new Set(), true)
      : await findCategorizationTargets(db, cashFlow, false);
    if (targets.length === 0) return cashFlow;

    const candidates = providedCandidates ?? (await scrapeCategoryCandidates(page));
    if (candidates.length === 0) {
      warn("Skipped category decision because no Money Forward category candidates were found.");
      return cashFlow;
    }

    const engine = new CategoryDecisionEngine({
      config,
      candidates,
      usage,
      warn,
      llmBatchDecider: (items) =>
        generateCategoryDecisionsWithLLM(items, ({ cacheReadTokens, cacheWriteTokens }) => {
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheReadTokens;
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWriteTokens;
        }),
    });
    const skippedBefore = {
      lowConfidence: usage.skippedLowConfidence ?? 0,
      undecided: usage.skippedUndecided ?? 0,
    };
    const decisions = await engine.decideMany(targets);
    const appliedDecisions = await applyResolvedDecisions(page, cashFlow.month, decisions);
    usage.appliedDecisions = (usage.appliedDecisions ?? 0) + appliedDecisions.length;

    const lowConfidence = (usage.skippedLowConfidence ?? 0) - skippedBefore.lowConfidence;
    const undecided = (usage.skippedUndecided ?? 0) - skippedBefore.undecided;
    info(
      `Category decisions for ${cashFlow.month}: applied ${appliedDecisions.length}/${decisions.length}, skipped ${lowConfidence + undecided} (low confidence ${lowConfidence}, undecided ${undecided})`,
    );
    if (appliedDecisions.length === 0) return cashFlow;

    await onAppliedDecisions?.(appliedDecisions);
    return applyDecisionsToCashFlow(cashFlow, appliedDecisions);
  } catch {
    warn(
      `Category decision failed for ${cashFlow.month}; saving scraped cash flow (code: CATEGORY_DECISION_PIPELINE_FAILED).`,
    );
    return cashFlow;
  }
}
