/**
 * ファミペイの残高・利用履歴を取得して MoneyForward の手動口座へ取り込む。
 *
 * 流れ:
 *   1. セッションを確保（無効ならブラウザを開いて Web ログイン。SMS コードは手入力）
 *   2. `v1/getZandaka` で残高、`listFamipayHistory.jsp` で履歴一覧を取得
 *   3. 明細 1 件ごとに `generateFamipayHistoryDetail.jsp` を叩いて金額内訳を取り、
 *      取引の種類（支払い / チャージ / 返金）で収支を決める
 *   4. MF の手動口座「ファミペイ」へ収支登録し、最後に残高を実際の値へ補正する
 *
 * 明細 API は 1 件 1 リクエストなので、取得結果を `data/famipay-details.json` に
 * 貯めて再利用する（`--refresh-details` で捨てる）。
 *
 * 使い方:
 *   pnpm --filter @mf-dashboard/crawler sync:famipay              # dry-run
 *   pnpm --filter @mf-dashboard/crawler sync:famipay -- --apply   # MF へ登録
 *   tsx --env-file=../../.env scripts/famipay-sync.ts --apply --reset   # 口座を作り直す
 *   tsx --env-file=../../.env scripts/famipay-sync.ts --from 20260101 --to 20260131
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
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
import { getCsrfToken } from "../src/hooks/helpers.js";
import {
  FAMIPAY_DATA_DIR,
  generateHistoryDetail,
  getZandaka,
  listFamipayHistory,
} from "./lib/famipay-api.js";
import { ensureFamipaySession } from "./lib/famipay-login.js";
import {
  createCashFlow,
  deleteManualAccount,
  ensureManualAccount,
  findManualAccountHash,
  resolveSubAccountHash,
  setManualAccountBalance,
} from "./lib/mf-manual.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const syncedPath = path.resolve(projectRoot, "data/famipay-synced-ids.json");
const detailsPath = path.resolve(projectRoot, "data/famipay-details.json");
const ACCOUNT_NAME = "ファミペイ";
const CATEGORY_LABEL = "電子マネー・プリペイド";
const HISTORY_MAX_PAGES = 20;
const DETAIL_INTERVAL_MS = 150;

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const APPLY = has("--apply");
const RESET = has("--reset");
const NO_BALANCE = has("--no-balance");
const REFRESH_DETAILS = has("--refresh-details");
const LIMIT = valueOf("--limit") ? Number(valueOf("--limit")) : undefined;
const BALANCE = valueOf("--balance") ? Number(valueOf("--balance")) : undefined;

type SyncEntry = {
  key: string;
  date: string;
  content: string;
  amount: number;
  isIncome: boolean;
  kind: FamipayTransactionKind;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const yyyymmdd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

function resolveRange(): { from: string; to: string } {
  const to = valueOf("--to") ?? yyyymmdd(new Date());
  if (valueOf("--from")) return { from: valueOf("--from")!, to };
  const days = Number(valueOf("--days") ?? 60);
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { from: yyyymmdd(start), to };
}

function loadJsonMap<T>(file: string): Map<string, T> {
  if (!fs.existsSync(file)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, T>));
  } catch {
    return new Map();
  }
}

function saveDetails(details: Map<string, FamipayHistoryDetail>): void {
  fs.mkdirSync(FAMIPAY_DATA_DIR, { recursive: true });
  fs.writeFileSync(detailsPath, JSON.stringify(Object.fromEntries(details), null, 2));
}

function loadSynced(): Set<string> {
  if (!fs.existsSync(syncedPath)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(syncedPath, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSynced(ids: Set<string>): void {
  fs.writeFileSync(syncedPath, JSON.stringify([...ids].sort(), null, 2));
}

/** 履歴一覧を最終ページまで取り、明細 API で金額内訳を補う。 */
async function collectEntries(
  session: Awaited<ReturnType<typeof ensureFamipaySession>>,
  range: { from: string; to: string },
): Promise<SyncEntry[]> {
  const rows: FamipayHistoryRow[] = [];
  let previousFirstKey: string | null = null;
  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const result = await listFamipayHistory(session, range.from, range.to, page);
    if (result.rows.length === 0) {
      console.log(`  履歴ページ ${page}: 0 件（最終ページ）`);
      break;
    }
    // `KENSU` はそのページの件数で総件数ではない。同じ内容が返り始めたら打ち切る。
    const firstKey = famipayEntryKey(result.rows[0]!);
    if (firstKey === previousFirstKey) {
      console.log(`  履歴ページ ${page}: 同じ内容が返ったため打ち切り`);
      break;
    }
    previousFirstKey = firstKey;
    rows.push(...result.rows);
    console.log(`  履歴ページ ${page}: ${result.rows.length} 件（累計 ${rows.length}）`);
    if (result.rows.length < FAMIPAY_HISTORY_PAGE_SIZE) break;
  }

  const details = REFRESH_DETAILS
    ? new Map<string, FamipayHistoryDetail>()
    : loadJsonMap<FamipayHistoryDetail>(detailsPath);
  const entries: SyncEntry[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const [i, row] of rows.entries()) {
    const key = famipayEntryKey(row);
    let detail = details.get(key) ?? null;

    // 売上明細を持たない行（チャージ・ポイント獲得）は明細 API を叩かない。
    // 叩いても RESULT_CODE=008（該当なし）になるだけ。
    if (!detail && needsFamipayDetail(row)) {
      try {
        detail = await generateHistoryDetail(session, row.uriageNo);
        details.set(key, detail);
        fetched++;
        await new Promise((r) => setTimeout(r, DETAIL_INTERVAL_MS));
      } catch (error) {
        console.log(`  明細取得に失敗: ${row.uriageNo} ${row.date} (${(error as Error).message})`);
      }
    } else if (detail) {
      skipped++;
    }

    const movement = classifyFamipayRow(row, detail);
    if (!movement) continue;
    const date = toMoneyForwardDate(detail?.date || row.date);
    if (!date) {
      console.log(`  日付を解釈できないため除外: ${row.uriageNo} ${row.date}`);
      continue;
    }
    entries.push({
      key,
      date,
      content: famipayEntryContent(detail ?? row),
      amount: movement.amount,
      isIncome: movement.isIncome,
      kind: movement.kind,
    });
    if ((i + 1) % 25 === 0) console.log(`  明細を処理中 ${i + 1}/${rows.length}`);
  }

  saveDetails(details);
  console.log(`  明細 API: 取得 ${fetched} 件 / キャッシュ再利用 ${skipped} 件`);
  return entries;
}

