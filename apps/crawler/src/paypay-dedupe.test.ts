import { describe, expect, test } from "vitest";
import { findPayPayDuplicates, payPayCsvKey, type DedupeRow } from "./paypay-dedupe.js";

function row(overrides: Partial<DedupeRow>): DedupeRow {
  return {
    mfId: "1000",
    date: "2026-10-01",
    amount: 1000,
    description: "Store A",
    type: "expense",
    accountName: "PayPayカード",
    ...overrides,
  };
}

describe("findPayPayDuplicates", () => {
  test("同じ明細が 2 行あれば、後から登録された行を削除候補にする", () => {
    const older = row({ mfId: "1906534124454150532" });
    const newer = row({ mfId: "1906970681388565253" });

    expect(findPayPayDuplicates([newer, older])).toEqual([newer]);
  });

  test("日付・金額・内容のどれかが違えば重複としない", () => {
    const rows = [
      row({ mfId: "1" }),
      row({ mfId: "2", date: "2026-10-02" }),
      row({ mfId: "3", amount: 2000 }),
      row({ mfId: "4", description: "Store B" }),
      row({ mfId: "5", type: "income" }),
    ];

    expect(findPayPayDuplicates(rows)).toEqual([]);
  });

  test("PayPay 以外の口座の明細は重複していても対象にしない", () => {
    const rows = [
      row({ mfId: "1", accountName: "Bank A" }),
      row({ mfId: "2", accountName: "Bank A" }),
    ];

    expect(findPayPayDuplicates(rows)).toEqual([]);
  });

  test("振替は相手先が PayPay の口座なら対象にする", () => {
    const transfer = {
      type: "transfer",
      accountName: undefined,
      transferTarget: "PayPayカード",
    } as const;
    const older = row({ mfId: "1", ...transfer });
    const newer = row({ mfId: "2", ...transfer });

    expect(findPayPayDuplicates([older, newer])).toEqual([newer]);
  });

  test("PayPay CSV に同じ明細が 2 件あれば 2 件残し、超えた分だけ削除候補にする", () => {
    const rows = [row({ mfId: "3" }), row({ mfId: "1" }), row({ mfId: "2" })];
    const csvCounts = new Map([[payPayCsvKey("2026-10-01", 1000, "Store A"), 2]]);

    expect(findPayPayDuplicates(rows, csvCounts).map((r) => r.mfId)).toEqual(["3"]);
  });
});
