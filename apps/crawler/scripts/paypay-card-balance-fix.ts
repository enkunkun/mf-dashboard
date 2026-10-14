/**
 * PayPayカード口座の残高を「正しい未払い額」に合わせる。
 *
 * 背景:
 *   カード利用データは PayPay CSV の期間しか無く、それより前の未払い残高が帳簿に存在しない。
 *   そのため手動口座の残高が実際の未払い額からずれる。
 *   MF の「残高修正（rollover）」で、指定日の「修正後の残高」を記録してずれを吸収する。
 *
 * 使い方:
 *   npx tsx --env-file=../../.env scripts/paypay-card-balance-fix.ts            # モーダル項目の確認のみ
 *   npx tsx --env-file=../../.env scripts/paypay-card-balance-fix.ts --apply --value <修正後の残高> [--date YYYY/MM/DD]
 */
import { getMFPage } from "./lib/mf-browser.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const valOf = (f: string, d: number) => {
  const i = args.indexOf(f);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const CARD_NAME = (() => {
  const i = args.indexOf("--account");
  return i >= 0 ? args[i + 1]! : "PayPayカード";
})();
const VALUE = valOf("--value", Number.NaN);
const DATE = (() => {
  const i = args.indexOf("--date");
  return i >= 0 ? args[i + 1]! : "2024/10/12";
})();

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
  }, CARD_NAME);
  if (!href) throw new Error(`${CARD_NAME} が見つかりません`);
  console.log(`account: ${href}`);

  await page.goto(`https://moneyforward.com${href}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const before = await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/残高：[−-]?[-0-9,]+円/);
    return m ? m[0] : "(不明)";
  });
  console.log(`before: ${before}`);

  // 残高修正モーダルを開く
  await page.click("a[href='#modal_rollover']");
  await page.waitForSelector("#rollover_info_value", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(800);

  const fields = await page.evaluate(() => {
    const v = document.querySelector("#rollover_info_value");
    const form = v ? v.closest("form") : null;
    if (!form) return { error: "form not found" };
    return {
      action: form.getAttribute("action"),
      method: form.getAttribute("method"),
      fields: Array.from(form.querySelectorAll("input,select,textarea,button")).map((n) => ({
        tag: n.tagName,
        id: n.getAttribute("id"),
        name: n.getAttribute("name"),
        type: n.getAttribute("type"),
        value: ((n as HTMLInputElement).value || "").slice(0, 30),
        visible: (n as HTMLElement).offsetParent !== null,
      })),
    };
  });
  console.log("rollover form:", JSON.stringify(fields, null, 2));

  if (APPLY && !Number.isInteger(VALUE)) {
    throw new Error("--apply には --value <修正後の残高>（整数）を指定してください");
  }
  if (!APPLY) {
    console.log("\n（--apply で実行します。モーダルは開いたままです）");
    return;
  }

  await page.fill("#rollover_info_value", String(VALUE));
  await page.dispatchEvent("#rollover_info_value", "change");

  // 日付（残高修正を適用する日）
  const dateSet = await page
    .fill("#rollover_info_updated_at", DATE)
    .then(() => true)
    .catch(() => false);
  if (dateSet) {
    await page.dispatchEvent("#rollover_info_updated_at", "change");
    console.log(`date set: ${DATE}`);
  } else {
    console.log("⚠️ 日付フィールドを設定できません（今日の日付になります）");
  }

  // 「不明金として記帳する」チェックを外す
  const flag = await page.$("#rollover_info_transaction_flag");
  if (flag) {
    const checked = await flag.isChecked().catch(() => false);
    if (checked) {
      await flag.uncheck();
      console.log("不明金として記帳する: off");
    }
  }

  const submitted = await page.evaluate(() => {
    const v = document.querySelector("#rollover_info_value") as HTMLInputElement | null;
    const form = v ? (v.closest("form") as HTMLFormElement | null) : null;
    if (!form) return false;
    form.requestSubmit();
    return true;
  });
  if (!submitted) throw new Error("rollover form not found");
  await page.waitForTimeout(4000);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/残高：[−-]?[-0-9,]+円/);
    return m ? m[0] : "(不明)";
  });
  console.log(`after: ${after}`);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
