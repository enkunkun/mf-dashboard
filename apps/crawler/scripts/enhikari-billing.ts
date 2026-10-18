/**
 * enひかり電気の会員ページから月ごとの電気料金を取り、按分ファイルを作る。
 *
 * ページは「別途enひかり料金がかかります。enひかり料金と合計後の小数点以下の金額は
 * 切り捨てとなります」と説明しており、カードの「光コラボ回収代行分」は
 * 明細の月 + offset か月の請求として現れる（実測 offset=2、光回線分 ≈ 5,576 円）。
 *
 * 出力は scripts/enhikari-alloc.ts がそのまま読める形:
 *   { "match": {...}, "electricityCategory": {...}, "internetCategory": {...},
 *     "electricityByMonth": { "2025-11": 14179, ... } }
 *
 * 認証情報は 1Password から取る（項目の username に お客様ID、password にパスワード）。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/enhikari-billing.ts
 *   tsx --env-file=../../.env scripts/enhikari-billing.ts --out <按分.json> --offset 2
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { getOpClient } from "../src/auth/op-client.js";
import {
  parseEnhikariChargeHistory,
  shiftMonth,
  toAllocationConfig,
} from "../src/enhikari-billing.js";

const LOGIN_URL = "https://enhikari.jp/denki/index.php/login";
const LOGGED_IN_PATH = "/denki/index.php";
const DEFAULT_OUT = join(homedir(), ".local/share/mf-dashboard/enhikari-alloc.json");
const DEFAULT_DESCRIPTION = "NTT東日本光コラボ回収代行分";

function arg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = arg(args, "--out") ?? DEFAULT_OUT;
  const offset = Number(arg(args, "--offset") ?? 2);
  const from = arg(args, "--from");
  const account = arg(args, "--account") ?? "DCカード";
  const descriptionContains = arg(args, "--description") ?? DEFAULT_DESCRIPTION;

  const vault = process.env.OP_ENHIKARI_VAULT || process.env.OP_VAULT || "";
  const item = process.env.OP_ENHIKARI_ITEM || "enhikari.jp";
  const client = await getOpClient();
  const [username, password] = await Promise.all([
    client.secrets.resolve(`op://${vault}/${item}/username`),
    client.secrets.resolve(`op://${vault}/${item}/password`),
  ]);
  if (!username || !password) {
    throw new Error(`1Password の ${item} から認証情報を取れない（vault=${vault}）`);
  }

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  let html: string;
  try {
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="login"]', username);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      page.click('button[type="submit"], input[type="submit"], button:has-text("ログイン")'),
    ]);
    await page.waitForTimeout(3000);
    if (!new URL(page.url()).pathname.startsWith(LOGGED_IN_PATH)) {
      throw new Error(`ログインできていない: ${page.url()}`);
    }
    html = await page.content();
  } finally {
    await browser.close();
  }

  const charges = parseEnhikariChargeHistory(html).sort((a, b) => a.month.localeCompare(b.month));
  if (charges.length === 0) throw new Error("ご利用明細が 1 件も取れなかった");
  console.log(`明細 ${charges.length} か月（${charges[0]!.month} 〜 ${charges.at(-1)!.month}）:`);
  for (const charge of charges) {
    console.log(
      `  ${charge.month} 明細 ${charge.total.toFixed(2).padStart(10)} 円` +
        ` → ${shiftMonth(charge.month, offset)} の請求 ${Math.round(charge.total)} 円`,
    );
  }

  const config = toAllocationConfig({
    charges,
    offsetMonths: offset,
    from,
    match: { account, descriptionContains },
    electricityCategory: { category: "水道・光熱費", subcategory: "電気代" },
    internetCategory: { category: "通信費", subcategory: "インターネット" },
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\n${out} に書いた（${Object.keys(config.electricityByMonth).length} か月）`);
  console.log("次: scripts/enhikari-alloc.ts を dry-run で回して、光回線分が揃うか確かめる");
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
