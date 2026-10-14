/** PayPayカード口座の残高推移・残高修正の履歴を確認する（読み取りのみ）。 */
import { getMFPage } from "./lib/mf-browser.js";

async function main() {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続" : "新規起動"}`);

  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const href = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === "PayPayカード",
    );
    return a?.getAttribute("href") ?? null;
  });
  if (!href) throw new Error("not found");

  await page.goto(`https://moneyforward.com${href}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const body = document.body.innerText || "";
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const idx = lines.findIndex((l) => l.includes("残高推移"));
    return {
      balance: (body.match(/残高：[−-]?[-0-9,]+円/) || ["(不明)"])[0],
      around: lines.slice(Math.max(0, idx - 3), idx + 25),
      allLinks: Array.from(document.querySelectorAll("a"))
        .map((a) => ({ t: (a.textContent || "").trim().slice(0, 20), h: a.getAttribute("href") }))
        .filter((x) => /残高|推移|修正|履歴/.test(x.t) || /history|rollover/.test(x.h || "")),
    };
  });
  console.log(JSON.stringify(info, null, 2));
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
