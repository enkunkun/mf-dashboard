/**
 * PayPay の取引履歴を API で取得し、MoneyForward へ差分取込する本番ジョブ。
 *
 * crawler コンテナの supercronic から毎日 1 回実行される想定。
 * ログイン（実 Chrome が必要）は Mac 側で `paypay-fetch.ts login:start | login:otp` を済ませ、
 * トークンを 1Password（`OP_PAYPAY_ITEM`）に保存しておく。このジョブはそれを読むだけ。
 *
 * 取得はローリング窓（既定: 直近 35 日）でレポートを毎回作り直す。
 * 取込は `paypay-import.ts` が取引番号で重複排除するので、窓が重なっても二重登録しない。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/paypay-sync.ts            # 取得 + 取込
 *   tsx --env-file=../../.env scripts/paypay-sync.ts --dry-run  # 取得だけ（取込しない）
 */
import { PAYPAY_DIR, accessToken, fetchReportCsv } from "./lib/paypay-api.js";
import { runPayPayImport } from "./paypay-import.js";

const WINDOW_DAYS = 35;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fromStr = isoDate(from);
  const toStr = isoDate(to);

  // トークンを読み込み、失効間近なら refresh する（更新は保存先へ書き戻される）
  await accessToken();

  console.log(`PayPay レポート取得: ${fromStr} ~ ${toStr}`);
  const { file, bytes, report } = await fetchReportCsv({
    from: fromStr,
    to: toStr,
    outDir: PAYPAY_DIR,
  });
  console.log(`✅ ${file} (${bytes} bytes)  ${report.targetFrom} ~ ${report.targetTo}`);

  if (DRY_RUN) {
    console.log("--dry-run のため取込は行いません");
    return;
  }

  await runPayPayImport({ apply: true });
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
