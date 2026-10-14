export interface CategoryRuleConfig {
  accountName?: string;
  descriptionContains?: string;
  category: string;
  subCategory: string;
}

export interface CategoryDecisionConfig {
  llm?: {
    enabled?: boolean;
    maxPerRun?: number;
    minConfidence?: number;
  };
  rules?: CategoryRuleConfig[];
}

export interface NormalizedCategoryDecisionConfig {
  llm: {
    enabled: boolean;
    maxPerRun: number;
    minConfidence: number;
  };
  rules: CategoryRuleConfig[];
}

export interface CategoryDecision {
  source: "rule" | "llm";
  category: string;
  subCategory: string;
  confidence: number;
  reason: string;
}

export interface LLMCategoryDecision {
  source: "llm";
  largeCategoryId: string;
  middleCategoryId: string;
  confidence: number;
  reason: string;
}

export interface CategoryCandidate {
  largeCategoryId: string;
  largeCategoryName: string;
  middleCategoryId: string;
  middleCategoryName: string;
  isIncome: boolean;
}

export interface TransactionForCategorization {
  mfId: string;
  date: string;
  amount: number;
  type: "income" | "expense";
  accountName?: string;
  description: string;
  category: string | null;
  subCategory: string | null;
  isTransfer: boolean;
  isExcludedFromCalculation: boolean;
}

export interface ResolvedCategoryDecision {
  transaction: TransactionForCategorization;
  decision: CategoryDecision;
  candidate: CategoryCandidate;
}

export type LLMCategoryDecider = (
  transaction: TransactionForCategorization,
  candidates: CategoryCandidate[],
) => Promise<LLMCategoryDecision | null>;

interface LLMCategoryBatchItem {
  transaction: TransactionForCategorization;
  candidates: CategoryCandidate[];
}

interface IndexedLLMCategoryDecision extends LLMCategoryDecision {
  index: number;
}

export type LLMCategoryBatchDecider = (
  items: LLMCategoryBatchItem[],
) => Promise<IndexedLLMCategoryDecision[]>;

export interface CategoryDecisionUsage {
  llmCallsUsed: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** MoneyForward にカテゴリを反映できた明細の数 */
  appliedDecisions?: number;
  /** LLM の confidence が minConfidence 未満で採用しなかった明細の数 */
  skippedLowConfidence?: number;
  /** LLM に送ったが判定が返らなかった明細の数 */
  skippedUndecided?: number;
}
