/**
 * ファミペイのチャージを整える。
 *
 * 1. 「クレジットカードでチャージ」が収入のままなら、カード → ファミペイの振替に直す
 * 2. カード側の同額支出（「ＦａｍｉＰａｙチャージ」）を計算対象外にする
 *
 * 1 は 2 段階方式（`paypay-card-payments.ts` と同じ）:
 *   a. `GET /cf/update.js?change_type=enable_transfer&id=<id>` で振替に切り替え
 *   b. 月を開き直し、`#change_act_type_<id>` → モーダルで振替元を選んで保存
 * 2 は `/cf/update` の `is_target=0`。カテゴリと残高はそのまま残る。
 *
 *   pnpm --filter @mf-dashboard/crawler famipay:fix-charges            # dry-run
 *   pnpm --filter @mf-dashboard/crawler famipay:fix-charges --apply
 */
import type { CashFlowItem } from "@mf-dashboard/db/types";
import type { Page } from "playwright";
import {
  buildCategoryUpdateBody,
  getCsrfToken,
  putCfUpdate,
  readTransactionRowFields,
} from "../src/hooks/helpers.js";
import { goToCashFlowMonth, scrapeCashFlowHistory } from "../src/scrapers/cash-flow-history.js";
import { getMFPage, openCashFlowAtCurrentMonth } from "./lib/mf-browser.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const MONTHS = (() => {
  const index = args.indexOf("--months");
  return index >= 0 ? Number(args[index + 1]) : 18;
})();
const ACCOUNT_NAME = "ファミペイ";
const DEFAULT_PARTNER = "PayPayカード";

type Job = {
  month: string;
  item: CashFlowItem;
  partner: string;
  card: CashFlowItem | null;
};

async function resolveAccountHash(page: Page, name: string): Promise<string> {
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const hash = await page.evaluate((accountName) => {
    const anchor = Array.from(document.querySelectorAll('a[href*="show_manual"]')).find(
      (element) => (element.textContent ?? "").trim() === accountName,
    );
    const match = (anchor?.getAttribute("href") ?? "").match(/show_manual\/(.+)$/);
    return match ? match[1]! : null;
  }, name);
  if (!hash) throw new Error(`${name} の account hash が取れません`);
  return hash;
}

/** 支出に倒れているチャージ行を収入に戻す（過去の試行の巻き戻し用） */
async function restoreIncome(page: Page, job: Job): Promise<void> {
  const csrf = await getCsrfToken(page);
  if (!csrf) throw new Error("CSRF token がありません");
  const fields = await readTransactionRowFields(page, job.item.mfId);
  if (!fields) throw new Error(`行 ${job.item.mfId} が見つかりません`);
  const body = new URLSearchParams(fields);
  body.set("user_asset_act[is_income]", "1");
  body.set("user_asset_act[is_target]", "1");
  body.set("user_asset_act[amount]", String(job.item.amount));
  body.set("user_asset_act[large_category_id]", "0");
  body.set("user_asset_act[middle_category_id]", "0");
  const result = await putCfUpdate(page, csrf, body.toString());
  if (!result.ok) throw new Error(`収入への復元に失敗しました (status=${result.status})`);
}

/** 計算対象フラグだけ落とす（カテゴリ・金額・残高は触らない） */
async function excludeFromCalculation(page: Page, mfId: string): Promise<boolean> {
  const fields = await readTransactionRowFields(page, mfId);
  if (!fields) return false;
  const csrf = await getCsrfToken(page);
  if (!csrf) throw new Error("CSRF token がありません");
  const body = buildCategoryUpdateBody(mfId, fields, {
    largeCategoryId: fields["user_asset_act[large_category_id]"] ?? "0",
    middleCategoryId: fields["user_asset_act[middle_category_id]"] ?? "0",
    isIncome: fields["user_asset_act[is_income]"] === "1",
    isTarget: false,
  });
  const result = await putCfUpdate(page, csrf, body);
  return result.ok;
}

function groupByMonth(jobs: Job[]): Map<string, Job[]> {
  const byMonth = new Map<string, Job[]>();
  for (const job of jobs) {
    byMonth.set(job.month, [...(byMonth.get(job.month) ?? []), job]);
  }
  return byMonth;
}

