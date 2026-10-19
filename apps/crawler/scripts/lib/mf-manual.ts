/**
 * MoneyForward の手動口座を操作する共通処理。
 *
 * suica-sync.ts / paypay-import.ts が個別に持っていた「口座の作成・削除・
 * sub_account_id_hash の解決・残高補正・/cf/create での明細登録」を共有化したもの。
 */
import type { Page } from "playwright";
import { getCsrfToken } from "../../src/hooks/helpers.js";

const ACCOUNTS_URL = "https://moneyforward.com/accounts";
const CF_URL = "https://moneyforward.com/cf";

export type ManualAccount = {
  name: string;
  categoryLabel: string;
};

/** 手動口座の account_id_hash を返す（無ければ null）。 */
export async function findManualAccountHash(page: Page, name: string): Promise<string | null> {
  await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return await page.evaluate((n) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === n,
    );
    const m = (a?.getAttribute("href") || "").match(/show_manual\/(.+)$/);
    return m ? m[1]! : null;
  }, name);
}

/** 手動口座が無ければ作る。 */
export async function ensureManualAccount(
  page: Page,
  { name, categoryLabel }: ManualAccount,
): Promise<void> {
  if (await findManualAccountHash(page, name)) {
    console.log(`口座「${name}」は既に存在します`);
    return;
  }
  console.log(`口座「${name}」を作成...`);
  await page.goto("https://moneyforward.com/accounts/new/manual?category_type=MANUAL", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1500);
  await page.selectOption('select[name="new_manual_account[category_id]"]', {
    label: categoryLabel,
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
    (await findManualAccountHash(page, name))
      ? `作成しました: ${name}`
      : `⚠️ 作成を確認できませんでした: ${name}`,
  );
}

/** 手動口座を削除する。 */
export async function deleteManualAccount(page: Page, name: string): Promise<void> {
  const hash = await findManualAccountHash(page, name);
  if (!hash) {
    console.log(`削除対象なし: ${name}`);
    return;
  }
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

/** /cf の明細登録フォームから sub_account_id_hash を解決する。 */
export async function resolveSubAccountHash(page: Page, name: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.goto(CF_URL, { waitUntil: "domcontentloaded" });
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

/** 手動口座の残高を指定値に補正し、反映後の残高が一致するか確認する。 */
export async function setManualAccountBalance(
  page: Page,
  hash: string,
  name: string,
  target: number,
): Promise<void> {
  const url = `${ACCOUNTS_URL}/show_manual/${hash}`;
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

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/残高[：:]?\s*[¥\\]?\s*([\d,]+)/);
  const shown = m ? Number(m[1]!.replace(/,/g, "")) : null;
  const ok = shown === null || shown === target;
  console.log(
    `残高補正: ${name} → ¥${target.toLocaleString()}（MF表示 ${
      shown === null ? "不明" : `¥${shown.toLocaleString()}`
    } ${ok ? "一致" : "不一致"}）`,
  );
}

/** 明細を 1 件登録する。/cf/create を叩く。 */
export async function createCashFlow(
  page: Page,
  token: string,
  flow: { sub: string; date: string; isIncome: boolean; amount: number; content: string },
): Promise<{ ok: boolean; status: number }> {
  return await page.evaluate(
    async ({ token, flow }) => {
      const body = new URLSearchParams();
      body.append("authenticity_token", token);
      body.append("user_asset_act[is_transfer]", "0");
      body.append("user_asset_act[is_income]", flow.isIncome ? "1" : "0");
      body.append("user_asset_act[updated_at]", flow.date);
      body.append("user_asset_act[amount]", String(flow.amount));
      body.append("user_asset_act[sub_account_id_hash]", flow.sub);
      body.append("user_asset_act[large_category_id]", "");
      body.append("user_asset_act[middle_category_id]", "");
      body.append("user_asset_act[content]", flow.content);
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
    { token, flow },
  );
}
