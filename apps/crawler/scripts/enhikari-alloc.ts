/**
 * enひかりの按分を MF に反映する。
 *
 * enひかり電気の料金は enひかり本体（光回線）と合算され、NTT東日本の
 * 「光コラボ回収代行分」として月 1 件でカードに計上される。そのままだと家計簿上
 * 全部が通信費になるので、次の 3 つを行う。
 *
 *   1. 電気代の明細を「支出元なし」で登録（分類: 水道・光熱費/電気代）
 *   2. 残り（光回線など）の明細を「支出元なし」で登録（分類: 通信費/インターネット）
 *   3. 元のカード明細を「計算対象外」にする（カードの残高には残す）
 *
 * 電気代は enひかり電気の請求額を按分ファイルに書く。個人の請求額が入るので、
 * ファイルはリポジトリの外に置いてパスで渡す。
 *
 * 按分ファイル:
 *   {
 *     "match": { "account": "DCカード", "descriptionContains": "NTT東日本光コラボ回収代行分" },
 *     "electricityCategory": { "category": "水道・光熱費", "subcategory": "電気代" },
 *     "internetCategory": { "category": "通信費", "subcategory": "インターネット" },
 *     "electricityByMonth": { "2025-11": 14838 }
 *   }
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/enhikari-alloc.ts <按分.json>              # dry-run
 *   tsx --env-file=../../.env scripts/enhikari-alloc.ts <按分.json> --apply      # 書き込む
 *   tsx --env-file=../../.env scripts/enhikari-alloc.ts <按分.json> --only 2026-07,2026-08
 */
import { readFileSync } from "node:fs";
import type { CashFlowItem } from "@mf-dashboard/db/types";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import type { CategoryCandidate } from "../src/category-decision/types.js";
import {
  allocationMonths,
  buildSplitCreateBody,
  DEFAULT_CONTENTS,
  planEnhikariAllocation,
  type EnhikariAllocationConfig,
  type EnhikariAllocationPlan,
} from "../src/enhikari-allocation.js";
import {
  buildCategoryUpdateBody,
  getCsrfToken,
  putCfUpdate,
  readTransactionRowFields,
} from "../src/hooks/helpers.js";
import { extractCashFlowFromPage, goToCashFlowMonth } from "../src/scrapers/cash-flow-history.js";
import { scrapeCategoryCandidates } from "../src/scrapers/category-candidates.js";

function arg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** 締め日のずれで隣の月のページに載る明細もあるので、前後 1 か月も読む（未来の月は除く） */
function monthsAround(months: string[]): string[] {
  const sorted = [...months].sort();
  const first = new Date(`${sorted[0]}-01T00:00:00Z`);
  const last = new Date(`${sorted[sorted.length - 1]}-01T00:00:00Z`);
  const from = new Date(first);
  from.setUTCMonth(from.getUTCMonth() - 1);
  const to = new Date(last);
  to.setUTCMonth(to.getUTCMonth() + 1);
  const thisMonth = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  const out: string[] = [];
  for (const cursor = from; cursor <= to; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const month = cursor.toISOString().slice(0, 7);
    if (month > thisMonth) break;
    out.push(month);
  }
  return out;
}

async function readMonth(page: Page, month: string): Promise<CashFlowItem[]> {
  await goToCashFlowMonth(page, month);
  return (await extractCashFlowFromPage(page)).items;
}

/** 表示中の月を開き直して読む。goToCashFlowMonth は同じ月だと再読み込みしないため */
async function reloadMonth(page: Page): Promise<CashFlowItem[]> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#cf-detail-table").first().waitFor({ state: "visible", timeout: 15000 });
  return (await extractCashFlowFromPage(page)).items;
}

async function readMonths(page: Page, months: string[]): Promise<CashFlowItem[]> {
  const items: CashFlowItem[] = [];
  const seen = new Set<string>();
  for (const month of months) {
    for (const item of await readMonth(page, month)) {
      if (seen.has(item.mfId)) continue;
      seen.add(item.mfId);
      items.push(item);
    }
  }
  return items;
}

function report(plans: EnhikariAllocationPlan[]): void {
  for (const plan of plans) {
    if (plan.status === "apply") {
      const create = plan.create.length > 0 ? `登録 ${plan.create.join("+")}` : "登録なし";
      const exclude = plan.excludeOriginal ? "元を計算対象外" : "元はそのまま";
      console.log(
        `  ${plan.month}  apply  ${plan.item.description} ${plan.item.amount} 円` +
          ` → 電気 ${plan.electricity} / 光回線 ${plan.internet}（${create}、${exclude}）`,
      );
    } else {
      console.log(`  ${plan.month}  ${plan.status.padEnd(5)}  ${plan.reason}`);
    }
  }
}

