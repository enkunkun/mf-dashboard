import { describe, expect, test } from "vitest";
import { correctMerchantDescription } from "./merchant-description.js";

describe("correctMerchantDescription", () => {
  test("潰れた小書き文字と長音を戻す", () => {
    expect(correctMerchantDescription("シヨツプインバ-スアキハバライチゴウテ")).toBe(
      "ショップインバースアキハバライチゴウテ",
    );
    expect(correctMerchantDescription("ペイペイカ-ド")).toBe("ペイペイカード");
    expect(correctMerchantDescription("プロジエクトイ-グ")).toBe("プロジェクトイーグ");
    expect(correctMerchantDescription("キヤンペーン")).toBe("キャンペーン");
  });

  test("半角カナを全角にし、連続する空白を詰める", () => {
    expect(correctMerchantDescription("ﾐﾁﾉｴｷ ｽﾊﾞｼﾘ")).toBe("ミチノエキ スバシリ");
    expect(correctMerchantDescription("  Rocket   Now  ")).toBe("Rocket Now");
  });

  test("カナ以外に挟まれたハイフンはそのまま残す", () => {
    expect(correctMerchantDescription("ST*Splash")).toBe("ST*Splash");
    expect(correctMerchantDescription("14-アークヒルズ店")).toBe("14-アークヒルズ店");
  });

  test("変化しない文字列はそのまま返す", () => {
    // カナに挟まれたハイフンは長音の潰れと区別できないため、長音として補正する
    expect(correctMerchantDescription("セブン-イレブン")).toBe("セブンーイレブン");
    expect(correctMerchantDescription("ローソン")).toBe("ローソン");
    expect(correctMerchantDescription("")).toBe("");
  });
});
