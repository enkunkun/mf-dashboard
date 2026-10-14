/**
 * モバイルSuica の SF(電子マネー)利用履歴を取得して MoneyForward の手動口座へ取り込む。
 *
 * 流れ:
 *   1. パスキーで JRE ID ログイン（scripts/lib/suica-auth.ts）
 *   2. 「SF利用履歴」を開き、指定日から遡って最大100件ずつ取得（SuicaDisp.aspx）
 *   3. Suicaの明細を MF の手動口座「モバイルSuica」へ収支登録（利用=支出 / チャージ=収入）
 *
 * 使い方:
 *   npx tsx scripts/suica-sync.ts                 # dry-run（取得と表示のみ）
 *   npx tsx scripts/suica-sync.ts --apply         # MFへ登録
 *   npx tsx scripts/suica-sync.ts --apply --pages 10
 *   npx tsx scripts/suica-sync.ts --reset --apply # 口座を作り直して全再取込
 *
 * NOTE: 履歴表示は 5:00〜翌0:50 のみ（この時間外はエラーになる）。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { getCsrfToken } from "../src/hooks/helpers.js";
import {
  parseHistoryCells,
  reconcileEntries,
  toSuicaEntries,
  type SuicaEntry,
} from "../src/scrapers/suica.js";
import { loginWithPasskey } from "./lib/suica-auth.js";
import { getSuicaPage } from "./suica-browser.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const syncedPath = path.resolve(projectRoot, "data/suica-synced-ids.json");
const HISTORY_URL = "https://www.mobilesuica.com/iq/ir/SuicaDisp.aspx";
const ACCOUNT_NAME = "モバイルSuica";
const CATEGORY_LABEL = "電子マネー・プリペイド";
const LOOKBACK_DAYS = 190;

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = has("--apply");
const RESET = has("--reset");
const PAGES = Number(valueOf("--pages") ?? 10);
const LIMIT = valueOf("--limit") ? Number(valueOf("--limit")) : undefined;
const NO_BALANCE = has("--no-balance");
const BALANCE = valueOf("--balance") ? Number(valueOf("--balance")) : undefined;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Suicaの履歴テーブル(8列)のセルを取り出す */
async function scrapeCells(page: Page): Promise<string[][]> {
  return await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    const target = tables
      .map((t) => ({
        t,
        cols: Math.max(
          0,
          ...Array.from(t.querySelectorAll("tr")).map((r) => r.querySelectorAll("th,td").length),
        ),
      }))
      .find((x) => x.cols >= 8 && /入金・利用額/.test(x.t.textContent ?? ""));
    if (!target) return [];
    return Array.from(target.t.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((td) => (td.textContent ?? "").trim()),
    );
  });
}

/** 「指定日から過去へ」検索して履歴を取得する */
async function searchAnchor(
  page: Page,
  year: number,
  month: number,
  day: number,
): Promise<string[][]> {
  await page.selectOption('select[name="specifyYearMonth"]', `${year}/${pad2(month)}`);
  await page.selectOption('select[name="specifyDay"]', pad2(day)).catch(() => {});
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
    page
      .locator('button[name="SEARCH"]')
      .click({ timeout: 10000 })
      .catch(() => {}),
  ]);
  await page.waitForTimeout(2500);
  return await scrapeCells(page);
}

/** ログイン後、「SF利用履歴」ページを開く */
async function openHistory(page: Page): Promise<void> {
  await page.goto("https://www.mobilesuica.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const link = page.locator('a:has-text("SF（電子マネー）利用履歴")').first();
  if ((await link.count()) === 0)
    throw new Error("SF利用履歴リンクが見つかりません（ログイン失敗の可能性）");
  const before = page.url();
  await link.evaluate((el) => (el as HTMLElement).click());
  await page
    .waitForURL(/SuicaDisp\.aspx|SuicaChangeTransfer\.aspx/, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  void before;
  await page.waitForSelector('select[name="specifyYearMonth"]', { timeout: 15000 });
}

/** 直近を遡って取得し、重複を除いた明細と現在残高を返す */
async function fetchEntries(
  page: Page,
): Promise<{ entries: SuicaEntry[]; newestBalance?: number }> {
  const today = await page.evaluate(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  });
  const minDate = new Date(today.year, today.month - 1, today.day);
  minDate.setDate(minDate.getDate() - LOOKBACK_DAYS);

  const all = new Map<string, SuicaEntry>();
  let anchor: { year: number; month: number; day: number } = { ...today };
  let newestBalance: number | undefined;

  // サイトの検索は「指定日以前の直近100件」。100件の境界が同日の途中に来ることがあるため、
  // 上限に達したら同じ日をもう一度検索して同日の取りこぼしを回収する。
  for (let i = 0; i < PAGES * 3; i++) {
    const cells = await searchAnchor(page, anchor.year, anchor.month, anchor.day);
    const rows = parseHistoryCells(cells);
    if (rows.length === 0) break;
    const entries = toSuicaEntries(rows, anchor);
    // サイトは新しい順なので、最初の検索の先頭行の残高が現在残高
    if (newestBalance === undefined && entries.length > 0) newestBalance = entries[0]!.balance;
    let added = 0;
    for (const e of entries) {
      if (!all.has(e.key)) {
        all.set(e.key, e);
        added++;
      }
    }
    const oldest = entries[entries.length - 1]!;
    console.log(
      `  fetch ${i + 1}: ${entries.length}件 (${entries[0]?.date}〜${oldest.date}) 新規${added} 累計${all.size}`,
    );

    const next = new Date(`${oldest.date}T00:00:00`);
    // 上限100件に達していて新規が取れたなら同日を再検索、そうでなければ前日へ
    if (!(rows.length >= 100 && added > 0)) next.setDate(next.getDate() - 1);
    if (next < minDate) break;
    anchor = { year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate() };
  }
  // 取得順は「新しい→古い」なので反転して古い順に並べる（同日の前後関係も保つ）
  const entries = [...all.values()].reverse();
  return { entries, newestBalance };
}

// ---- MoneyForward 側 ----

async function findAccountHash(page: Page, name: string): Promise<string | null> {
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return await page.evaluate((n) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === n,
    );
    const m = (a?.getAttribute("href") || "").match(/show_manual\/(.+)$/);
    return m ? m[1]! : null;
  }, name);
}

