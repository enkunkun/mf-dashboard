import { describe, expect, it } from "vitest";
import { cobanEntryKey, reconcileCoban, toCobanEntries, type CobanHistoryEntry } from "./coban.js";

const entry = (over: Partial<CobanHistoryEntry>): CobanHistoryEntry => ({
  amount: 0,
  date_time: "2026-08-16T21:14:20.976406+09:00",
  detail: "d",
  summary: "s",
  type: "paid",
  service_name: null,
  ...over,
});

describe("toCobanEntries", () => {
  it("購入・付与は収入、利用・失効は支出にする", () => {
    const entries = toCobanEntries([
      entry({
        type: "paid",
        amount: 10000,
        date_time: "2026-08-16T21:14:20.976406+09:00",
        summary: "コバン購入",
        detail: "チャージ",
      }),
      entry({
        type: "free",
        amount: 1300,
        date_time: "2026-08-16T21:14:21.104372+09:00",
        summary: "コバン付与",
        detail: "ボーナス",
      }),
      entry({
        type: "usage",
        amount: 1530,
        date_time: "2026-08-16T21:14:41.520962+09:00",
        summary: "コバン利用",
        detail: "pixivcoban利用",
        service_name: "booth",
      }),
      entry({
        type: "expired",
        amount: 331,
        date_time: "2026-04-26T00:00:00.000000+09:00",
        summary: "コバン失効",
        detail: "有効期限切れ",
      }),
    ]);

    expect(entries.map((e) => [e.date, e.isIncome, e.amount, e.content])).toEqual([
      ["2026-04-26", false, 331, "コバン失効"],
      ["2026-08-16", true, 10000, "コバン購入"],
      ["2026-08-16", true, 1300, "コバン付与"],
      ["2026-08-16", false, 1530, "コバン利用（booth）"],
    ]);
  });

  it("金額 0 の行は除外する", () => {
    const entries = toCobanEntries([entry({ type: "usage", amount: 0 })]);
    expect(entries).toHaveLength(0);
  });

  it("日時が同じでも種別・金額・内容が違えばキーが重複しない", () => {
    const same = "2026-08-16T21:14:20.976406+09:00";
    const keys = toCobanEntries([
      entry({ type: "paid", amount: 10000, date_time: same, detail: "チャージ" }),
      entry({ type: "free", amount: 1300, date_time: same, detail: "ボーナス" }),
    ]).map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("同じ明細は常に同じキーになる（再実行しても重複しない）", () => {
    const e = entry({ type: "usage", amount: 990, detail: "pixivcoban利用" });
    expect(cobanEntryKey(e)).toBe(cobanEntryKey({ ...e }));
  });
});

describe("reconcileCoban", () => {
  it("明細の純増減を残高と比較する", () => {
    const entries = toCobanEntries([
      entry({ type: "paid", amount: 10000, date_time: "2026-08-16T00:00:00.000000+09:00" }),
      entry({ type: "usage", amount: 1530, date_time: "2026-08-17T00:00:00.000000+09:00" }),
    ]);
    const r = reconcileCoban(entries, 8470);
    expect(r.net).toBe(8470);
    expect(r.difference).toBe(0);
  });

  it("履歴が欠けていれば差異を検出する", () => {
    const entries = toCobanEntries([entry({ type: "usage", amount: 1000 })]);
    const r = reconcileCoban(entries, 1000);
    expect(r.net).toBe(-1000);
    expect(r.difference).toBe(2000);
  });
});
