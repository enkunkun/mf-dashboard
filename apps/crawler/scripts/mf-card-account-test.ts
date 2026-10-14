/**
 * 「カード区分の手動口座」が MF 家計簿 /cf に記帳できるか（= 負債として使えるか）を検証する。
 * テスト口座を作成 → /cf の sub-account 一覧と /accounts の区分（資産/負債）を確認 → 削除する。
 *
 * 使い方: npx tsx --env-file=../../.env scripts/mf-card-account-test.ts
 */
import type { Page } from "playwright";
import { getCsrfToken } from "../src/hooks/helpers.js";
import { getMFPage } from "./lib/mf-browser.js";

const NAME = "テストカード";

async function createManual(page: Page, name: string, categoryLabel: string): Promise<void> {
  // 既に存在すればスキップ
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const exists = await page.evaluate(
    (n) =>
      Array.from(document.querySelectorAll('a[href*="show_manual"]')).some(
        (e) => (e.textContent || "").trim() === n,
      ),
    name,
  );
  if (exists) {
    console.log(`  既に存在: ${name}`);
    return;
  }
  await page.goto("https://moneyforward.com/accounts/new/manual?category_type=MANUAL", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2000);
  await page.selectOption('select[name="new_manual_account[category_id]"]', {
    label: categoryLabel,
  });
  await page.waitForTimeout(1800);
  await page.fill('input[name="new_manual_account[name]"]', name);
  const valueInput = await page.$('input[name="new_manual_account[value]"]');
  if (valueInput) await valueInput.fill("0");
  const action = await page.evaluate(() => {
    const input = document.querySelector('input[name="new_manual_account[name]"]');
    const f = input ? (input.closest("form") as HTMLFormElement | null) : null;
    if (!f) return null;
    const a = f.getAttribute("action");
    f.requestSubmit();
    return a;
  });
  console.log(`  作成 submit: ${action}`);
  await page.waitForTimeout(4000);
}

async function deleteManual(page: Page, name: string): Promise<void> {
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const hash = await page.evaluate((n) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === n,
    );
    const m = (a?.getAttribute("href") || "").match(/show_manual\/(.+)$/);
    return m ? m[1]! : null;
  }, name);
  if (!hash) {
    console.log(`  削除対象なし: ${name}`);
    return;
  }
  const csrf = await getCsrfToken(page);
  const status = await page.evaluate(
    async ({ token, hash }) => {
      const body = new URLSearchParams();
      body.append("authenticity_token", token || "");
      body.append("_method", "delete");
      body.append("account_id_hash", hash);
      body.append("commit", "削除");
      const r = await fetch("/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return r.status;
    },
    { token: csrf, hash },
  );
  console.log(`  削除 status=${status}`);
}

async function main() {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続" : "新規起動"}`);

  console.log(`1) 「${NAME}」を カード 区分で作成`);
  await createManual(page, NAME, "カード");

  console.log("2) /cf の sub-account 一覧に出るか");
  await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const opts = await page.evaluate(() => {
    const s = document.querySelector('select[name="user_asset_act[sub_account_id_hash]"]');
    return s
      ? Array.from(s.querySelectorAll("option")).map((o) =>
          (o.textContent || "").trim().slice(0, 24),
        )
      : ["(select なし)"];
  });
  console.log("  options:", JSON.stringify(opts));
  console.log(
    `  → ${opts.some((o) => o.startsWith(NAME)) ? "✅ 出る（記帳できる）" : "❌ 出ない（記帳できない）"}`,
  );

  console.log("3) /accounts の区分（資産/負債）");
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const section = await page.evaluate((n) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === n,
    );
    if (!a) return null;
    // 上位のテーブル/セクションの見出しテキストを拾う
    let node: Element | null = a;
    for (let i = 0; i < 14 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const t = node.textContent || "";
      if (/負債/.test(t) && t.length < 4000) return "負債";
      if (/資産/.test(t) && t.length < 4000) return "資産";
    }
    return "不明";
  }, NAME);
  console.log(`  → ${section}`);

  console.log("4) 後始末（テスト口座を削除）");
  await deleteManual(page, NAME);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
