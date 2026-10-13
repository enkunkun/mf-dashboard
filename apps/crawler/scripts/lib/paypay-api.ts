/**
 * PayPay 取引履歴を公式アプリの非公開 API から取得する。
 *
 * 実機アプリの UI 自動化を置き換えるためのモジュール。
 * ログインだけは実 Chrome (CDP) が必要（AWS WAF Bot Control のため）。
 * トークンが手に入れば以降は素の HTTP で `app4.paypay.ne.jp/bff/*` を叩ける。
 *
 * 前提: `~/.local/share/paypay-hook/paypay-api.mjs` で token を取得済みであること。
 *   node paypay-api.mjs login:start
 *   node paypay-api.mjs login:otp <4桁>
 *   node paypay-api.mjs refresh
 *
 * 取得した CSV は `paypay_<from>_<to>.csv` として CSV ディレクトリに置くので、
 * 既存の CSV インポート（scripts/paypay-import.ts）がそのまま読める。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * トークンと CSV の置き場。既定は `~/.local/share/paypay-hook`。
 * 別の場所に置く場合は環境変数 `PAYPAY_DIR` で上書きする。
 */
export const PAYPAY_DIR =
  process.env.PAYPAY_DIR ?? path.join(os.homedir(), ".local", "share", "paypay-hook");
export const TOKENS_PATH = path.resolve(PAYPAY_DIR, "tokens.json");

const ORIGIN = "https://app4.paypay.ne.jp";
const CLIENT_ID = "pay2-mobile-app-client";

/** アプリの PayPayHttpHeaderFactory と同じヘッダ。Is-Emulator は自己申告できる。 */
const baseHeaders = (): Record<string, string> => ({
  "User-Agent": "PaypayApp/5.69.0 Android17",
  "Client-Type": "PAYPAYAPP",
  "Client-Version": "5.69.0",
  "Client-OS-Type": "ANDROID",
  "Client-OS-Version": "17.0.0",
  "Client-Mode": "PRODUCTION",
  Timezone: "Asia/Tokyo",
  "System-Locale": "ja",
  "Network-Status": "WIFI",
  "Is-Emulator": "false",
  "Device-Name": "Pixel 8a",
  "Device-Manufacturer-Name": "Google",
  "Device-Brand-Name": "google",
  "Device-Hardware-Name": "akita",
  "Client-UUID": "11111111-1111-1111-1111-111111111111",
  "Device-UUID": "11111111-1111-1111-1111-111111111111",
});

export type Report = {
  requestedAt: string;
  expiredAt: string;
  fileKey: string;
  fileSize: string | null;
  language: string;
  status: "COMPLETED" | "PROCESSING" | "FAILED" | string;
  targetFrom: string;
  targetTo: string;
};

/**
 * tokens.json の形。expiredAt は accessToken の失効時刻（ISO）。
 * refreshToken は実測では refresh してもローテーションされない（同一値が返る）。
 */
type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiredAt?: string;
  issuedAt?: string;
  savedAt?: string;
  [k: string]: unknown;
};

export function loadTokens(): Tokens {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error(`${TOKENS_PATH} がありません。先に paypay-api.mjs でログインしてください`);
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as Tokens;
}

function saveTokens(tokens: Tokens): void {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  fs.chmodSync(TOKENS_PATH, 0o600);
}

