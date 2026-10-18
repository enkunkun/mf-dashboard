import type { CashFlowItem } from "@mf-dashboard/db/types";
import type { CategoryCandidate } from "./category-decision/types.js";

/**
 * enひかりの按分。
 *
 * enひかり電気の料金は enひかり本体（光回線）と合算され、NTT東日本の
 * 「光コラボ回収代行分」としてカードに 1 件で計上される。このままでは家計簿上
 * 全部が通信費になるので、明細を 計算対象外 にして、電気代と光回線の 2 件を
 * 「支出元なし」で登録し直す（MoneyForward の案内する按分のやり方）。
 */

/** 支出元なし（sub_account の「なし」）を表す値。MF の選択肢は "0 :: なし" */
export const NO_SOURCE_SUB_ACCOUNT_HASH = "0";

export interface EnhikariAllocationConfig {
  /** 対象明細の照合。口座名の完全一致と内容の部分一致で 1 件に絞る */
  match: { account: string; descriptionContains: string };
  /** 電気代として切り出す分類 */
  electricityCategory: { category: string; subcategory: string };
  /** 残り（光回線など）の分類 */
  internetCategory: { category: string; subcategory: string };
  /** "YYYY-MM" → その月の電気代（円）。enひかり電気の請求額 */
  electricityByMonth: Record<string, number>;
  /** 明細の内容に付ける文言 */
  contents?: { electricity?: string; internet?: string };
}

export const DEFAULT_CONTENTS = {
  electricity: "enひかり電気",
  internet: "enひかり光（光コラボ）",
} as const;

export type EnhikariAllocationPlan =
  | {
      status: "apply";
      month: string;
      item: CashFlowItem;
      electricity: number;
      internet: number;
      electricityCandidate: CategoryCandidate;
      internetCandidate: CategoryCandidate;
      /** 登録する按分の明細（既に同じものがあれば含まない） */
      create: EnhikariSplitPart[];
      /** 元の明細を計算対象外にする必要があるか（既に外れていれば false） */
      excludeOriginal: boolean;
    }
  | { status: "done"; month: string; reason: string }
  | { status: "skip"; month: string; reason: string };

/** 登録が必要な按分の側 */
type EnhikariSplitPart = "electricity" | "internet";

/** 設定に書かれた月を古い順に返す */
export function allocationMonths(config: EnhikariAllocationConfig): string[] {
  return Object.keys(config.electricityByMonth).sort();
}

export function planEnhikariAllocation(
  config: EnhikariAllocationConfig,
  items: CashFlowItem[],
  candidates: CategoryCandidate[],
  contents: { electricity: string; internet: string } = DEFAULT_CONTENTS,
): EnhikariAllocationPlan[] {
  return allocationMonths(config).map((month): EnhikariAllocationPlan => {
    const electricity = config.electricityByMonth[month]!;

    const matches = items.filter(
      (item) =>
        item.date.startsWith(`${month}-`) &&
        item.type === "expense" &&
        item.accountName === config.match.account &&
        item.description.includes(config.match.descriptionContains),
    );
    const [item] = matches;
    if (matches.length !== 1 || !item) {
      return { status: "skip", month, reason: `一致 ${matches.length} 件` };
    }
    if (!Number.isInteger(electricity) || electricity <= 0) {
      return { status: "skip", month, reason: `電気代 ${electricity} が正の整数でない` };
    }
    if (electricity >= item.amount) {
      return {
        status: "skip",
        month,
        reason: `電気代 ${electricity} が明細の金額 ${item.amount} 以上`,
      };
    }
    const internet = item.amount - electricity;

    const findCandidate = (target: { category: string; subcategory: string }) =>
      candidates.find(
        (c) =>
          c.largeCategoryName === target.category && c.middleCategoryName === target.subcategory,
      );
    const electricityCandidate = findCandidate(config.electricityCategory);
    const internetCandidate = findCandidate(config.internetCategory);
    for (const [label, candidate, target] of [
      ["電気代", electricityCandidate, config.electricityCategory],
      ["光回線", internetCandidate, config.internetCategory],
    ] as const) {
      if (!candidate) {
        return {
          status: "skip",
          month,
          reason: `${label}の分類 ${target.category}/${target.subcategory} が無い`,
        };
      }
      if (candidate.isIncome) {
        return { status: "skip", month, reason: `${label}の分類が収入側` };
      }
    }

    // 既に登録されている按分の明細。金額が違うものは取り違えを避けて触らない
    const inMonth = items.filter((i) => i.date.startsWith(`${month}-`));
    const existing = (content: string) => inMonth.filter((i) => i.description === content);
    const conflicts = [
      ...existing(contents.electricity).filter((i) => i.amount !== electricity),
      ...existing(contents.internet).filter((i) => i.amount !== internet),
    ];
    if (conflicts.length > 0) {
      return {
        status: "skip",
        month,
        reason: `按分の金額が既存と違う（${conflicts
          .map((i) => `${i.description} ${i.amount} 円`)
          .join(", ")}）`,
      };
    }
    const create: EnhikariSplitPart[] = [];
    if (existing(contents.electricity).length === 0) create.push("electricity");
    if (existing(contents.internet).length === 0) create.push("internet");
    if (create.length === 0 && item.isExcludedFromCalculation) {
      return { status: "done", month, reason: "按分済み" };
    }

    return {
      status: "apply",
      month,
      item,
      electricity,
      internet,
      electricityCandidate: electricityCandidate!,
      internetCandidate: internetCandidate!,
      create,
      // 元の明細が計算対象のままなら外す。既に外れているが按分が欠けている場合は
      // 支出が消えたままなので、按分だけ作る
      excludeOriginal: !item.isExcludedFromCalculation,
    };
  });
}

/** /cf/create の本文。支出元なしの明細を分類つきで 1 件登録する */
export function buildSplitCreateBody(params: {
  token: string;
  /** YYYY-MM-DD。MF のフォームは YYYY/MM/DD しか受け付けない（- 区切りだと黙って捨てられる） */
  date: string;
  amount: number;
  content: string;
  largeCategoryId: string;
  middleCategoryId: string;
}): string {
  const body = new URLSearchParams();
  body.append("authenticity_token", params.token);
  body.append("user_asset_act[is_transfer]", "0");
  body.append("user_asset_act[is_income]", "0");
  body.append("user_asset_act[updated_at]", params.date.replace(/-/g, "/"));
  body.append("user_asset_act[amount]", String(params.amount));
  body.append("user_asset_act[sub_account_id_hash]", NO_SOURCE_SUB_ACCOUNT_HASH);
  body.append("user_asset_act[large_category_id]", params.largeCategoryId);
  body.append("user_asset_act[middle_category_id]", params.middleCategoryId);
  body.append("user_asset_act[content]", params.content);
  return body.toString();
}