function printEntries(entries: SyncEntry[]): void {
  const byKind = new Map<
    FamipayTransactionKind,
    { count: number; income: number; total: number }
  >();
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind) ?? { count: 0, income: 0, total: 0 };
    bucket.count++;
    if (entry.isIncome) bucket.income++;
    bucket.total += entry.amount;
    byKind.set(entry.kind, bucket);
  }
  for (const [kind, bucket] of byKind) {
    console.log(
      `  ${kind}: ${bucket.count} 件（収入 ${bucket.income} / 支出 ${bucket.count - bucket.income}）合計 ¥${bucket.total.toLocaleString()}`,
    );
  }
  for (const entry of entries.slice(0, 5)) {
    console.log(
      `    ${entry.date} ${entry.isIncome ? "収入" : "支出"} ¥${entry.amount.toLocaleString()} ${entry.content}`,
    );
  }
}

async function importToMF(targets: SyncEntry[], targetBalance?: number): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await createBrowserContext(browser, { useAuthState: true });
  const page = await context.newPage();
  await loginWithAuthState(page, context);

  if (RESET) {
    await deleteManualAccount(page, ACCOUNT_NAME);
    if (fs.existsSync(syncedPath)) fs.rmSync(syncedPath);
  }
  await ensureManualAccount(page, { name: ACCOUNT_NAME, categoryLabel: CATEGORY_LABEL });

  const hash = await findManualAccountHash(page, ACCOUNT_NAME);
  if (!hash) throw new Error(`口座「${ACCOUNT_NAME}」を解決できません`);

  let ok = 0;
  let ng = 0;
  const imported: string[] = [];

  if (targets.length > 0) {
    const sub = await resolveSubAccountHash(page, ACCOUNT_NAME);
    const token = await getCsrfToken(page);
    if (!token) throw new Error("CSRF token not found");

    for (const [i, entry] of targets.entries()) {
      process.stdout.write(
        `[${i + 1}/${targets.length}] ${entry.date} ${entry.isIncome ? "収入" : "支出"} ¥${entry.amount.toLocaleString()} ${entry.content} ... `,
      );
      const res = await createCashFlow(page, token, {
        sub,
        date: entry.date,
        isIncome: entry.isIncome,
        amount: entry.amount,
        content: entry.content,
      });
      if (res.ok) {
        ok++;
        imported.push(entry.key);
        process.stdout.write("OK\n");
      } else {
        ng++;
        process.stdout.write(`NG(${res.status})\n`);
      }
      await page.waitForTimeout(120);
    }
  }

  if (targetBalance !== undefined) {
    await setManualAccountBalance(page, hash, ACCOUNT_NAME, targetBalance);
  }

  await browser.close();

  if (imported.length > 0) {
    const synced = loadSynced();
    for (const key of imported) synced.add(key);
    saveSynced(synced);
  }
  console.log(`\n完了: OK=${ok} NG=${ng}`);
}

async function main(): Promise<void> {
  const range = resolveRange();
  const session = await ensureFamipaySession();

  console.log("1. 残高を取得中...");
  const balance = await getZandaka(session);
  console.log(
    `   残高 ¥${balance.money.toLocaleString()} / ボーナス ${balance.points.toLocaleString()} pt / あと払い ¥${balance.deferredPayment.toLocaleString()}`,
  );

  console.log(`2. 履歴を取得中（${range.from} 〜 ${range.to}）...`);
  const entries = await collectEntries(session, range);
  console.log(`   明細 ${entries.length} 件`);

  const synced = RESET ? new Set<string>() : loadSynced();
  const targets = LIMIT
    ? entries.filter((e) => !synced.has(e.key)).slice(0, LIMIT)
    : entries.filter((e) => !synced.has(e.key));
  console.log(`3. 未取込: ${targets.length} 件 / 取込済: ${entries.length - targets.length} 件`);
  printEntries(targets);

  const targetBalance = NO_BALANCE ? undefined : (BALANCE ?? balance.money);
  if (targetBalance !== undefined) {
    console.log(`4. 残高を ¥${targetBalance.toLocaleString()} に補正予定`);
  }

  if (!APPLY) {
    console.log("\n--dry-run 完了（--apply で登録します）");
    process.exit(0);
  }
  if (targets.length === 0 && targetBalance === undefined) {
    console.log("登録対象がありません");
    process.exit(0);
  }
  await importToMF(targets, targetBalance);
  process.exit(0);
}

main().catch((error) => {
  console.error("エラー:", error);
  process.exit(1);
});
