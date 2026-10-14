import { getCsrfToken } from "../src/hooks/helpers.js";
/**
 * 残高修正（rollover）後に作成した取引が残高に反映されるかを検証する。
 * PayPay 口座に 1 円のテスト取引を作成 → 残高を見る → 削除する。
 *
 * 使い方: npx tsx --env-file=../../.env scripts/paypay-balance-rollover-test.ts
 */
import { getMFPage } from "./lib/mf-browser.js";

const ACCOUNT = "PayPay";
const CONTENT = "残高テスト（自動削除）";

async function readBalance(page: import("playwright").Page, href: string): Promise<string> {
  await page.goto(`https://moneyforward.com${href}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const m = await page.evaluate(() => {
    const t = (document.body.innerText || "").match(/残高：[−-]?[-0-9,]+円/);
    return t ? t[0] : "(不明)";
  });
  return m;
}

async function main() {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続" : "新規起動"}`);

  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const href = await page.evaluate((name) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === name,
    );
    return a?.getAttribute("href") ?? null;
  }, ACCOUNT);
  if (!href) throw new Error(`${ACCOUNT} が見つかりません`);

  const before = await readBalance(page, href);
  console.log(`1) 残高(前): ${before}`);

  // sub hash を /cf から取得
  await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const sub = await page.evaluate((name) => {
    const s = document.querySelector('select[name="user_asset_act[sub_account_id_hash]"]');
    if (!s) return null;
    const hit = Array.from(s.querySelectorAll("option")).find((o) =>
      (o.textContent || "").trim().startsWith(name),
    );
    return hit ? hit.getAttribute("value") : null;
  }, ACCOUNT);
  if (!sub) throw new Error("sub hash が取れません");

  const csrf = await getCsrfToken(page);
  const today = new Date();
  const ymd = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  const created = await page.evaluate(
    async ({ token, sub, ymd, content }) => {
      const body = new URLSearchParams();
      body.append("authenticity_token", token || "");
      body.append("user_asset_act[is_transfer]", "0");
      body.append("user_asset_act[is_income]", "0");
      body.append("user_asset_act[updated_at]", ymd);
      body.append("user_asset_act[amount]", "1");
      body.append("user_asset_act[sub_account_id_hash]", sub);
      body.append("user_asset_act[large_category_id]", "");
      body.append("user_asset_act[middle_category_id]", "");
      body.append("user_asset_act[content]", content);
      const r = await fetch("/cf/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": token || "",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
      });
      return r.status;
    },
    { token: csrf, sub, ymd, content: CONTENT },
  );
  console.log(`2) テスト取引(1円 支出)作成: status=${created}`);

  const after = await readBalance(page, href);
  console.log(`3) 残高(後): ${after}  ← 取引が反映されていれば 1円 減る`);

  // テスト取引を探して削除
  await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const found = await page.evaluate((content) => {
    const rows = Array.from(document.querySelectorAll("#cf-detail-table tbody tr"));
    for (const row of rows) {
      if ((row.textContent || "").includes(content)) {
        const idInput = row.querySelector(
          'input[name="user_asset_act[id]"]',
        ) as HTMLInputElement | null;
        const del = row.querySelector("td.delete a") as HTMLAnchorElement | null;
        return { id: idInput?.value ?? null, deleteHref: del?.getAttribute("href") ?? null };
      }
    }
    return null;
  }, CONTENT);
  console.log(`4) テスト取引: ${JSON.stringify(found)}`);

  if (found?.deleteHref) {
    const status = await page.evaluate(
      async ({ url, token }) => {
        const r = await fetch(url, {
          method: "DELETE",
          headers: { "X-CSRF-Token": token || "", "X-Requested-With": "XMLHttpRequest" },
        });
        return r.status;
      },
      { url: found.deleteHref, token: await getCsrfToken(page) },
    );
    console.log(`5) 削除: status=${status}`);
  }

  const final = await readBalance(page, href);
  console.log(`6) 残高(最終): ${final}  ← 1) と同じなら元に戻っている`);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
