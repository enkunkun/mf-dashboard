import { scrapeCashFlowHistory } from "../src/scrapers/cash-flow-history.js";
/** PayPay / PayPayカード の状態を MF から確認する（読み取りのみ・常駐ブラウザを再利用）。 */
import { getMFPage, openCashFlowAtCurrentMonth } from "./lib/mf-browser.js";

const monthArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}$/.test(a));
const months = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);

async function main() {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続" : "新規起動"}`);

  await openCashFlowAtCurrentMonth(page);
  const results = await scrapeCashFlowHistory(
    page,
    months,
    monthArg ? { targetMonth: monthArg } : {},
  );
  const items = results.flatMap((r) => r.data.items);
  const hits = items.filter((i) => /PAYPAYカ|ペイペイカ/i.test(i.description));
  console.log(`\n=== 銀行の PAYPAYカード引き落とし（${months}か月）===`);
  for (const h of hits) {
    console.log(
      `  ${h.date} type=${h.type} transfer=${h.isTransfer} ${h.amount} acct=${h.accountName ?? "-"} target=${h.transferTarget ?? "-"}`,
    );
  }
  const transfers = items.filter(
    (i) => i.isTransfer && i.accountName === "未設定" && /PAYPAYカ/i.test(i.description),
  );
  console.log(`未設定のまま: ${transfers.length} 件`);

  // 残高
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const links = await page.$$eval('a[href*="show_manual"]', (els) =>
    els.map((e) => ({ href: e.getAttribute("href") || "", text: (e.textContent || "").trim() })),
  );
  for (const name of ["PayPay", "PayPayカード"]) {
    const t = links.find((l) => l.text === name);
    if (!t) {
      console.log(`${name}: (なし)`);
      continue;
    }
    await page.goto(`https://moneyforward.com${t.href}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const bal = await page.evaluate(() => {
      const m = (document.body.innerText || "").match(/残高：[−-]?[-0-9,]+円/);
      return m ? m[0] : "(不明)";
    });
    console.log(`${name}: ${bal}`);
  }
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
