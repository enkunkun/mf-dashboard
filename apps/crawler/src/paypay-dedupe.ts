/**
 * PayPay 取込が MF の手動口座に作った明細の二重登録を見つける。
 * 取込済み ID の記録が複数の実行環境に分かれると、同じ明細が再登録されるため。
 */

export interface DedupeRow {
  mfId: string;
  date: string;
  amount: number;
  description: string;
  type: "income" | "expense" | "transfer";
  accountName?: string;
  transferTarget?: string;
}

const PAYPAY_ACCOUNTS = new Set(["PayPay", "PayPayカード"]);

function isPayPayRow(r: DedupeRow): boolean {
  return PAYPAY_ACCOUNTS.has(r.accountName ?? "") || PAYPAY_ACCOUNTS.has(r.transferTarget ?? "");
}

/** 削除すべき行（各キーで先に登録された行を残した残り）を返す。 */
export function findPayPayDuplicates(
  rows: DedupeRow[],
  csvCounts: Map<string, number> = new Map(),
): DedupeRow[] {
  const groups = new Map<string, DedupeRow[]>();
  for (const r of rows.filter(isPayPayRow)) {
    const key = [r.type, r.accountName, r.transferTarget, r.date, r.amount, r.description].join(
      "\u0000",
    );
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const duplicates: DedupeRow[] = [];
  for (const group of groups.values()) {
    // MF の明細 ID は登録順に増えるので、小さい方が先に取り込んだ行。
    const sorted = group.toSorted((a, b) => (BigInt(a.mfId) < BigInt(b.mfId) ? -1 : 1));
    const first = sorted[0]!;
    const keep = Math.max(
      1,
      csvCounts.get(payPayCsvKey(first.date, first.amount, first.description)) ?? 1,
    );
    duplicates.push(...sorted.slice(keep));
  }
  return duplicates;
}

/** PayPay CSV の取引と MF の明細を突き合わせるキー。 */
export function payPayCsvKey(date: string, amount: number, description: string): string {
  return [date, amount, description].join("\u0000");
}
