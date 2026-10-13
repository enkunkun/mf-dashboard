/**
 * PayPay 取引履歴を API で扱う一連の CLI。
 *
 * ログイン（実 Chrome が必要）から取得までを 1 つの入口にまとめている。
 * 取得した CSV は `paypay_<from>_<to>.csv` として CSV ディレクトリに置くので、
 * 既存の CSV インポート（scripts/paypay-import.ts）がそのまま読める。
 *
 * 使い方:
 *   npx tsx scripts/paypay-fetch.ts login:start          # 認可ページをブラウザで開く
 *   npx tsx scripts/paypay-fetch.ts login:otp <4桁>      # SMS の 4 桁 → トークン保存
 *   npx tsx scripts/paypay-fetch.ts refresh              # accessToken を更新（90 日期限の延命）
 *   npx tsx scripts/paypay-fetch.ts reports              # レポート一覧
 *   npx tsx scripts/paypay-fetch.ts download <fileKey> [out.csv]
 *   npx tsx scripts/paypay-fetch.ts history [pageSize]   # 明細を JSON で見る
 *   npx tsx scripts/paypay-fetch.ts                      # いちばん広いレポートを CSV 化
 *   npx tsx scripts/paypay-fetch.ts --list               # レポート一覧（取得はしない）
 *   npx tsx scripts/paypay-fetch.ts --all                # COMPLETED を全部 CSV 化
 *   npx tsx scripts/paypay-fetch.ts --from 2026-01-01 --to 2026-10-13
 *   npx tsx scripts/paypay-fetch.ts --out-dir /tmp/paypay
 *
 * 保存先は既定で `~/.local/share/paypay-hook`（環境変数 `PAYPAY_DIR` で変更可）。
 * **このディレクトリはリポジトリに含めない。**トークンと明細が入るため。
 *
 * 注意: これは PayPay の非公開 API。仕様変更で壊れうる。自己責任で。
 */
import fs from "node:fs";
import path from "node:path";
import {
  PAYPAY_DIR,
  accessToken,
  baseHeaders,
  downloadReport,
  fetchReportCsv,
  listReports,
  type Report,
} from "./lib/paypay-api.js";
import { completeLogin, loginStart } from "./lib/paypay-login.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT_DIR = valueOf("--out-dir") ?? PAYPAY_DIR;

function span(r: Report): number {
  return (Date.parse(r.targetTo) || 0) - (Date.parse(r.targetFrom) || 0);
}

function show(reports: Report[]): void {
  for (const r of reports) {
    console.log(
      `  [${r.status}] ${r.targetFrom} ~ ${r.targetTo}  ${r.fileSize ?? "-"}  ${r.fileKey}`,
    );
  }
}

async function showReports(): Promise<void> {
  console.log("取引履歴レポート:");
  show(await listReports());
}

async function downloadToFile(fileKey: string, out?: string): Promise<void> {
  if (!fileKey) throw new Error("fileKey を指定してください");
  const csv = await downloadReport(fileKey);
  const dest = out ?? path.resolve(OUT_DIR, `paypay_${fileKey.slice(0, 8)}.csv`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, csv);
  console.log(`✅ ${dest} (${csv.length} bytes)`);
}

async function showHistory(pageSize: string): Promise<void> {
  const token = await accessToken();
  const res = await fetch(
    `https://app4.paypay.ne.jp/bff/v4/getPaymentHistory?pageSize=${pageSize}`,
    {
      headers: { ...baseHeaders(), Authorization: `Bearer ${token}` },
    },
  );
  console.log(JSON.stringify(await res.json(), null, 2).slice(0, 4_000));
}

/** 引数なし/フラグだけのときの従来動作（レポートを CSV 化する）。 */
async function fetchCsvs(): Promise<void> {
  const from = valueOf("--from");
  const to = valueOf("--to");

  if (has("--list")) {
    await showReports();
    return;
  }

  if (from && to) {
    const { file, bytes, report } = await fetchReportCsv({ from, to, outDir: OUT_DIR });
    console.log(`✅ ${file} (${bytes} bytes)  ${report.targetFrom} ~ ${report.targetTo}`);
    return;
  }

  const reports = await listReports();
  const completed = reports.filter((r) => r.status === "COMPLETED" && r.fileKey);

  if (completed.length === 0) {
    console.log("COMPLETED なレポートがありません。--from/--to で生成を依頼してください。");
    show(reports);
    return;
  }

  if (has("--all")) {
    for (const r of completed) {
      const { file, bytes } = await fetchReportCsv({
        from: r.targetFrom,
        to: r.targetTo,
        outDir: OUT_DIR,
      });
      console.log(`✅ ${file} (${bytes} bytes)  ${r.targetFrom} ~ ${r.targetTo}`);
    }
    return;
  }

  // いちばん広い COMPLETED レポートを 1 つ落とす
  const widest = completed.slice().sort((a, b) => span(b) - span(a))[0]!;
  const { file, bytes } = await fetchReportCsv({
    from: widest.targetFrom,
    to: widest.targetTo,
    outDir: OUT_DIR,
  });
  console.log(`✅ ${file} (${bytes} bytes)  ${widest.targetFrom} ~ ${widest.targetTo}`);
}

const [command] = args;
switch (command) {
  case "login:start":
    await loginStart();
    break;
  case "login:otp":
    await completeLogin(args[1] ?? "");
    break;
  case "refresh":
    await accessToken(true);
    console.log("✅ accessToken を更新しました");
    break;
  case "reports":
    await showReports();
    break;
  case "download":
    await downloadToFile(args[1] ?? "", args[2]);
    break;
  case "history":
    await showHistory(args[1] ?? "20");
    break;
  default:
    await fetchCsvs();
}
