/**
 * MF の銀行「PAYPAYカード」引き落としを PayPayカード口座への振替に変換する。
 *
 * 2 段階方式（クリックだと確認ダイアログが自動 dismiss されて失敗するため）:
 *   フェーズ1: fetch で `GET /cf/update.js?change_type=enable_transfer&id=<id>` を一括実行
 *              → サーバ側で振替になる（DOM は更新されない）
 *   フェーズ2: 月ごとに画面を開き直し、`#change_act_type_<id>` → モーダル
 *              `#modal_change_act_type` で partner_account_id_hash = PayPayカード を選び「設定を保存」
 *
 * 使い方:
 *   npx tsx --env-file=../../.env scripts/paypay-card-payments.ts [--months N] [--limit N] [--apply]
 */
import type { Page } from "playwright";
import {
  parseCashFlowMonthHeader,
  scrapeCashFlowHistory,
} from "../src/scrapers/cash-flow-history.js";
import { getMFPage, openCashFlowAtCurrentMonth } from "./lib/mf-browser.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = has("--apply");
const MONTHS = Number(val("--months") ?? 26);
const LIMIT = val("--limit") ? Number(val("--limit")) : undefined;
const CARD_NAME = "PayPayカード";
const PATTERN = /PAYPAYカ|ペイペイカ|PayPayカード/i;

async function displayedMonth(page: Page): Promise<string | null> {
  const text = await page
    .evaluate(() => {
      const el = document.querySelector(".fc-title, .fc-header-title, .cf-month, h2.fc-title");
      return el ? (el.textContent || "").trim() : null;
    })
    .catch(() => null);
  return text ? parseCashFlowMonthHeader(text) : null;
}

async function goToMonth(page: Page, target: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const cur = await displayedMonth(page);
    if (!cur) return false;
    if (cur === target) return true;
    const sel = cur > target ? "button.fc-button-prev" : "button.fc-button-next";
    const [resp, clicked] = await Promise.all([
      page
        .waitForResponse((r) => r.url().includes("/cf/fetch") && r.status() === 200, {
          timeout: 15000,
        })
        .catch(() => null),
      page
        .locator(sel)
        .first()
        .click()
        .then(() => true)
        .catch(() => false),
    ]);
    void resp;
    if (!clicked) return false;
    await page.waitForTimeout(900);
  }
  return false;
}

type Job = { month: string; id: string; date: string; amount: number; needEnable: boolean };

async function main() {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続（常駐を再利用）" : "新規起動"}`);

  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const cardHash = await page.evaluate((name) => {
    const a = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (e) => (e.textContent || "").trim() === name,
    );
    const m = (a?.getAttribute("href") || "").match(/show_manual\/(.+)$/);
    return m ? m[1]! : null;
  }, CARD_NAME);
  if (!cardHash) throw new Error(`${CARD_NAME} の account hash が取れません`);
  console.log(`account hash(${CARD_NAME}) = ${cardHash}`);

  await openCashFlowAtCurrentMonth(page);
  const results = await scrapeCashFlowHistory(page, MONTHS);

  const jobs: Job[] = [];
  for (const r of results) {
    for (const i of r.data.items) {
      if (!PATTERN.test(i.description) || i.amount <= 0) continue;
      const needEnable = i.type === "expense" && !i.isTransfer;
      const unset = i.isTransfer && i.accountName === "未設定";
      if (needEnable || unset) {
        jobs.push({ month: r.data.month, id: i.mfId, date: i.date, amount: i.amount, needEnable });
      }
    }
  }
  console.log(
    `対象 ${jobs.length} 件（要 enable: ${jobs.filter((j) => j.needEnable).length} / partner のみ: ${jobs.filter((j) => !j.needEnable).length}）`,
  );
  for (const j of jobs)
    console.log(`  ${j.date} ${j.amount} ${j.month} needEnable=${j.needEnable}`);

  if (!APPLY) {
    console.log("\n--dry-run 完了（--apply で実行）");
    return;
  }

  const todo = LIMIT ? jobs.slice(0, LIMIT) : jobs;

  // フェーズ1: fetch で enable_transfer
  const needEnable = todo.filter((j) => j.needEnable);
  if (needEnable.length) {
    console.log(`\nフェーズ1: ${needEnable.length} 件を振替に切り替え（fetch）`);
    for (const [i, j] of needEnable.entries()) {
      const res = await page.evaluate(async (id) => {
        const r = await fetch(`/cf/update.js?change_type=enable_transfer&id=${id}`, {
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        return r.status;
      }, j.id);
      if (i % 5 === 0 || i === needEnable.length - 1)
        console.log(`  ${i + 1}/${needEnable.length} status=${res}`);
      await page.waitForTimeout(250);
    }
  }

  // フェーズ2: 月ごとに移動して partner を設定
  console.log(`\nフェーズ2: 振替先を ${CARD_NAME} に設定`);
  const byMonth = new Map<string, Job[]>();
  for (const j of todo) {
    const list = byMonth.get(j.month) ?? [];
    list.push(j);
    byMonth.set(j.month, list);
  }
  const months = [...byMonth.keys()].sort().reverse();

  await openCashFlowAtCurrentMonth(page);
  let ok = 0;
  let ng = 0;
  let cur: string | null = await displayedMonth(page);
  for (const month of months) {
    if (cur !== month) {
      const moved = await goToMonth(page, month);
      if (!moved) {
        console.log(`  ${month}: 月移動失敗`);
        ng += byMonth.get(month)!.length;
        continue;
      }
      cur = month;
    }
    for (const j of byMonth.get(month)!) {
      process.stdout.write(`  ${j.date} ${j.amount} ... `);
      try {
        const anchor = page.locator(`#change_act_type_${j.id}`);
        if ((await anchor.count()) === 0) {
          console.log("振替先リンクが無い（enable 失敗の可能性）");
          ng++;
          continue;
        }
        await anchor.click();
        await page.waitForTimeout(1100);
        await page.selectOption(
          '#modal_change_act_type select[name="user_asset_act[partner_account_id_hash]"]',
          cardHash,
        );
        await page.click('#modal_change_act_type input[name="commit"]');
        await page.waitForTimeout(1600);
        const stillOpen = await page.evaluate(
          () => document.querySelector("#modal_change_act_type")?.classList.contains("in") ?? false,
        );
        if (stillOpen) {
          console.log("モーダルが閉じない");
          ng++;
        } else {
          ok++;
          console.log("OK");
        }
      } catch (e) {
        console.log(`エラー: ${(e as Error).message}`);
        ng++;
      }
    }
  }
  console.log(`\n完了: OK=${ok} NG=${ng}（常駐ブラウザはそのまま）`);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