async function createRow(
  page: Page,
  token: string,
  body: string,
): Promise<{ ok: boolean; status: number }> {
  return await page.evaluate(
    async ({ body, token }) => {
      const res = await fetch("/cf/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": token,
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      return { ok: res.ok, status: res.status };
    },
    { body, token },
  );
}

/** 元の明細を計算対象外にする。分類と金額は行のフォームの値をそのまま送る */
async function excludeRow(page: Page, token: string, mfId: string): Promise<string> {
  const fields = await readTransactionRowFields(page, mfId);
  if (!fields) return "行が無い";
  const body = buildCategoryUpdateBody(mfId, fields, {
    largeCategoryId: fields["user_asset_act[large_category_id]"] ?? "",
    middleCategoryId: fields["user_asset_act[middle_category_id]"] ?? "",
    isIncome: fields["user_asset_act[is_income]"] === "1",
    isTarget: false,
  });
  const result = await putCfUpdate(page, token, body);
  return `status=${result.status}`;
}

async function applyPlans(
  page: Page,
  plans: EnhikariAllocationPlan[],
  contents: { electricity: string; internet: string },
): Promise<void> {
  for (const plan of plans) {
    if (plan.status !== "apply") continue;
    await goToCashFlowMonth(page, plan.month);
    let token = await getCsrfToken(page);
    if (!token) throw new Error("CSRF token not found");

    const rows = {
      electricity: {
        amount: plan.electricity,
        content: contents.electricity,
        candidate: plan.electricityCandidate,
      },
      internet: {
        amount: plan.internet,
        content: contents.internet,
        candidate: plan.internetCandidate,
      },
    } as const;

    for (const part of plan.create) {
      const row = rows[part];
      const result = await createRow(
        page,
        token,
        buildSplitCreateBody({
          token,
          date: plan.item.date,
          amount: row.amount,
          content: row.content,
          largeCategoryId: row.candidate.largeCategoryId,
          middleCategoryId: row.candidate.middleCategoryId,
        }),
      );
      console.log(
        `    ${plan.month} 登録 ${row.content} ${row.amount} 円: status=${result.status}`,
      );
      await page.waitForTimeout(500);
      token = (await getCsrfToken(page)) ?? token;
    }

    // 2 件そろったことを確かめてから元の明細を外す。片方でも欠けたら支出が消えないようにする
    const missingIn = async (): Promise<string[]> => {
      const month = await reloadMonth(page);
      return Object.values(rows)
        .filter(
          (row) =>
            !month.some((item) => item.description === row.content && item.amount === row.amount),
        )
        .map((row) => row.content);
    };
    let missing = await missingIn();
    if (missing.length > 0) {
      await page.waitForTimeout(2000);
      await goToCashFlowMonth(page, plan.month);
      missing = await missingIn();
    }
    if (missing.length > 0) {
      console.log(
        `    ${plan.month} 登録を確認できない（${missing.join(", ")}）ため、元の明細は外さない`,
      );
      continue;
    }
    if (!plan.excludeOriginal) {
      console.log(`    ${plan.month} 元の明細は既に計算対象外`);
      continue;
    }
    console.log(
      `    ${plan.month} 計算対象外 ${plan.item.description}: ${await excludeRow(page, token, plan.item.mfId)}`,
    );
    await page.waitForTimeout(300);
  }
}

/** 按分で登録した「支出元なし」の明細を並べる（書き込み後の確認用） */
function reportSplitRows(
  items: CashFlowItem[],
  contents: { electricity: string; internet: string },
): void {
  const rows = items
    .filter(
      (item) =>
        item.description.includes(contents.electricity) ||
        item.description.includes(contents.internet),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    console.log("  （按分で登録した明細は無い）");
    return;
  }
  for (const row of rows) {
    console.log(
      `  ${row.date} ${row.description} ${row.amount} 円 ${row.category ?? "-"}/${row.subCategory ?? "-"}` +
        `${row.accountName ? ` [${row.accountName}]` : " [支出元なし]"}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filePath = args[0];
  if (!filePath || filePath.startsWith("--")) throw new Error("按分ファイルのパスを渡す");
  const apply = args.includes("--apply");
  const only = arg(args, "--only")?.split(",");

  const config = JSON.parse(readFileSync(filePath, "utf8")) as EnhikariAllocationConfig;
  const contents = {
    electricity: config.contents?.electricity ?? DEFAULT_CONTENTS.electricity,
    internet: config.contents?.internet ?? DEFAULT_CONTENTS.internet,
  };
  // --only は計画そのものを絞る（読む月だけ絞ると、隣の月の明細にまで書き込んでしまう）
  const target: EnhikariAllocationConfig = only
    ? {
        ...config,
        electricityByMonth: Object.fromEntries(
          Object.entries(config.electricityByMonth).filter(([month]) => only.includes(month)),
        ),
      }
    : config;
  if (allocationMonths(target).length === 0) throw new Error("対象の月が無い");
  const months = monthsAround(allocationMonths(target));

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  try {
    const context = await createBrowserContext(browser, { useAuthState: true });
    const page = await context.newPage();
    await loginWithAuthState(page, context);

    const candidates: CategoryCandidate[] = await scrapeCategoryCandidates(page);
    const items = await readMonths(page, months);
    const plans = planEnhikariAllocation(target, items, candidates);
    console.log(`${months.join(", ")} の明細 ${items.length} 件に対する按分の計画:`);
    report(plans);

    if (!apply) {
      console.log("\ndry-run 完了（--apply を付けると書き込む）");
      return;
    }

    console.log("\n適用:");
    await applyPlans(page, plans, contents);

    const after = await readMonths(page, months);
    console.log("\n適用後の再照合:");
    report(planEnhikariAllocation(target, after, candidates));
    console.log("\n按分で登録した明細:");
    reportSplitRows(after, contents);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
