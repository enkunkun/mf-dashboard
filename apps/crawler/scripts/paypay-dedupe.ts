/**
 * PayPay 取込が MF の手動口座「PayPay」「PayPayカード」に二重登録した明細を削除する。
 * 各明細のうち先に登録された行を残し、後から入った行を消す。
 * PayPay CSV に同じ日付・金額・内容の取引が複数あれば、その件数ぶん残す。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/paypay-dedupe.ts --month 2026-10           # dry-run
 *   tsx --env-file=../../.env scripts/paypay-dedupe.ts --month 2026-10 --apply
 */
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { getCsrfToken } from "../src/hooks/helpers.js";
import { findPayPayDuplicates, payPayCsvKey, type DedupeRow } from "../src/paypay-dedupe.js";
import { extractCashFlowFromPage, goToCashFlowMonth } from "../src/scrapers/cash-flow-history.js";
import { loadEntries } from "./paypay-import.js";

function loadCsvCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    for (const e of loadEntries()) {
      const key = payPayCsvKey(e.date, e.amount, e.content || e.kind);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } catch (err) {
    console.log(`PayPay CSV を読めないため、各明細を 1 件だけ残す: ${String(err)}`);
  }
  return counts;
}

async function findDuplicates(
  page: Page,
  month: string,
  csvCounts: Map<string, number>,
): Promise<DedupeRow[]> {
  await goToCashFlowMonth(page, month);
  const { items } = await extractCashFlowFromPage(page);
  return findPayPayDuplicates(items, csvCounts);
}

async function deleteRow(page: Page, mfId: string, token: string): Promise<string> {
  return await page.evaluate(
    async ({ mfId, token }) => {
      const link = document.querySelector(`#js-transaction-${mfId} td.delete a`);
      const href = link?.getAttribute("href");
      if (!href) return "削除リンクなし";
      const r = await fetch(href, {
        method: "DELETE",
        headers: { "X-CSRF-Token": token, "X-Requested-With": "XMLHttpRequest" },
      });
      return `status=${r.status}`;
    },
    { mfId, token },
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const monthIndex = args.indexOf("--month");
  const month = monthIndex >= 0 ? args[monthIndex + 1] : undefined;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("--month YYYY-MM を指定する");
  }

  const csvCounts = loadCsvCounts();
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  try {
    const context = await createBrowserContext(browser, { useAuthState: true });
    const page = await context.newPage();
    await loginWithAuthState(page, context);

    const duplicates = await findDuplicates(page, month, csvCounts);
    console.log(`${month} の削除候補 ${duplicates.length} 件`);
    for (const d of duplicates) {
      const account = d.accountName ?? `→${d.transferTarget}`;
      console.log(`  ${d.mfId} ${d.date} ${d.type} ${account} ${d.amount} ${d.description}`);
    }
    if (!apply || duplicates.length === 0) {
      if (!apply) console.log("\ndry-run 完了（--apply を付けると削除する）");
      return;
    }

    const token = await getCsrfToken(page);
    if (!token) throw new Error("CSRF token not found");
    for (const d of duplicates) {
      console.log(`削除 ${d.mfId}: ${await deleteRow(page, d.mfId, token)}`);
      await page.waitForTimeout(300);
    }

    const remaining = await findDuplicates(page, month, csvCounts);
    console.log(`\n削除後に残った重複 ${remaining.length} 件`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
