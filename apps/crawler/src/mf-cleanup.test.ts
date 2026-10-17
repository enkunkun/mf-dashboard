import type { CashFlowItem } from "@mf-dashboard/db/types";
import { describe, expect, test } from "vitest";
import type { CategoryCandidate } from "./category-decision/types.js";
import {
  findCleanupMatches,
  planLinkTransfer,
  planSetCategory,
  type CleanupMatch,
  type LinkTransferOperation,
  type SetCategoryOperation,
} from "./mf-cleanup.js";

function item(overrides: Partial<CashFlowItem>): CashFlowItem {
  return {
    mfId: "1",
    date: "2026-07-01",
    category: "未分類",
    subCategory: "未分類",
    description: "Store A 上野店",
    amount: 1000,
    type: "expense",
    isTransfer: false,
    isExcludedFromCalculation: false,
    accountName: "Card A",
    ...overrides,
  };
}

const match: CleanupMatch = {
  date: "2026-07-01",
  type: "expense",
  amount_jpy: 1000,
  account: "Card A",
  description_contains: "Store A",
};

describe("findCleanupMatches", () => {
  test("日付・種別・金額・口座が一致し内容を含む行を返す", () => {
    const target = item({ mfId: "1" });
    expect(findCleanupMatches([target], match)).toEqual([target]);
  });

  test("日付・種別・金額・口座のどれかが違う行は返さない", () => {
    const items = [
      item({ mfId: "2", date: "2026-07-02" }),
      item({ mfId: "3", type: "income" }),
      item({ mfId: "4", amount: 1001 }),
      item({ mfId: "5", accountName: "Card B" }),
    ];
    expect(findCleanupMatches(items, match)).toEqual([]);
  });

  test("内容の照合は大文字と小文字を区別する", () => {
    expect(findCleanupMatches([item({ description: "STORE A" })], match)).toEqual([]);
  });
});

const candidates: CategoryCandidate[] = [
  candidate("11", "食費", "101", "外食"),
  candidate("11", "食費", "102", "カフェ"),
  candidate("12", "交際費", "201", "飲み会"),
  candidate("12", "交際費", "202", "プレゼント"),
  { ...candidate("1", "収入", "301", "売却"), isIncome: true },
];

function candidate(
  largeCategoryId: string,
  largeCategoryName: string,
  middleCategoryId: string,
  middleCategoryName: string,
): CategoryCandidate {
  return {
    largeCategoryId,
    largeCategoryName,
    middleCategoryId,
    middleCategoryName,
    isIncome: false,
  };
}

function setCategory(target: SetCategoryOperation["target"]): SetCategoryOperation {
  return { id: "OP-1", action: "set_category", match, target };
}

describe("planSetCategory", () => {
  test("一致が 1 件で分類が存在すれば、その分類を適用する", () => {
    const target = item({ mfId: "1" });
    expect(
      planSetCategory(setCategory({ category: "食費", subcategory: "外食" }), [target], candidates),
    ).toEqual({
      id: "OP-1",
      status: "apply",
      item: target,
      candidate: candidates[0],
    });
  });

  test("一致が 0 件か複数件なら適用しない", () => {
    const op = setCategory({ category: "食費", subcategory: "外食" });
    expect(planSetCategory(op, [], candidates)).toMatchObject({
      status: "skip",
      reason: "一致 0 件",
    });
    expect(
      planSetCategory(op, [item({ mfId: "1" }), item({ mfId: "2" })], candidates),
    ).toMatchObject({ status: "skip", reason: "一致 2 件" });
  });

  test("すでに同じ分類なら書き換えない", () => {
    const target = item({ category: "食費", subCategory: "外食" });
    expect(
      planSetCategory(setCategory({ category: "食費", subcategory: "外食" }), [target], candidates),
    ).toMatchObject({ status: "noop", item: target });
  });

  test("存在しない分類は作らずに飛ばす", () => {
    expect(
      planSetCategory(
        setCategory({ category: "食費", subcategory: "Unknown" }),
        [item({})],
        candidates,
      ),
    ).toMatchObject({ status: "skip", reason: "分類 食費/Unknown が無い" });
  });

  test("支出の行に収入の分類を付ける指示は飛ばす", () => {
    expect(
      planSetCategory(
        setCategory({ category: "収入", subcategory: "売却" }),
        [item({})],
        candidates,
      ),
    ).toMatchObject({ status: "skip", reason: "収支の向きが分類と合わない" });
  });

  test("小分類が未定なら、既存の小分類を添えて手動確認に回す", () => {
    expect(
      planSetCategory(
        setCategory({ category: "交際費", subcategory: null }),
        [item({})],
        candidates,
      ),
    ).toMatchObject({ status: "manual", reason: "小分類を選ぶ: 飲み会, プレゼント" });
  });
});

describe("planLinkTransfer", () => {
  const outflow: CleanupMatch = {
    ...match,
    account: "Bank A",
    description_contains: "To Wallet A",
  };
  const inflow: CleanupMatch = {
    ...match,
    type: "income",
    account: "Wallet A",
    description_contains: "From Bank A",
  };
  const operation: LinkTransferOperation = { id: "OP-2", action: "link_transfer", outflow, inflow };
  const bankRow = item({ mfId: "10", accountName: "Bank A", description: "To Wallet A" });
  const walletRow = item({
    mfId: "11",
    type: "income",
    accountName: "Wallet A",
    description: "From Bank A",
  });

  test("出金と入金が 1 件ずつ見つかれば両方を振替にする", () => {
    expect(planLinkTransfer(operation, [bankRow, walletRow])).toEqual({
      id: "OP-2",
      status: "apply",
      outflow: bankRow,
      inflow: walletRow,
    });
  });

  test("片側しか見つからなければ組ごと飛ばす", () => {
    expect(planLinkTransfer(operation, [bankRow])).toMatchObject({
      status: "skip",
      reason: "出金 1 件 / 入金 0 件",
    });
  });

  test("振替先が未設定の振替行は、振替先の設定だけをやり直す対象にする", () => {
    const unsetBank = {
      ...bankRow,
      type: "transfer" as const,
      isTransfer: true,
      accountName: "未設定",
      transferTarget: "Bank A",
    };
    const unsetWallet = {
      ...walletRow,
      type: "transfer" as const,
      isTransfer: true,
      transferTarget: "未設定",
    };
    expect(planLinkTransfer(operation, [unsetBank, unsetWallet])).toEqual({
      id: "OP-2",
      status: "apply",
      outflow: unsetBank,
      inflow: unsetWallet,
    });
  });

  test("両側とも互いの口座を振替先にした振替なら書き換えない", () => {
    // 出金側の振替行は口座と振替先が入れ替わって読まれる
    const linkedBank = {
      ...bankRow,
      type: "transfer" as const,
      isTransfer: true,
      accountName: "Wallet A",
      transferTarget: "Bank A",
    };
    const linkedWallet = {
      ...walletRow,
      type: "transfer" as const,
      isTransfer: true,
      transferTarget: "Bank A",
    };
    expect(planLinkTransfer(operation, [linkedBank, linkedWallet])).toMatchObject({
      status: "noop",
    });
  });
});
