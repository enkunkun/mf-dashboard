import type { CashFlowItem } from "@mf-dashboard/db/types";
import { describe, expect, test } from "vitest";
import type { CategoryCandidate } from "./category-decision/types.js";
import {
  buildSplitCreateBody,
  NO_SOURCE_SUB_ACCOUNT_HASH,
  planEnhikariAllocation,
  type EnhikariAllocationConfig,
} from "./enhikari-allocation.js";

function item(overrides: Partial<CashFlowItem>): CashFlowItem {
  return {
    mfId: "1",
    date: "2026-07-24",
    category: "通信費",
    subCategory: "インターネット",
    description: "光コラボ回収代行分",
    amount: 20000,
    type: "expense",
    isTransfer: false,
    isExcludedFromCalculation: false,
    accountName: "Card A",
    ...overrides,
  };
}

function candidate(
  largeCategoryId: string,
  largeCategoryName: string,
  middleCategoryId: string,
  middleCategoryName: string,
  isIncome = false,
): CategoryCandidate {
  return { largeCategoryId, largeCategoryName, middleCategoryId, middleCategoryName, isIncome };
}

const candidates: CategoryCandidate[] = [
  candidate("5", "水道・光熱費", "51", "電気代"),
  candidate("6", "通信費", "61", "インターネット"),
];

const config: EnhikariAllocationConfig = {
  match: { account: "Card A", descriptionContains: "光コラボ回収代行分" },
  electricityCategory: { category: "水道・光熱費", subcategory: "電気代" },
  internetCategory: { category: "通信費", subcategory: "インターネット" },
  electricityByMonth: { "2026-07": 12000 },
};

describe("planEnhikariAllocation", () => {
  test("対象の 1 件を電気代と光回線に分ける", () => {
    const plan = planEnhikariAllocation(config, [item({})], candidates);
    expect(plan).toHaveLength(1);
    const applied = plan[0]!;
    if (applied.status !== "apply") throw new Error(applied.status);
    expect(applied.electricity).toBe(12000);
    expect(applied.internet).toBe(8000);
    expect(applied.electricityCandidate.middleCategoryName).toBe("電気代");
    expect(applied.internetCandidate.middleCategoryName).toBe("インターネット");
  });

  test("月が違う行は対象にしない", () => {
    const plan = planEnhikariAllocation(config, [item({ date: "2026-08-24" })], candidates);
    expect(plan[0]).toMatchObject({ status: "skip", reason: "一致 0 件" });
  });

  test("一致が 2 件あれば書き換えない", () => {
    const plan = planEnhikariAllocation(
      config,
      [item({ mfId: "1" }), item({ mfId: "2" })],
      candidates,
    );
    expect(plan[0]).toMatchObject({ status: "skip", reason: "一致 2 件" });
  });

  test("収入や振替の行は対象にしない", () => {
    const plan = planEnhikariAllocation(
      config,
      [item({ type: "income" }), item({ mfId: "2", type: "transfer" })],
      candidates,
    );
    expect(plan[0]).toMatchObject({ status: "skip", reason: "一致 0 件" });
  });

  test("既に計算対象外なら何もしない", () => {
    const plan = planEnhikariAllocation(
      config,
      [item({ isExcludedFromCalculation: true })],
      candidates,
    );
    expect(plan[0]).toMatchObject({ status: "noop", reason: "既に計算対象外" });
  });

  test("電気代が明細の金額以上なら書き換えない", () => {
    for (const electricity of [0, -1, 20000, 20001]) {
      const plan = planEnhikariAllocation(
        { ...config, electricityByMonth: { "2026-07": electricity } },
        [item({})],
        candidates,
      );
      expect(plan[0]!.status).toBe("skip");
    }
  });

  test("分類が見つからなければ書き換えない", () => {
    const plan = planEnhikariAllocation(
      config,
      [item({})],
      [candidate("6", "通信費", "61", "インターネット")],
    );
    expect(plan[0]).toMatchObject({
      status: "skip",
      reason: "電気代の分類 水道・光熱費/電気代 が無い",
    });
  });

  test("分類が収入側なら書き換えない", () => {
    const plan = planEnhikariAllocation(
      config,
      [item({})],
      [
        candidate("5", "水道・光熱費", "51", "電気代", true),
        candidate("6", "通信費", "61", "インターネット"),
      ],
    );
    expect(plan[0]).toMatchObject({ status: "skip", reason: "電気代の分類が収入側" });
  });

  test("設定の月を古い順に扱う", () => {
    const plan = planEnhikariAllocation(
      {
        ...config,
        electricityByMonth: { "2026-08": 1, "2026-07": 1 },
      },
      [item({})],
      candidates,
    );
    expect(plan.map((p) => p.month)).toEqual(["2026-07", "2026-08"]);
  });
});

describe("buildSplitCreateBody", () => {
  test("支出元なし・支出として分類つきで送る", () => {
    const body = new URLSearchParams(
      buildSplitCreateBody({
        token: "token",
        date: "2026-07-24",
        amount: 12000,
        content: "enひかり電気",
        largeCategoryId: "5",
        middleCategoryId: "51",
      }),
    );
    expect(body.get("user_asset_act[sub_account_id_hash]")).toBe(NO_SOURCE_SUB_ACCOUNT_HASH);
    expect(body.get("user_asset_act[is_income]")).toBe("0");
    expect(body.get("user_asset_act[is_transfer]")).toBe("0");
    expect(body.get("user_asset_act[amount]")).toBe("12000");
    expect(body.get("user_asset_act[updated_at]")).toBe("2026-07-24");
    expect(body.get("user_asset_act[large_category_id]")).toBe("5");
    expect(body.get("user_asset_act[middle_category_id]")).toBe("51");
    expect(body.get("user_asset_act[content]")).toBe("enひかり電気");
    expect(body.get("authenticity_token")).toBe("token");
  });
});
