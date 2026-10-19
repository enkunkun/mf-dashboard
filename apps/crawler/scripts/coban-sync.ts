/**
 * pixivcoban の残高・入出金履歴を MoneyForward の手動口座「pixivcoban」へ取り込む。
 *
 * 流れ:
 *   1. pixiv アカウントで coban にログイン（scripts/lib/coban-auth.ts）
 *   2. /api/v1/balance と /api/v1/history/{YYYY-MM} を取得
 *   3. コバン購入/付与=収入、コバン利用/失効=支出 として /cf/create で登録
 *   4. 口座残高を coban の表示残高へ補正
 *
 * 重複対策:
 *   - 明細は (date_time|type|amount|detail) のキーで `data/coban-synced-ids.json` に記録し、
 *     取り込み済みは再登録しない。窓を重ねて再取得しても二重登録しない。
 *   - 残高補正は上書きなので、何度実行しても残高は一致する。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/coban-sync.ts                  # dry-run
 *   tsx --env-file=../../.env scripts/coban-sync.ts --apply          # MF へ登録
 *   tsx --env-file=../../.env scripts/coban-sync.ts --apply --months 3
 *   tsx --env-file=../../.env scripts/coban-sync.ts --reset --apply  # 口座を作り直して全再取込
 *   tsx --env-file=../../.env scripts/coban-sync.ts --no-balance --apply
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { getCsrfToken } from "../src/hooks/helpers.js";
import { reconcileCoban, toCobanEntries, type CobanEntry } from "../src/scrapers/coban.js";
import { getCobanPage } from "./coban-browser.js";
import { fetchBalance, fetchHistories, fetchHistoryStartedAt } from "./lib/coban-api.js";
import { loginWithPixiv } from "./lib/coban-auth.js";
import {
  createCashFlow,
  deleteManualAccount,
  ensureManualAccount,
  findManualAccountHash,
  resolveSubAccountHash,
  setManualAccountBalance,
} from "./lib/mf-manual.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const syncedPath = path.resolve(projectRoot, "data/coban-synced-ids.json");
const ACCOUNT_NAME = "pixivcoban";
const CATEGORY_LABEL = "電子マネー・プリペイド";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = has("--apply");
const RESET = has("--reset");
const NO_BALANCE = has("--no-balance");
const LIMIT = valueOf("--limit") ? Number(valueOf("--limit")) : undefined;
const MONTHS = valueOf("--months") ? Number(valueOf("--months")) : undefined;
const BALANCE = valueOf("--balance") ? Number(valueOf("--balance")) : undefined;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM */
function monthOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function loadSynced(): Set<string> {
  if (!fs.existsSync(syncedPath)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(syncedPath, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSynced(synced: Set<string>): void {
  fs.writeFileSync(syncedPath, JSON.stringify([...synced], null, 2));
}

/** 取得範囲を決める。既定は履歴の開始月〜今月。--months N で直近 N か月に絞る。 */
function resolveRange(startMonth: string): { from: string; to: string } {
  const now = new Date();
  const to = monthOf(now);
  let from = startMonth;
  if (MONTHS) {
    const d = new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1), 1);
    const window = monthOf(d);
    if (window > from) from = window;
  }
  return { from, to };
}

async function importToMF(entries: CobanEntry[], targetBalance: number | undefined): Promise<void> {
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await createBrowserContext(browser, { useAuthState: true });
  const page = await context.newPage();
  await loginWithAuthState(page, context);

  if (RESET) {
    await deleteManualAccount(page, ACCOUNT_NAME);
    if (fs.existsSync(syncedPath)) fs.rmSync(syncedPath);
  }
  await ensureManualAccount(page, { name: ACCOUNT_NAME, categoryLabel: CATEGORY_LABEL });

  // 残高補正のみで明細が無い場合
  if (entries.length === 0) {
    if (targetBalance !== undefined) {
      const hash = await findManualAccountHash(page, ACCOUNT_NAME);
      if (hash) await setManualAccountBalance(page, hash, ACCOUNT_NAME, targetBalance);
    }
    await browser.close();
    return;
  }

  const sub = await resolveSubAccountHash(page, ACCOUNT_NAME);
  const token = await getCsrfToken(page);
  if (!token) throw new Error("CSRF token not found");

  // 途中で落ちても取込済みを失わないよう、1 件ごとに同期状態を書き出す
  const synced = loadSynced();
  let ok = 0;
  let ng = 0;
  for (const [i, e] of entries.entries()) {
    process.stdout.write(
      `[${i + 1}/${entries.length}] ${e.date} ${e.isIncome ? "収入" : "支出"} ¥${e.amount.toLocaleString()} ${e.content} ... `,
    );
    const res = await createCashFlow(page, token, {
      sub,
      date: e.date,
      isIncome: e.isIncome,
      amount: e.amount,
      content: e.content,
    });
    if (res.ok) {
      ok++;
      synced.add(e.key);
      saveSynced(synced);
      process.stdout.write("OK\n");
    } else {
      ng++;
      process.stdout.write(`NG(${res.status})\n`);
    }
    await page.waitForTimeout(120);
  }

  if (targetBalance !== undefined) {
    const hash = await findManualAccountHash(page, ACCOUNT_NAME);
    if (hash) await setManualAccountBalance(page, hash, ACCOUNT_NAME, targetBalance);
  }

  await browser.close();
  console.log(`\n完了: OK=${ok} NG=${ng}`);
}

async function main(): Promise<void> {
  const { page, context, external } = await getCobanPage();
  const cleanup = async () => {
    if (!external) await context.close().catch(() => {});
  };

  await loginWithPixiv(page);

  const balance = await fetchBalance(page);
  const startedAt = await fetchHistoryStartedAt(page);
  const { from, to } = resolveRange(startedAt.slice(0, 7));
  console.log(
    `pixivcoban 残高 ¥${balance.balance.toLocaleString()}（有償 ¥${balance.paid_coin.toLocaleString()} / 無償 ¥${balance.free_coin.toLocaleString()}）`,
  );
  console.log(`履歴取得: ${from} 〜 ${to}`);

  const histories = await fetchHistories(page, from, to);
  // 同じ明細キーの重複を排除し、古い順に整える
  const deduped = new Map<string, CobanEntry>();
  for (const e of toCobanEntries(histories)) if (!deduped.has(e.key)) deduped.set(e.key, e);
  const entries = [...deduped.values()];

  const synced = RESET ? new Set<string>() : loadSynced();
  const targets = entries.filter((e) => !synced.has(e.key));
  const income = targets.filter((e) => e.isIncome).length;
  console.log(
    `取得: ${entries.length} 件 / 未取込: ${targets.length} 件（収入 ${income} / 支出 ${targets.length - income}）`,
  );
  for (const e of targets.slice(0, 8)) {
    console.log(
      `  ${e.date} ${e.isIncome ? "収入" : "支出"} ¥${e.amount.toLocaleString()} ${e.content}`,
    );
  }
  if (targets.length > 8) console.log(`  ... 他 ${targets.length - 8} 件`);

  const rec = reconcileCoban(entries, balance.balance);
  console.log(
    `リコンサイル: ${rec.difference === 0 ? "一致" : "不一致"}（明細の純増減 ¥${rec.net.toLocaleString()} / 実残高 ¥${rec.actualBalance.toLocaleString()}${
      rec.difference === 0 ? "" : ` / 差異 ¥${rec.difference.toLocaleString()}`
    }`,
  );
  if (rec.difference !== 0) {
    console.log("  ※ coban の履歴は欠落があり得るため、口座残高は表示残高を正とします");
  }

  const targetBalance = NO_BALANCE ? undefined : (BALANCE ?? balance.balance);
  if (targetBalance !== undefined) console.log(`最終残高: ¥${targetBalance.toLocaleString()}`);

  if (!APPLY) {
    console.log("\n--dry-run 完了（--apply で登録します）");
    await cleanup();
    process.exit(0);
  }

  const toImport = LIMIT ? targets.slice(0, LIMIT) : targets;
  if (toImport.length === 0 && targetBalance === undefined) {
    console.log("登録対象がありません");
    await cleanup();
    process.exit(0);
  }
  await importToMF(toImport, targetBalance);
  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
