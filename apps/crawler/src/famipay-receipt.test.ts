import { describe, expect, it } from "vitest";
import {
  allocateReceiptByCategory,
  extractReceiptLine,
  extractReceiptTotal,
  parseReceiptText,
} from "./famipay-receipt.js";

const MIXED_RECEIPT = [
  "テスト店　　　　　　　　　　　",
  "東京都千代田区テスト１－２－３　",
  "                                 ",
  "2026年10月17日（土）17:36       ",
  "ﾚｼﾞ 2-3299              責No.034",
  "       ＝＝＝＝＝＝＝＝＝       ",
  "         領　　収　　証         ",
  "       ＝＝＝＝＝＝＝＝＝       ",
  "プルームオーラＮブルー  \\2,980  ",
  "値引き　　　　　　　　  -1,500  ",
  "サービスバッグカラムー    \\345軽",
  "ピザポテトＢＩＧ　　　    \\394軽",
  "ボクサードット／灰Ｍ　    \\880  ",
  "伊右衛門２Ｌ　　　　　    \\207軽",
  "レジ袋４５号バイオマス      \\7  ",
  "ＭＶトロピカルＯプルー    \\590  ",
  "ｸｰﾎﾟﾝ(ｱﾌﾟﾘ引換)           -590  ",
  "（商品合計　　　　　    \\5,403）",
  "（値引合計　　　　　    -2,090）",
  "合    計            \\ 3 , 3 1 3 ",
  "（１０％対象            \\2,367）",
  "  （内消費税等            \\215）",
  "FamiPay支払             \\ 3 , 3 1 3 ",
] as const;

describe("extractReceiptLine", () => {
  it("商品名と金額を分ける", () => {
    expect(extractReceiptLine("伊右衛門２Ｌ　　　　　    \\207軽")).toEqual({
      name: "伊右衛門２Ｌ",
      amount: 207,
      taxReduced: true,
    });
  });

  it("値引きの負の金額を扱う", () => {
    expect(extractReceiptLine("値引き　　　　　　　　  -1,500")).toEqual({
      name: "値引き",
      amount: -1500,
      taxReduced: false,
    });
  });

  it("全角数字を正規化する", () => {
    expect(extractReceiptLine("テスト商品　　　　　　￥１，２３４")).toEqual({
      name: "テスト商品",
      amount: 1234,
      taxReduced: false,
    });
  });

  it("金額の無い行は無視する", () => {
    expect(extractReceiptLine("登録番号：T4011802027408")).toBeNull();
    expect(extractReceiptLine("電話：03-5697-9235")).toBeNull();
  });
});

describe("extractReceiptTotal", () => {
  it("桁区切りと空白入りの合計を読む", () => {
    expect(extractReceiptTotal("合    計            \\ 3 , 3 1 3 ")).toBe(3313);
  });

  it("商品合計の行は合計として扱わない", () => {
    expect(extractReceiptTotal("（商品合計　　　　　    \\5,403）")).toBeNull();
  });
});

describe("parseReceiptText", () => {
  it("商品・値引き・合計に分解する", () => {
    const receipt = parseReceiptText(MIXED_RECEIPT);
    expect(receipt).not.toBeNull();
    if (!receipt) return;

    expect(receipt.items.map((item) => item.name)).toEqual([
      "プルームオーラＮブルー",
      "サービスバッグカラムー",
      "ピザポテトＢＩＧ",
      "ボクサードット／灰Ｍ",
      "伊右衛門２Ｌ",
      "レジ袋４５号バイオマス",
      "ＭＶトロピカルＯプルー",
    ]);
    expect(receipt.itemTotal).toBe(5403);
    expect(receipt.adjustmentTotal).toBe(-2090);
    expect(receipt.total).toBe(3313);
  });

  it("合計行が無ければ null を返す", () => {
    expect(parseReceiptText(["テスト店", "商品　　　\\100"])).toBeNull();
  });

  it("商品行が無ければ null を返す", () => {
    expect(parseReceiptText(["領収証", "合計　\\0"])).toBeNull();
  });
});

describe("allocateReceiptByCategory", () => {
  it("商品をカテゴリ別に按分し、合計を保存する", () => {
    const receipt = parseReceiptText(MIXED_RECEIPT);
    expect(receipt).not.toBeNull();
    if (!receipt) return;

    const allocations = allocateReceiptByCategory(receipt, (name) => {
      if (name.includes("プルーム")) return "趣味・娯楽";
      if (name.includes("ボクサー")) return "衣服・美容";
      if (name.includes("レジ袋") || name.includes("カラムー")) return "日用品";
      return "食費";
    });

    expect(allocations.reduce((sum, allocation) => sum + allocation.amount, 0)).toBe(3313);
    expect(allocations.find((allocation) => allocation.category === "趣味・娯楽")?.amount).toBe(
      1827,
    );
    expect(allocations.find((allocation) => allocation.category === "衣服・美容")?.amount).toBe(
      540,
    );
  });
});
