/**
 * ファミペイの電子レシート一覧を取得して `data/famipay-receipts.json` に保存する。
 *
 *   pnpm --filter @mf-dashboard/crawler famipay:receipts
 *   pnpm --filter @mf-dashboard/crawler famipay:receipts -- --text <transactionId>
 *
 * `--text` を付けると、その 1 件の印字テキストを取得して商品行に分解し、表示する。
 */
import fs from "node:fs";
import path from "node:path";
import { categorizeFamipayItem } from "@mf-dashboard/meta/famipay-categories";
import { allocateReceiptByCategory, parseReceiptText } from "../src/famipay-receipt.js";
import { FAMIPAY_DATA_DIR, loadSession } from "./lib/famipay-api.js";
import {
  fetchReceiptText,
  listReceiptMonths,
  listReceiptsByYearMonth,
  resolveHashedMemberNo,
} from "./lib/famipay-receipt-api.js";

const OUTPUT_PATH = path.join(FAMIPAY_DATA_DIR, "famipay-receipts.json");

type SavedReceipt = {
  yearMonth: string;
  transactionId: string;
  purchasedDateTime: string;
  storeName: string;
  total: number;
};

async function main(): Promise<void> {
  const session = loadSession();
  if (!session)
    throw new Error("data/famipay-session.json がありません。先にログインしてください。");
  const hashedMemberNo = await resolveHashedMemberNo(session);

  const textIndex = process.argv.indexOf("--text");
  if (textIndex >= 0) {
    const transactionId = process.argv[textIndex + 1];
    if (!transactionId) throw new Error("--text に transactionId を指定してください");
    const chunks = await fetchReceiptText(hashedMemberNo, transactionId);
    console.log(`印字行: ${chunks.length}`);
    console.log(chunks.join("\n"));
    const parsed = parseReceiptText(chunks);
    if (!parsed) {
      console.log("\n（商品行に分解できませんでした。合計 1 カテゴリにフォールバック）");
      return;
    }
    console.log("\n=== 商品 ===");
    for (const item of parsed.items) {
      console.log(`${categorizeFamipayItem(item.name)}\t${item.amount}\t${item.name}`);
    }
    console.log("\n=== 値引き ===");
    for (const adjustment of parsed.adjustments) {
      console.log(`${adjustment.amount}\t${adjustment.name}`);
    }
    console.log(
      `\n商品合計 ${parsed.itemTotal} / 値引 ${parsed.adjustmentTotal} / 合計 ${parsed.total}`,
    );
    console.log("\n=== カテゴリ配分 ===");
    for (const allocation of allocateReceiptByCategory(parsed, categorizeFamipayItem)) {
      console.log(`${allocation.category}\t${allocation.amount}`);
    }
    return;
  }

  const months = await listReceiptMonths(hashedMemberNo);
  const yearMonths = months.flatMap((month) =>
    month.months.map((m) => `${month.year}${m.padStart(2, "0")}`),
  );
  console.log(
    `電子レシートの対象月: ${yearMonths.length} か月（${yearMonths.at(-1)} 〜 ${yearMonths[0]}）`,
  );

  const receipts: SavedReceipt[] = [];
  for (const yearMonth of yearMonths) {
    const monthly = await listReceiptsByYearMonth(hashedMemberNo, yearMonth);
    for (const receipt of monthly) {
      receipts.push({ yearMonth, ...receipt });
    }
    console.log(`  ${yearMonth}: ${monthly.length} 件`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  fs.writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), receipts }, null, 2)}\n`,
  );
  console.log(`\n保存しました: ${OUTPUT_PATH}（${receipts.length} 件）`);
}

await main();