async function convertCharges(page: Page, jobs: Job[], partnerHashes: Map<string, string>) {
  let ok = 0;
  let ng = 0;

  for (const [month, monthJobs] of [...groupByMonth(jobs)].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    console.log(`\n=== ${month} (${monthJobs.length} 件) ===`);

    // フェーズ1: 振替に切り替える
    await goToCashFlowMonth(page, month);
    for (const job of monthJobs) {
      if (job.item.type === "expense") {
        await restoreIncome(page, job);
      }
      const status = await page.evaluate(async (id) => {
        const response = await fetch(`/cf/update.js?change_type=enable_transfer&id=${id}`, {
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        return response.status;
      }, job.item.mfId);
      if (status !== 200) {
        console.log(`  ${job.item.date} enable_transfer status=${status}`);
        ng += 1;
      }
      await page.waitForTimeout(300);
    }

    // フェーズ2: 振替元を設定する
    await openCashFlowAtCurrentMonth(page);
    await goToCashFlowMonth(page, month);
    for (const job of monthJobs) {
      process.stdout.write(`  ${job.item.date} ¥${job.item.amount} ... `);
      try {
        const anchor = page.locator(`#change_act_type_${job.item.mfId}`);
        if ((await anchor.count()) === 0) {
          console.log("振替先リンクが無い（フェーズ1 失敗の可能性）");
          ng += 1;
          continue;
        }
        await anchor.click();
        const partnerSelect = page.locator(
          '#modal_change_act_type select[name="user_asset_act[partner_account_id_hash]"]',
        );
        await partnerSelect.waitFor({ state: "visible", timeout: 20000 });
        await partnerSelect.selectOption(partnerHashes.get(job.partner)!);
        await page.waitForTimeout(1200);
        await page.click('#modal_change_act_type input[name="commit"]');
        await page.waitForTimeout(2000);
        const stillOpen = await page.evaluate(
          () => document.querySelector("#modal_change_act_type")?.classList.contains("in") ?? false,
        );
        if (stillOpen) {
          console.log("モーダルが閉じない");
          ng += 1;
        } else {
          ok += 1;
          console.log("OK");
        }
      } catch (error) {
        console.log(`エラー: ${(error as Error).message}`);
        ng += 1;
      }
    }
  }

  return { ok, ng };
}

async function excludeCards(page: Page, jobs: Job[]) {
  let ok = 0;
  let ng = 0;

  for (const [month, monthJobs] of [...groupByMonth(jobs)].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    console.log(`\n=== ${month} カード側 (${monthJobs.length} 件) ===`);
    await goToCashFlowMonth(page, month);
    for (const job of monthJobs) {
      const card = job.card!;
      process.stdout.write(`  ${card.date} ¥${card.amount} ${card.description} ... `);
      try {
        const updated = await excludeFromCalculation(page, card.mfId);
        if (updated) {
          ok += 1;
          console.log("計算対象外");
        } else {
          ng += 1;
          console.log("更新失敗");
        }
      } catch (error) {
        console.log(`エラー: ${(error as Error).message}`);
        ng += 1;
      }
    }
  }

  return { ok, ng };
}

async function main(): Promise<void> {
  const { page, external } = await getMFPage();
  console.log(`browser: ${external ? "CDP 接続（常駐を再利用）" : "新規起動"}`);

  await openCashFlowAtCurrentMonth(page);
  const results = await scrapeCashFlowHistory(page, MONTHS);

  const jobs: Job[] = [];
  for (const result of results) {
    const items = result.data.items;
    for (const item of items) {
      if (item.accountName !== ACCOUNT_NAME) continue;
      if (!item.description.includes("チャージ")) continue;

      const candidates = items.filter(
        (candidate) =>
          candidate.type === "expense" &&
          candidate.accountName !== ACCOUNT_NAME &&
          candidate.date === item.date &&
          candidate.amount === item.amount,
      );
      const card =
        candidates.find((candidate) => candidate.accountName === DEFAULT_PARTNER) ?? candidates[0];
      jobs.push({
        month: result.data.month,
        item,
        partner: card?.accountName ?? "",
        card: card ?? null,
      });
    }
  }

  const toConvert = jobs.filter((job) => job.item.type !== "transfer");
  const toExclude = jobs.filter((job) => job.card && !job.card.isExcludedFromCalculation);

  console.log(
    `\nチャージ ${jobs.length} 件 / 振替への変換 ${toConvert.length} 件 / カード側の除外 ${toExclude.length} 件`,
  );
  for (const job of jobs) {
    const state = job.item.type === "transfer" ? "振替済み" : job.item.type;
    const cardState = !job.card
      ? "カード明細なし"
      : job.card.isExcludedFromCalculation
        ? "計算対象外"
        : `計算対象 (id=${job.card.mfId})`;
    console.log(
      `  ${job.item.date} ¥${job.item.amount} ${state} 相手=${job.partner || "(不明)"} カード=${cardState}`,
    );
  }

  if (toConvert.some((job) => !job.partner)) {
    throw new Error("相手口座が特定できないチャージがあります");
  }
  if (toExclude.length === 0 && toConvert.length === 0) {
    console.log("\n対象なし（すべて振替済み・カード側も計算対象外）");
    return;
  }
  if (!APPLY) {
    console.log("\ndry-run 完了（--apply で実行）");
    return;
  }

  const partnerHashes = new Map<string, string>();
  for (const partner of new Set(toConvert.map((job) => job.partner))) {
    partnerHashes.set(partner, await resolveAccountHash(page, partner));
  }

  const converted = await convertCharges(page, toConvert, partnerHashes);
  const excluded = await excludeCards(page, toExclude);

  console.log(
    `\n完了: 振替 OK=${converted.ok} NG=${converted.ng} / カード除外 OK=${excluded.ok} NG=${excluded.ng}（常駐ブラウザはそのまま）`,
  );
}

await main();
process.exit(0);