async function ensureAccount(page: Page, name: string): Promise<void> {
  if (await findAccountHash(page, name)) {
    console.log(`口座「${name}」は既に存在します`);
    return;
  }
  console.log(`口座「${name}」を作成...`);
  await page.goto("https://moneyforward.com/accounts/new/manual?category_type=MANUAL", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1500);
  await page.selectOption('select[name="new_manual_account[category_id]"]', {
    label: CATEGORY_LABEL,
  });
  await page.waitForTimeout(1200);
  await page.fill('input[name="new_manual_account[name]"]', name);
  const value = await page.$('input[name="new_manual_account[value]"]');
  if (value) await value.fill("0");
  await page.evaluate(() => {
    const input = document.querySelector('input[name="new_manual_account[name]"]');
    input?.closest("form")?.requestSubmit();
  });
  await page.waitForTimeout(3000);
  console.log(
    (await findAccountHash(page, name))
      ? `作成しました: ${name}`
      : `⚠️ 作成を確認できませんでした: ${name}`,
  );
}

async function deleteAccount(page: Page, name: string): Promise<void> {
  const hash = await findAccountHash(page, name);
  if (!hash) return console.log(`削除対象なし: ${name}`);
  const token = await getCsrfToken(page);
  const status = await page.evaluate(
    async ({ token, hash }) => {
      const body = new URLSearchParams();
      body.append("authenticity_token", token || "");
      body.append("_method", "delete");
      body.append("account_id_hash", hash);
      body.append("commit", "削除");
      const res = await fetch("/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return res.status;
    },
    { token, hash },
  );
  console.log(`削除 ${name}: status=${status}`);
}

async function resolveSubHash(page: Page, name: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const hash = await page.evaluate((n) => {
      const s = document.querySelector('select[name="user_asset_act[sub_account_id_hash]"]');
      if (!s) return null;
      const opt = Array.from(s.querySelectorAll("option")).find((o) =>
        (o.textContent || "").trim().startsWith(n),
      );
      return opt?.getAttribute("value") ?? null;
    }, name);
    if (hash) return hash;
    await page.waitForTimeout(3000);
  }
  throw new Error(`sub_account_id_hash を解決できません: ${name}`);
}

/** MFの口座ページに表示されている残高を読む */
async function readAccountBalance(page: Page): Promise<number | null> {
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/残高[：:]?\s*[¥\\]?\s*([\d,]+)/);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

