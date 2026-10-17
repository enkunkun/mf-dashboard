import type { CashFlowItem } from "@mf-dashboard/db/types";
import type { CategoryCandidate } from "./category-decision/types.js";

/** 整理指示ファイルの照合条件。キー名は指示ファイルの形式に合わせる */
export interface CleanupMatch {
  date: string;
  type: "income" | "expense";
  amount_jpy: number;
  account: string;
  description_contains: string;
}

export function findCleanupMatches(
  items: CashFlowItem[],
  match: Omit<CleanupMatch, "type"> & { type: CashFlowItem["type"] },
): CashFlowItem[] {
  return items.filter(
    (item) =>
      item.date === match.date &&
      item.type === match.type &&
      item.amount === match.amount_jpy &&
      item.accountName === match.account &&
      item.description.includes(match.description_contains),
  );
}

export interface SetCategoryOperation {
  id: string;
  action: "set_category";
  match: CleanupMatch;
  target: { category: string; subcategory: string | null };
}

export type CleanupPlan =
  | { id: string; status: "apply"; item: CashFlowItem; candidate: CategoryCandidate }
  | { id: string; status: "noop"; item: CashFlowItem }
  | { id: string; status: "skip" | "manual"; reason: string };

export function planSetCategory(
  operation: SetCategoryOperation,
  items: CashFlowItem[],
  candidates: CategoryCandidate[],
): CleanupPlan {
  const { id, target } = operation;
  const matches = findCleanupMatches(items, operation.match);
  const [item] = matches;
  if (matches.length !== 1 || !item) {
    return { id, status: "skip", reason: `一致 ${matches.length} 件` };
  }

  if (target.subcategory === null) {
    const children = candidates
      .filter((c) => c.largeCategoryName === target.category)
      .map((c) => c.middleCategoryName);
    return { id, status: "manual", reason: `小分類を選ぶ: ${children.join(", ")}` };
  }

  if (item.category === target.category && item.subCategory === target.subcategory) {
    return { id, status: "noop", item };
  }

  const candidate = candidates.find(
    (c) => c.largeCategoryName === target.category && c.middleCategoryName === target.subcategory,
  );
  if (!candidate) {
    return { id, status: "skip", reason: `分類 ${target.category}/${target.subcategory} が無い` };
  }
  if (candidate.isIncome !== (item.type === "income")) {
    return { id, status: "skip", reason: "収支の向きが分類と合わない" };
  }
  return { id, status: "apply", item, candidate };
}

export interface LinkTransferOperation {
  id: string;
  action: "link_transfer";
  outflow: CleanupMatch;
  inflow: CleanupMatch;
}

export type LinkTransferPlan =
  | { id: string; status: "apply"; outflow: CashFlowItem; inflow: CashFlowItem }
  | { id: string; status: "noop" }
  | { id: string; status: "skip"; reason: string };

/** 振替にしたが振替先を選んでいない行で、MF が振替先の欄に出す文言 */
const UNSET_TRANSFER_TARGET = "未設定";

export function planLinkTransfer(
  operation: LinkTransferOperation,
  items: CashFlowItem[],
): LinkTransferPlan {
  const { id, outflow: outflowMatch, inflow: inflowMatch } = operation;
  // 振替にした行は種別が transfer になり、出金側は口座と振替先が入れ替わって読まれる。
  // そのため振替行は、口座と振替先の組を向きを問わずに比べる
  const transferRows = (match: CleanupMatch, partner: string) =>
    items.filter((item) => {
      if (item.type !== "transfer") return false;
      if (item.date !== match.date || item.amount !== match.amount_jpy) return false;
      if (!item.description.includes(match.description_contains)) return false;
      const ends = [item.accountName ?? "", item.transferTarget ?? ""];
      return (
        (ends[0] === match.account && ends[1] === partner) ||
        (ends[0] === partner && ends[1] === match.account)
      );
    });
  const linkedOutflows = transferRows(outflowMatch, inflowMatch.account);
  const linkedInflows = transferRows(inflowMatch, outflowMatch.account);
  if (linkedOutflows.length === 1 && linkedInflows.length === 1) return { id, status: "noop" };

  const outflows = [
    ...findCleanupMatches(items, outflowMatch),
    ...transferRows(outflowMatch, UNSET_TRANSFER_TARGET),
  ];
  const inflows = [
    ...findCleanupMatches(items, inflowMatch),
    ...transferRows(inflowMatch, UNSET_TRANSFER_TARGET),
  ];
  const [outflow] = outflows;
  const [inflow] = inflows;
  if (outflows.length !== 1 || inflows.length !== 1 || !outflow || !inflow) {
    return { id, status: "skip", reason: `出金 ${outflows.length} 件 / 入金 ${inflows.length} 件` };
  }
  return { id, status: "apply", outflow, inflow };
}
