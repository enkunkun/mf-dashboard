/**
 * 明細（`data/famipay-details.json`）と電子レシートを突き合わせ、
 * 商品をカテゴリ別に配分した結果を `data/famipay-receipt-classification.json` に保存する。
 *
 *   pnpm --filter @mf-dashboard/crawler famipay:classify
 *
 * 既に取得済みのレシート印字テキストはキャッシュ（`data/famipay-receipt-texts.json`）を使う。
 */
import fs from "node:fs";
import path from "node:path";
import { categorizeFamipayItem } from "@mf-dashboard/meta/famipay-categories";
import {
  allocateReceiptByCategory,
  parseReceiptText,
  type FamipayCategoryAllocation,
} from "../src/famipay-receipt.js";
import { FAMIPAY_DATA_DIR, loadSession } from "./lib/famipay-api.js";
import { fetchReceiptText, resolveHashedMemberNo } from "./lib/famipay-receipt-api.js";

const DETAILS_PATH = path.join(FAMIPAY_DATA_DIR, "famipay-details.json");
const RECEIPTS_PATH = path.join(FAMIPAY_DATA_DIR, "famipay-receipts.json");
const TEXTS_PATH = path.join(FAMIPAY_DATA_DIR, "famipay-receipt-texts.json");
const OUTPUT_PATH = path.join(FAMIPAY_DATA_DIR, "famipay-receipt-classification.json");

type Detail = {
  date: string;
  time: string;
  place: string;
  usedPoints: number;
  transactionKind: number;
};

type Receipt = {
  yearMonth: string;
  transactionId: string;
  purchasedDateTime: string;
  storeName: string;
  total: number;
};

type ClassifiedEntry = {
  uriageNo: string;
  date: string;
  time: string;
  amount: number;
  store: string;
  transactionId: string | null;
  allocations: FamipayCategoryAllocation[];
  items: { name: string; amount: number }[];
};

const readJson = <T>(filePath: string, fallback: T): T => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
};

const receiptKey = (receipt: Receipt): string => {
  const [monthDay, time] = receipt.purchasedDateTime.split(" ");
  const [month, day] = (monthDay ?? "").split("/");
  return `${receipt.yearMonth.slice(0, 4)}${month}${day}:${(time ?? "").replace(":", "")}`;
};

const detailKey = (detail: Detail): string => `${detail.date}:${detail.time.slice(0, 4)}`;

async function main(): Promise<void> {
  const details = readJson<Record<string, Detail>>(DETAILS_PATH, {});
  const { receipts } = readJson<{ receipts: Receipt[] }>(RECEIPTS_PATH, { receipts: [] });
  const texts = readJson<Record<string, string[]>>(TEXTS_PATH, {});

  const receiptsByKey = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    const key = receiptKey(receipt);
    receiptsByKey.set(key, [...(receiptsByKey.get(key) ?? []), receipt]);
  }

  const session = loadSession();
  if (!session) throw new Error("セッションがありません");
  const hashedMemberNo = await resolveHashedMemberNo(session);

  const entries: ClassifiedEntry[] = [];
  let fetched = 0;

  for (const [uriageNo, detail] of Object.entries(details)) {
    if (detail.transactionKind !== 1) continue;

    const candidates = receiptsByKey.get(detailKey(detail)) ?? [];
    const receipt = candidates.find((candidate) => candidate.total === detail.usedPoints);
    if (!receipt) {
      entries.push({
        uriageNo,
        date: detail.date,
        time: detail.time,
        amount: detail.usedPoints,
        store: detail.place.replace(/^ファミリーマート\s*/, "").replace(/\n/g, " "),
        transactionId: null,
        allocations: [{ category: "食費", amount: detail.usedPoints }],
        items: [],
      });
      continue;
    }

    let chunks = texts[receipt.transactionId];
    if (!chunks) {
      chunks = await fetchReceiptText(hashedMemberNo, receipt.transactionId);
      texts[receipt.transactionId] = chunks;
      fetched += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const parsed = parseReceiptText(chunks);
    const allocations = parsed
      ? allocateReceiptByCategory(parsed, categorizeFamipayItem)
      : [{ category: "食費", amount: detail.usedPoints }];

    entries.push({
      uriageNo,
      date: detail.date,
      time: detail.time,
      amount: detail.usedPoints,
      store: detail.place.replace(/^ファミリーマート\s*/, "").replace(/\n/g, " "),
      transactionId: receipt.transactionId,
      allocations,
      items: parsed?.items.map((item) => ({ name: item.name, amount: item.amount })) ?? [],
    });
  }

  fs.writeFileSync(TEXTS_PATH, `${JSON.stringify(texts, null, 2)}\n`);
  fs.writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
  );

  const withReceipt = entries.filter((entry) => entry.transactionId !== null).length;
  const multiCategory = entries.filter((entry) => entry.allocations.length > 1).length;
  const distribution = new Map<number, number>();
  for (const entry of entries) {
    const count = entry.allocations.length;
    distribution.set(count, (distribution.get(count) ?? 0) + 1);
  }

  console.log(`分類対象: ${entries.length} 件`);
  console.log(`レシートあり: ${withReceipt} 件（今回取得 ${fetched} 件）`);
  console.log(`複数カテゴリ: ${multiCategory} 件`);
  console.log(
    `カテゴリ数の分布: ${[...distribution]
      .sort((a, b) => a[0] - b[0])
      .map(([count, n]) => `${count}区分=${n}件`)
      .join(" / ")}`,
  );
  console.log(`保存しました: ${OUTPUT_PATH}`);
}

await main();
