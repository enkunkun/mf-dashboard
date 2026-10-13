/**
 * PayPay 取引履歴を API から取得して CSV を書き出す。
 *
 * 既存の CSV インポート（scripts/paypay-import.ts）が読むディレクトリに
 * `paypay_<from>_<to>.csv` を置くので、取得 → 取り込みの順に流せる。
 *
 * 使い方:
 *   tsx scripts/paypay-fetch.ts                     # 既存のいちばん広いレポートを取得
 *   tsx scripts/paypay-fetch.ts --list              # レポート一覧を見るだけ
 *   tsx scripts/paypay-fetch.ts --all               # 取得可能な COMPLETED を全部落とす
 *   tsx scripts/paypay-fetch.ts --from 2026-01-01 --to 2026-10-13
 *                                                   # 範囲指定（無ければ生成を依頼して待つ）
 *   tsx scripts/paypay-fetch.ts --out-dir /tmp/pp
 *
 * 前提: 先に `~/.local/share/paypay-hook/paypay-api.mjs` でログインしておく
 *   node paypay-api.mjs login:start
 *   node paypay-api.mjs login:otp <4桁>
 *
 * 注意: これは PayPay の非公開 API。仕様変更で壊れうる。
 */
import { PAYPAY_DIR, fetchReportCsv, listReports, type Report } from "./lib/paypay-api.js";

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

async function main(): Promise<void> {
  const from = valueOf("--from");
  const to = valueOf("--to");

  if (has("--list")) {
    console.log("取引履歴レポート:");
    show(await listReports());
    return;
  }

  if (from && to) {
    const { file, bytes, report } = await fetchReportCsv({
      from,
      to,
      outDir: OUT_DIR,
    });
    console.log(`✅ ${file} (${bytes} bytes)  ${report.targetFrom} ~ ${report.targetTo}`);
    return;
  }

  const reports = await listReports();
  const completed = reports.filter((r) => r.status === "COMPLETED" && r.fileKey);

  if (has("--all")) {
    if (completed.length === 0) {
      console.log("COMPLETED なレポートがありません。--from/--to で生成を依頼してください。");
      return;
    }
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

  // 引数なし: いちばん広い COMPLETED レポートを 1 つ落とす
  const widest = completed.slice().sort((a, b) => span(b) - span(a))[0];
  if (!widest) {
    console.log("COMPLETED なレポートがありません。--from/--to で生成を依頼してください。");
    console.log("現在のレポート:");
    show(reports);
    return;
  }
  const { file, bytes } = await fetchReportCsv({
    from: widest.targetFrom,
    to: widest.targetTo,
    outDir: OUT_DIR,
  });
  console.log(`✅ ${file} (${bytes} bytes)  ${widest.targetFrom} ~ ${widest.targetTo}`);
}

await main();
