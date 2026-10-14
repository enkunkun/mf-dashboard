import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import { buildCategoryUpdateBody, updateTransactionCategory } from "./helpers.js";

const categoryOptions = {
  largeCategoryId: "11",
  middleCategoryId: "41",
  isIncome: false,
  isTarget: true,
};

// 手入力口座の行の編集フォーム（金額・日付・内容・口座を持つ）
const manualRowFields = {
  "user_asset_act[id]": "tx-1",
  original_amount: "-5338.0",
  "user_asset_act[large_category_id]": "0",
  "user_asset_act[middle_category_id]": "0",
  "user_asset_act[sub_account_id_hash]": "sub-a",
  "user_asset_act[table_name]": "user_asset_act",
  "user_asset_act[is_income]": "0",
  "user_asset_act[is_target]": "1",
  "user_asset_act[memo]": "memo A",
  "user_asset_act[updated_at]": "2026/10/12",
  "user_asset_act[content]": "Shop A",
  "user_asset_act[amount]": "-5,338",
};

describe("buildCategoryUpdateBody", () => {
  test("フォームの項目を残したままカテゴリと計算対象だけ差し替える", () => {
    const body = new URLSearchParams(
      buildCategoryUpdateBody("tx-1", manualRowFields, { ...categoryOptions, isTarget: false }),
    );

    expect(body.get("user_asset_act[large_category_id]")).toBe("11");
    expect(body.get("user_asset_act[middle_category_id]")).toBe("41");
    expect(body.get("user_asset_act[is_income]")).toBe("0");
    expect(body.get("user_asset_act[is_target]")).toBe("0");
    expect(body.get("original_amount")).toBe("-5338.0");
    expect(body.get("user_asset_act[sub_account_id_hash]")).toBe("sub-a");
    expect(body.get("user_asset_act[updated_at]")).toBe("2026/10/12");
    expect(body.get("user_asset_act[content]")).toBe("Shop A");
    expect(body.get("user_asset_act[memo]")).toBe("memo A");
  });

  test("手入力行の金額は符号とカンマを外した絶対値で送る", () => {
    const body = new URLSearchParams(
      buildCategoryUpdateBody("tx-1", manualRowFields, categoryOptions),
    );

    expect(body.get("user_asset_act[amount]")).toBe("5338");
  });

  test("自動取得の行（金額欄なし）には金額を足さない", () => {
    const {
      "user_asset_act[amount]": _amount,
      original_amount: _original,
      ...autoRowFields
    } = manualRowFields;

    const body = new URLSearchParams(
      buildCategoryUpdateBody("tx-1", autoRowFields, categoryOptions),
    );

    expect(body.has("user_asset_act[amount]")).toBe(false);
  });

  test("フォームの id が対象と違えば本文を作らない", () => {
    expect(() => buildCategoryUpdateBody("tx-2", manualRowFields, categoryOptions)).toThrow(
      "does not match",
    );
  });
});

describe("updateTransactionCategory", () => {
  test("表示中の行の編集フォームを読み、全項目を付けて PUT する", async () => {
    const evaluate = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce(manualRowFields)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await updateTransactionCategory(
      { evaluate } as unknown as Page,
      "csrf",
      "tx-1",
      categoryOptions,
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(evaluate).toHaveBeenCalledTimes(2);
    const request = evaluate.mock.calls[1]?.[1] as { body: string; csrf: string };
    expect(request.csrf).toBe("csrf");
    expect(new URLSearchParams(request.body).get("user_asset_act[amount]")).toBe("5338");
  });

  test("行が表示されていなければ PUT しない", async () => {
    const evaluate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValueOnce(null);

    const result = await updateTransactionCategory(
      { evaluate } as unknown as Page,
      "csrf",
      "tx-1",
      categoryOptions,
    );

    expect(result).toEqual({ ok: false, status: 0 });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
