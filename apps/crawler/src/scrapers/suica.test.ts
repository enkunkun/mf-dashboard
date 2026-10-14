import { describe, expect, it } from "vitest";
import {
  assignDates,
  parseHistoryCells,
  reconcileEntries,
  toSuicaEntries,
  type SuicaEntry,
  type SuicaHistoryRow,
} from "./suica.js";

describe("parseHistoryCells", () => {
  it("ヘッダ行・金額なし行を除外して取り出す", () => {
    const cells = [
      ["", "月日", "種別", "利用場所", "種別", "利用場所", "残高", "入金・利用額"],
      ["", "10/13", "物販", "", "", "", "\\1,671", "-1,980"],
      ["", "10/13", "入", "山手", "出", "横浜", "\\3,651", "-199"],
      ["", "09/01", "ｶｰﾄﾞ", "モバイル", "", "", "\\10,500", "+10,000"],
      ["", "08/31", "ﾊﾞｽ等", "神奈中", "", "", "\\8,755", ""], // 金額なし（最古行）
      ["", "05/15", "入", "JC名古屋", "出", "JC名古屋", "\\8,755", "0"], // 0円は除外
      ["", "2026/10", "x", "y", "z", "w", "1", "2"], // 月日でない行
    ];
    const rows = parseHistoryCells(cells);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      monthDay: "10/13",
      kindIn: "物販",
      amount: -1980,
      balance: 1671,
    });
    expect(rows[1]).toMatchObject({
      kindIn: "入",
      placeIn: "山手",
      kindOut: "出",
      placeOut: "横浜",
      amount: -199,
    });
    expect(rows[2]).toMatchObject({ kindIn: "ｶｰﾄﾞ", amount: 10000 });
  });
});

describe("assignDates", () => {
  const row = (monthDay: string): SuicaHistoryRow => ({
    monthDay,
    kindIn: "物販",
    placeIn: "",
    kindOut: "",
    placeOut: "",
    balance: 0,
    amount: -100,
  });

  it("同一月内はそのまま割り当てる", () => {
    const dates = assignDates([row("10/13"), row("10/10"), row("10/01")], {
      year: 2026,
      month: 10,
      day: 14,
    });
    expect(dates).toEqual(["2026-10-13", "2026-10-10", "2026-10-01"]);
  });

  it("月を跨いだら月を繰り下げる", () => {
    const dates = assignDates([row("10/01"), row("09/30"), row("09/20")], {
      year: 2026,
      month: 10,
      day: 14,
    });
    expect(dates).toEqual(["2026-10-01", "2026-09-30", "2026-09-20"]);
  });

  it("年を跨いだら年も繰り下げる", () => {
    const dates = assignDates([row("01/05"), row("12/31"), row("12/01")], {
      year: 2026,
      month: 1,
      day: 6,
    });
    expect(dates).toEqual(["2026-01-05", "2025-12-31", "2025-12-01"]);
  });
});

describe("toSuicaEntries", () => {
  const anchor = { year: 2026, month: 10, day: 14 };

  it("種別ごとに内容と収支を決める", () => {
    const rows: SuicaHistoryRow[] = [
      {
        monthDay: "10/13",
        kindIn: "入",
        placeIn: "山手",
        kindOut: "出",
        placeOut: "横浜",
        balance: 3651,
        amount: -199,
      },
      {
        monthDay: "10/13",
        kindIn: "物販",
        placeIn: "",
        kindOut: "",
        placeOut: "",
        balance: 1671,
        amount: -1980,
      },
      {
        monthDay: "10/06",
        kindIn: "ﾊﾞｽ等",
        placeIn: "神奈中",
        kindOut: "",
        placeOut: "",
        balance: 6761,
        amount: -240,
      },
      {
        monthDay: "09/28",
        kindIn: "ｶｰﾄﾞ",
        placeIn: "モバイル",
        kindOut: "",
        placeOut: "",
        balance: 10500,
        amount: 10000,
      },
    ];
    const entries = toSuicaEntries(rows, anchor);
    expect(entries[0]).toMatchObject({
      date: "2026-10-13",
      content: "山手→横浜",
      isIncome: false,
      amount: 199,
    });
    expect(entries[1]).toMatchObject({ content: "物販", isIncome: false, amount: 1980 });
    expect(entries[2]).toMatchObject({ content: "バス 神奈中", isIncome: false, amount: 240 });
    expect(entries[3]).toMatchObject({
      date: "2026-09-28",
      content: "チャージ モバイル",
      isIncome: true,
      amount: 10000,
    });
  });

  it("同日同額でも残高が違えばキーが重複しない", () => {
    const rows: SuicaHistoryRow[] = [
      {
        monthDay: "10/06",
        kindIn: "ﾊﾞｽ等",
        placeIn: "神奈中",
        kindOut: "",
        placeOut: "",
        balance: 6761,
        amount: -240,
      },
      {
        monthDay: "10/06",
        kindIn: "ﾊﾞｽ等",
        placeIn: "神奈中",
        kindOut: "",
        placeOut: "",
        balance: 8608,
        amount: -240,
      },
    ];
    const keys = toSuicaEntries(rows, anchor).map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("reconcileEntries", () => {
  const entry = (date: string, amount: number, balance: number, isIncome = false): SuicaEntry => ({
    date,
    isIncome,
    amount,
    content: "x",
    balance,
    key: `${date}|${amount}|${balance}`,
  });

  it("連続していれば残高が一致する（difference 0）", () => {
    const entries = [
      entry("2026-09-28", 10000, 11000, true),
      entry("2026-09-28", 199, 10801),
      entry("2026-10-01", 528, 10273),
    ];
    const r = reconcileEntries(entries);
    expect(r.openingBalance).toBe(1000);
    expect(r.net).toBe(10000 - 199 - 528);
    expect(r.actualClosing).toBe(10273);
    expect(r.expectedClosing).toBe(10273);
    expect(r.difference).toBe(0);
  });

  it("残高に飛びがあれば差分を検出する", () => {
    const entries = [entry("2026-05-01", 200, 5000), entry("2026-05-02", 200, 4000)];
    const r = reconcileEntries(entries);
    expect(r.difference).not.toBe(0);
  });

  it("空なら 0 を返す", () => {
    expect(reconcileEntries([]).difference).toBe(0);
  });
});
