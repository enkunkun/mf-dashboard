/**
 * ファミペイの手動口座エントリにカテゴリを付ける。
 *
 * MF の手動入力には「1 取引を複数カテゴリに分ける明細」が無いため、1 訪問 1 取引のまま
 * 代表カテゴリを設定する。実データではほぼ全件が食費（レジ袋のみ日用品）。
 *
 *   pnpm --filter @mf-dashboard/crawler famipay:categorize            # dry-run
 *   pnpm --filter @mf-dashboard/crawler famipay:categorize -- --apply # MF を更新
 *
 * `includeExisting: true` で、既に登録済みでも未分類の行を対象にする。
 */
import type { Db } from "@mf-dashboard/db";
import { chromium } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { categorizeCashFlowMonth } from "../src/category-decision/categorize-cash-flow.js";
import type {
  CategoryDecisionUsage,
  NormalizedCategoryDecisionConfig,
} from "../src/category-decision/types.js";
import { scrapeCashFlowHistory } from "../src/scrapers/cash-flow-history.js";

const APPLY = process.argv.includes("--apply");
const monthsIndex = process.argv.indexOf("--months");
const MONTHS = monthsIndex >= 0 ? Number(process.argv[monthsIndex + 1]) : 18;

const ACCOUNT_NAME = "ファミペイ";

const config: NormalizedCategoryDecisionConfig = {
  llm: { enabled: false, maxPerRun: 5, minConfidence: 0.65 },
  rules: [
    {
      accountName: ACCOUNT_NAME,
      descriptionContains: "ファミリーマート",
      category: "食費",
      subCategory: "食料品",
    },
  ],
};

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await createBrowserContext(browser, { useAuthState: true });
    const page = await context.newPage();
    await loginWithAuthState(page, context);

    const results = await scrapeCashFlowHistory(page, MONTHS);
    const usage: CategoryDecisionUsage = { llmCallsUsed: 0 };
    let targetTotal = 0;

    for (const { month, data } of results) {
      const targets = data.items.filter(
        (item) =>
          item.accountName === ACCOUNT_NAME &&
          item.category === "未分類" &&
          !item.isTransfer &&
          !item.isExcludedFromCalculation,
      );
      if (targets.length === 0) continue;

      targetTotal += targets.length;
      console.log(
        `${month}: ファミペイの未分類 ${targets.length} 件（例: ${targets
          .slice(0, 2)
          .map((item) => `${item.date} ${item.amount}円 ${item.description.replace(/\n/g, " ")}`)
          .join(" / ")}）`,
      );

      if (!APPLY) continue;

      await categorizeCashFlowMonth({
        page,
        // includeExisting: true では DB を参照しない（既存 ID の除外をしない）
        db: null as unknown as Db,
        cashFlow: data,
        config,
        usage,
        includeExisting: true,
      });
    }

    console.log(`\n対象: ${targetTotal} 件`);
    console.log(
      APPLY
        ? `更新しました（適用 ${usage.appliedDecisions ?? 0} 件）`
        : "dry-run です。--apply で MF を更新します。",
    );
  } finally {
    await browser.close();
  }
}

await main();
