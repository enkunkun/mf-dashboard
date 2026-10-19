/**
 * ファミペイの残高と履歴を取得して `data/famipay-*.json` に保存する。
 *
 * 使い方:
 *   pnpm --filter @mf-dashboard/crawler famipay:fetch
 *   tsx --env-file=../../.env scripts/famipay-fetch.ts --from 20260101 --to 20260131
 *   tsx --env-file=../../.env scripts/famipay-fetch.ts --no-detail   # 明細APIを叩かない
 *
 * セッションが無効ならブラウザを開いてログインを求める（SMS のワンタイムコードは手入力）。
 * 履歴 1 行につき金額内訳（`MONEY_CASH` / `MONEY_PREPAID`）を取るために
 * 明細 API を 1 回叩く。件数が多いときは `--limit` で絞る。
 */
import fs from "node:fs";
import path from "node:path";
import {
  FAMIPAY_HISTORY_PAGE_SIZE,
  classifyFamipayRow,
  famipayEntryContent,
  famipayEntryKey,
  needsFamipayDetail,
  toMoneyForwardDate,
  type FamipayHistoryDetail,
  type FamipayHistoryRow,
  type FamipayTransactionKind,
} from "../src/famipay.js";
import {
  FAMIPAY_DATA_DIR,
  generateHistoryDetail,
  getZandaka,
  listFamipayHistory,
} from "./lib/famipay-api.js";
import { ensureFamipaySession } from "./lib/famipay-login.js";

const HISTORY_MAX_PAGES = 20;

type Options = {
  from: string;
  to: string;
  limit: number | null;
  withDetail: boolean;
};

type FetchedEntry = {
  uriageNo: string;
  date: string;
  mfDate: string | null;
  content: string;
  amount: number;
  isIncome: boolean;
  transactionKind: number | null;
  kind: FamipayTransactionKind;
  detail: FamipayHistoryDetail | null;
};

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const yyyymmdd = (d: Date): string =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const to = get("--to") ?? yyyymmdd(new Date());
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 60);
  const from = get("--from") ?? yyyymmdd(defaultFrom);
  const limitRaw = get("--limit");

  return {
    from,
    to,
    limit: limitRaw ? Number(limitRaw) : null,
    withDetail: !argv.includes("--no-detail"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const session = await ensureFamipaySession();

  console.log("1. 残高を取得中...");
  const balance = await getZandaka(session);
  console.log(
    `   ファミペイ残高 ¥${balance.money.toLocaleString()} / ` +
      `ボーナス ${balance.points.toLocaleString()} pt / ` +
      `あと払い ¥${balance.deferredPayment.toLocaleString()}`,
  );

  console.log(`2. 履歴を取得中（${options.from} 〜 ${options.to}）...`);
  const rows: FamipayHistoryRow[] = [];
  let previousFirstKey: string | null = null;
  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const { rows: pageRows } = await listFamipayHistory(session, options.from, options.to, page);
    if (pageRows.length === 0) break;
    // `KENSU` はそのページの件数で総件数ではない。同じ内容が返り始めたら打ち切る。
    const firstKey = famipayEntryKey(pageRows[0]!);
    if (firstKey === previousFirstKey) break;
    previousFirstKey = firstKey;
    rows.push(...pageRows);
    if (pageRows.length < FAMIPAY_HISTORY_PAGE_SIZE) break;
  }
  console.log(`   ${rows.length} 件`);

  const target = options.limit ? rows.slice(0, options.limit) : rows;
  const entries: FetchedEntry[] = [];
  if (options.withDetail) {
    console.log(`3. 金額内訳を取得中（${target.length} 件）...`);
  }
  for (let i = 0; i < target.length; i++) {
    const row = target[i]!;
    let detail: FamipayHistoryDetail | null = null;
    if (options.withDetail && needsFamipayDetail(row)) {
      process.stdout.write(`   [${i + 1}/${target.length}] ${row.date} ${row.place ?? ""} ... `);
      try {
        detail = await generateHistoryDetail(session, row.uriageNo);
        process.stdout.write(detail ? "OK\n" : "-\n");
      } catch (error) {
        process.stdout.write(`失敗: ${(error as Error).message}\n`);
      }
    }
    const movement = classifyFamipayRow(row, detail);
    entries.push({
      uriageNo: row.uriageNo,
      date: row.date,
      mfDate: toMoneyForwardDate(row.date),
      content: famipayEntryContent(detail ?? row),
      amount: movement?.amount ?? 0,
      isIncome: movement?.isIncome ?? false,
      transactionKind: row.transactionKind,
      kind: movement?.kind ?? "other",
      detail,
    });
  }

  writeOutput("famipay-balance.json", balance);
  writeOutput("famipay-history.json", entries);
  if (options.withDetail)
    writeOutput(
      "famipay-entries.json",
      entries.filter((e) => e.amount > 0),
    );

  printKindHistogram(entries);
  console.log("保存しました: data/famipay-balance.json, data/famipay-history.json");
}

function writeOutput(name: string, data: unknown): void {
  fs.mkdirSync(FAMIPAY_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.resolve(FAMIPAY_DATA_DIR, name), JSON.stringify(data, null, 2));
}

/**
 * 取引区分と符号の分布を出す。金額の向き（収入か支出か）の解釈を
 * 実データで確認するための材料にする。
 */
function printKindHistogram(entries: FetchedEntry[]): void {
  const byKind = new Map<
    string,
    { count: number; income: number; expense: number; codes: Set<number>; sample: string }
  >();
  for (const entry of entries) {
    if (entry.amount === 0) continue;
    const bucket = byKind.get(entry.kind) ?? {
      count: 0,
      income: 0,
      expense: 0,
      codes: new Set<number>(),
      sample: entry.content,
    };
    bucket.count++;
    if (entry.isIncome) bucket.income++;
    else bucket.expense++;
    if (entry.transactionKind !== null) bucket.codes.add(entry.transactionKind);
    byKind.set(entry.kind, bucket);
  }
  if (byKind.size === 0) return;
  console.log("取引の種類ごとの内訳（金額の向きの確認用）:");
  for (const [kind, bucket] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const codes = [...bucket.codes].sort((a, b) => a - b).join(",") || "-";
    console.log(
      `   ${kind} (TORIHIKI_KBN=${codes}): ${bucket.count} 件 (収入 ${bucket.income} / 支出 ${bucket.expense}) 例: ${bucket.sample}`,
    );
  }
}

main().catch((error) => {
  console.error("エラー:", error);
  process.exit(1);
});
