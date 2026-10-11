import type { CashFlowItem } from "@mf-dashboard/db/types";
import type { Page } from "playwright";
import { getCsrfToken, updateTransactionCategory } from "../hooks/helpers.js";
import { scrapeCashFlowHistory } from "../scrapers/cash-flow-history.js";
import { scrapeCategoryCandidates } from "../scrapers/category-candidates.js";

export interface SetCalculationExclusionOperation {
  type: "set-calculation-exclusion";
  transactionId: string;
  excluded: boolean;
}

export type MoneyForwardOperation = SetCalculationExclusionOperation;

export async function applyMoneyForwardOperation(
  page: Page,
  operation: MoneyForwardOperation & { month: string },
): Promise<void> {
  const [monthResult] = await scrapeCashFlowHistory(page, 1, { targetMonth: operation.month });
  const matches =
    monthResult?.data.items.filter((item) => item.mfId === operation.transactionId) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "MoneyForward transaction not found in requested month"
        : "MoneyForward transaction ID is ambiguous",
    );
  }

  const transaction: CashFlowItem = matches[0]!;
  if (transaction.isTransfer || transaction.type === "transfer") {
    throw new Error("Calculation exclusion cannot be changed for a transfer transaction");
  }
  if (!transaction.category || !transaction.subCategory) {
    throw new Error(
      "Transaction must have a category before its calculation setting can be changed",
    );
  }
  if (transaction.isExcludedFromCalculation === operation.excluded) return;

  const categories = await scrapeCategoryCandidates(page);
  const candidates = categories.filter(
    (candidate) =>
      candidate.largeCategoryName === transaction.category &&
      candidate.middleCategoryName === transaction.subCategory &&
      candidate.isIncome === (transaction.type === "income"),
  );
  if (candidates.length !== 1) {
    throw new Error("Could not uniquely resolve the transaction's current MoneyForward category");
  }

  const csrfToken = await getCsrfToken(page);
  if (!csrfToken) throw new Error("MoneyForward CSRF token is unavailable");

  const result = await updateTransactionCategory(page, csrfToken, operation.transactionId, {
    largeCategoryId: candidates[0]!.largeCategoryId,
    middleCategoryId: candidates[0]!.middleCategoryId,
    isIncome: transaction.type === "income",
    isTarget: !operation.excluded,
  });
  if (!result.ok)
    throw new Error(`MoneyForward rejected calculation setting update (${result.status})`);
}
