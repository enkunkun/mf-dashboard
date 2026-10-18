import { describe, expect, test } from "vitest";
import { parseEnhikariChargeHistory, shiftMonth, toAllocationConfig } from "./enhikari-billing.js";

/** 実ページと同じ形（スマホ用の並びがもう 1 組ある）の最小の HTML */
const html = `
<div class="hidden-xs">
  <div class="panel panel-default charge-item">
    <div class="panel-heading"><p class="title">
      <a class="accordion-toggle" href="#p_1">2026年9月分 &nbsp;&nbsp;enひかり電気料金合計(税込）<span class="total-price">17,051.<span class="down">66</span> 円</span></a>
    </p></div>
    <div class="accordion-body"><table><tbody><tr><td>ご利用料金</td><td class="text-right price">16,875.10 円</td></tr></tbody></table></div>
  </div>
  <div class="panel panel-default charge-item">
    <div class="panel-heading"><p class="title">
      <a class="accordion-toggle" href="#p_2">2026年8月分 &nbsp;&nbsp;enひかり電気料金合計(税込）<span class="total-price">18,134.<span class="down">34</span> 円</span></a>
    </p></div>
    <div class="accordion-body"><table><tbody><tr><td>ご利用料金</td><td class="text-right price">17,845.10 円</td></tr></tbody></table></div>
  </div>
</div>
<div class="visible-xs">
  <div class="panel panel-default charge-item">
    <a class="accordion-toggle" href="#p_1">2026年9月分 enひかり電気料金合計(税込）<span class="total-price">17,051.<span class="down">66</span> 円</span></a>
  </div>
  <div class="panel panel-default charge-item">
    <a class="accordion-toggle" href="#p_2">2026年8月分 enひかり電気料金合計(税込）<span class="total-price">18,134.<span class="down">34</span> 円</span></a>
  </div>
</div>`;

describe("parseEnhikariChargeHistory", () => {
  test("月と税込合計を取り出す（スマホ用の重複は 1 件にまとめる）", () => {
    expect(parseEnhikariChargeHistory(html)).toEqual([
      { month: "2026-09", total: 17051.66 },
      { month: "2026-08", total: 18134.34 },
    ]);
  });

  test("電気代以外の金額を拾わない", () => {
    const totals = parseEnhikariChargeHistory(html).map((c) => c.total);
    expect(totals).not.toContain(16875.1);
    expect(totals).not.toContain(17845.1);
  });

  test("1 桁月も 0 詰めする", () => {
    expect(
      parseEnhikariChargeHistory(
        '<a href="#p_1">2026年5月分<span class="total-price">12,222.38 円</span></a>',
      ),
    ).toEqual([{ month: "2026-05", total: 12222.38 }]);
  });

  test("明細が無ければ空", () => {
    expect(parseEnhikariChargeHistory("<html><body>ログイン</body></html>")).toEqual([]);
  });

  test("同じ月が違う金額で 2 度出たら止める", () => {
    expect(() =>
      parseEnhikariChargeHistory(
        '<a>2026年9月分<span class="total-price">17,051.66 円</span></a>' +
          '<a>2026年9月分<span class="total-price">17,051.67 円</span></a>',
      ),
    ).toThrow("2026-09 の料金が複数ある");
  });
});

describe("shiftMonth", () => {
  test("年をまたいで前後に動く", () => {
    expect(shiftMonth("2026-09", 2)).toBe("2026-11");
    expect(shiftMonth("2025-12", 2)).toBe("2026-02");
    expect(shiftMonth("2026-01", -2)).toBe("2025-11");
    expect(shiftMonth("2026-03", 0)).toBe("2026-03");
  });
});

describe("toAllocationConfig", () => {
  const base = {
    match: { account: "Card A", descriptionContains: "光コラボ回収代行分" },
    electricityCategory: { category: "水道・光熱費", subcategory: "電気代" },
    internetCategory: { category: "通信費", subcategory: "インターネット" },
  };

  test("明細月に請求のずれを足した月に、円未満を丸めた電気代を入れる", () => {
    const config = toAllocationConfig({
      charges: [
        { month: "2025-09", total: 14178.63 },
        { month: "2025-10", total: 11126.04 },
      ],
      offsetMonths: 2,
      ...base,
    });
    expect(config.electricityByMonth).toEqual({ "2025-11": 14179, "2025-12": 11126 });
    expect(config.match).toEqual(base.match);
  });

  test("from より前の明細は入れない", () => {
    const config = toAllocationConfig({
      charges: [
        { month: "2025-08", total: 1000 },
        { month: "2025-09", total: 14178.63 },
      ],
      offsetMonths: 2,
      from: "2025-09",
      ...base,
    });
    expect(Object.keys(config.electricityByMonth)).toEqual(["2025-11"]);
  });
});