/** MF手動口座の残高を指定値に補正し、反映後の残高が一致するか確認する */
async function adjustBalance(page: Page, hash: string, target: number): Promise<void> {
  const url = `https://moneyforward.com/accounts/show_manual/${hash}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.click("a[href='#modal_rollover']");
  await page.waitForSelector("#rollover_info_value", { state: "visible" });
  await page.fill("#rollover_info_value", String(target));
  await page.dispatchEvent("#rollover_info_value", "change");
  const checked = await page.isChecked("#rollover_info_transaction_flag").catch(() => false);
  if (checked) await page.uncheck("#rollover_info_transaction_flag").catch(() => {});
  await page.click("#rollover_form input[type='submit']");
  await page.waitForTimeout(3000);

  // 反映後の残高を読み直して一致確認
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const shown = await readAccountBalance(page);
  const ok = shown === null || shown === target;
  console.log(
    `残高補正: ${ACCOUNT_NAME} → ¥${target.toLocaleString()}（MF表示 ${
      shown === null ? "不明" : `¥${shown.toLocaleString()}`
    } ${ok ? "一致" : "不一致"}）`,
  );
}

async function importToMF(entries: SuicaEntry[], targetBalance?: number): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await createBrowserContext(browser, { useAuthState: true });
  const page = await context.newPage();
  await loginWithAuthState(page, context);

  if (RESET) {
    await deleteAccount(page, ACCOUNT_NAME);
    if (fs.existsSync(syncedPath)) fs.rmSync(syncedPath);
  }
  await ensureAccount(page, ACCOUNT_NAME);

  // 残高補正のみで明細が無い場合
  if (entries.length === 0) {
    if (targetBalance !== undefined) {
      const hash = await findAccountHash(page, ACCOUNT_NAME);
      if (hash) await adjustBalance(page, hash, targetBalance);
    }
    await browser.close();
    return;
  }

  const sub = await resolveSubHash(page, ACCOUNT_NAME);

  const token = await getCsrfToken(page);
  if (!token) throw new Error("CSRF token not found");

  let ok = 0;
  let ng = 0;
  const imported: string[] = [];
  for (const [i, e] of entries.entries()) {
    process.stdout.write(
      `[${i + 1}/${entries.length}] ${e.date} ${e.isIncome ? "収入" : "支出"} ¥${e.amount} ${e.content} ... `,
    );
    const res = await page.evaluate(
      async ({ token, sub, entry }) => {
        const body = new URLSearchParams();
        body.append("authenticity_token", token);
        body.append("user_asset_act[is_transfer]", "0");
        body.append("user_asset_act[is_income]", entry.isIncome ? "1" : "0");
        body.append("user_asset_act[updated_at]", entry.date);
        body.append("user_asset_act[amount]", String(entry.amount));
        body.append("user_asset_act[sub_account_id_hash]", sub);
        body.append("user_asset_act[large_category_id]", "");
        body.append("user_asset_act[middle_category_id]", "");
        body.append("user_asset_act[content]", entry.content);
        const r = await fetch("/cf/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRF-Token": token,
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
        });
        return { ok: r.ok, status: r.status };
      },
      { token, sub, entry: e },
    );
    if (res.ok) {
      ok++;
      imported.push(e.key);
      process.stdout.write("OK\n");
    } else {
      ng++;
      process.stdout.write(`NG(${res.status})\n`);
    }
    await page.waitForTimeout(120);
  }

  if (targetBalance !== undefined) {
    const hash = await findAccountHash(page, ACCOUNT_NAME);
    if (hash) await adjustBalance(page, hash, targetBalance);
  }

  await browser.close();

  if (imported.length) {
    let synced = new Set<string>();
    if (fs.existsSync(syncedPath)) {
      try {
        synced = new Set(JSON.parse(fs.readFileSync(syncedPath, "utf8")) as string[]);
      } catch {
        /* ignore */
      }
    }
    for (const k of imported) synced.add(k);
    fs.writeFileSync(syncedPath, JSON.stringify([...synced], null, 2));
  }
  console.log(`\n完了: OK=${ok} NG=${ng}`);
}

async function main(): Promise<void> {
  const { page, context, external } = await getSuicaPage();
  const cleanup = async () => {
    if (!external) await context.close().catch(() => {});
  };

  await loginWithPasskey(page, context);
  await openHistory(page);

  console.log("Suica履歴を取得中...");
  const { entries, newestBalance } = await fetchEntries(page);
  console.log(`取得: ${entries.length} 件`);

  let synced = new Set<string>();
  if (!RESET && fs.existsSync(syncedPath)) {
    try {
      synced = new Set(JSON.parse(fs.readFileSync(syncedPath, "utf8")) as string[]);
    } catch {
      /* ignore */
    }
  }
  const targets = entries.filter((e) => !synced.has(e.key));
  const income = targets.filter((e) => e.isIncome).length;
  console.log(`未取込: ${targets.length} 件（支出 ${targets.length - income} / 収入 ${income}）`);
  for (const e of targets.slice(0, 5)) {
    console.log(`  ${e.date} ${e.isIncome ? "収入" : "支出"} ¥${e.amount} ${e.content}`);
  }

  // 取込んだ明細から現在残高を再計算し、Suica表示の残高と突き合わせる
  const rec = reconcileEntries(entries);
  const reconciled = rec.difference === 0;
  console.log(
    `リコンサイル: ${reconciled ? "一致" : "不一致"} 実残高 ¥${rec.actualClosing.toLocaleString()} / 明細からの期待 ¥${rec.expectedClosing.toLocaleString()}${
      reconciled ? "" : `（差異 ¥${rec.difference.toLocaleString()}）`
    }`,
  );
  if (!reconciled) {
    for (const g of rec.gaps.slice(0, 5)) {
      console.log(
        `  乖離 ${g.date} ${g.content} 期待¥${g.expectedBalance.toLocaleString()} 実¥${g.actualBalance.toLocaleString()}`,
      );
    }
    console.log(
      `  （乖離 ${rec.gaps.length} 件 / 開始残高 ¥${rec.openingBalance.toLocaleString()} / 純増減 ¥${rec.net.toLocaleString()}）`,
    );
  }

  // 最新明細の残高＝現在のSuica残高。--balance 指定が優先、--no-balance で補正しない。
  const targetBalance = NO_BALANCE ? undefined : (BALANCE ?? newestBalance);
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