/** accessToken を返す。期限切れ間近なら refresh する。 */
export async function accessToken(forceRefresh = false): Promise<string> {
  const tokens = loadTokens();
  // expiredAt は accessToken の失効時刻（ISO）。5 分の余裕を見る。
  const expired = tokens.expiredAt ? Date.parse(tokens.expiredAt) : 0;
  if (!forceRefresh && expired > Date.now() + 5 * 60_000) return tokens.accessToken;

  const res = await fetch(`${ORIGIN}/bff/v2/oauth2/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...baseHeaders(),
    },
    body: new URLSearchParams({
      clientId: CLIENT_ID,
      refreshToken: tokens.refreshToken,
      tokenVersion: "v2",
    }),
  });
  const body = (await res.json()) as { payload?: Partial<Tokens> };
  if (!body.payload?.accessToken)
    throw new Error(`refresh 失敗: ${JSON.stringify(body).slice(0, 300)}`);
  const next: Tokens = {
    ...tokens,
    ...body.payload,
    refreshToken: body.payload.refreshToken ?? tokens.refreshToken,
    savedAt: new Date().toISOString(),
  } as Tokens;
  saveTokens(next);
  return next.accessToken;
}

async function authHeaders(): Promise<Record<string, string>> {
  return { ...baseHeaders(), Authorization: `Bearer ${await accessToken()}` };
}

/** 取引履歴レポートの一覧（新しい順ではないので呼び出し側で並べる）。 */
export async function listReports(): Promise<Report[]> {
  const res = await fetch(`${ORIGIN}/bff/v1/getTransactionReportList`, {
    headers: await authHeaders(),
  });
  const body = (await res.json()) as { payload?: { reports?: Report[] } };
  return body.payload?.reports ?? [];
}

/** 指定期間のレポート生成を依頼する（非同期。完成は listReports で確認）。 */
export async function generateReport(targetFrom: string, targetTo: string): Promise<void> {
  const res = await fetch(`${ORIGIN}/bff/v1/generateTransactionReport`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ targetFrom, targetTo }),
  });
  const body = (await res.json()) as {
    header?: { resultCode?: string; resultMessage?: string };
  };
  if (body.header?.resultCode !== "S0000") {
    throw new Error(`generateTransactionReport 失敗: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 指定期間の COMPLETED レポートを待つ（無ければ生成を依頼する）。 */
export async function ensureReport(
  targetFrom: string,
  targetTo: string,
  timeoutMs = 180_000,
): Promise<Report> {
  const find = (reports: Report[]) =>
    reports.find(
      (r) => r.status === "COMPLETED" && r.targetFrom === targetFrom && r.targetTo === targetTo,
    );

  const existing = find(await listReports());
  if (existing) return existing;

  await generateReport(targetFrom, targetTo);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const reports = await listReports();
    const done = find(reports);
    if (done) return done;
    const failed = reports.find(
      (r) =>
        r.status !== "COMPLETED" &&
        r.status !== "PROCESSING" &&
        r.targetFrom === targetFrom &&
        r.targetTo === targetTo,
    );
    if (failed) throw new Error(`レポート生成が失敗しました: ${JSON.stringify(failed)}`);
  }
  throw new Error("レポート生成がタイムアウトしました");
}

/** レポート本体を取得する。downloadTransactionReport は署名付き S3 URL を返す 2 段構え。 */
export async function downloadReport(fileKey: string): Promise<Buffer> {
  const res = await fetch(
    `${ORIGIN}/bff/v1/downloadTransactionReport?fileKey=${encodeURIComponent(fileKey)}`,
    {
      headers: await authHeaders(),
    },
  );
  const body = (await res.json()) as { payload?: { url?: string } };
  const url = body.payload?.url;
  if (!url)
    throw new Error(
      `downloadTransactionReport が url を返しません: ${JSON.stringify(body).slice(0, 300)}`,
    );
  const csv = await fetch(url);
  if (!csv.ok) throw new Error(`S3 からの取得に失敗: HTTP ${csv.status}`);
  return Buffer.from(await csv.arrayBuffer());
}

/**
 * 指定期間の CSV を取得して書き出す。
 * 既定のファイル名は CSV インポートが拾えるよう `paypay_<from>_<to>.csv`。
 */
export async function fetchReportCsv(options: {
  from: string;
  to: string;
  outDir?: string;
  fileName?: string;
}): Promise<{ file: string; bytes: number; report: Report }> {
  const { from, to } = options;
  const outDir = options.outDir ?? PAYPAY_DIR;
  const report = await ensureReport(from, to);
  const csv = await downloadReport(report.fileKey);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.resolve(outDir, options.fileName ?? `paypay_${from}_${to}.csv`);
  fs.writeFileSync(file, csv);
  return { file, bytes: csv.length, report };
}
