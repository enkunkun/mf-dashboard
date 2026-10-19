/**
 * ファミペイ (FamiPay) の HTTP API クライアントとセッション管理。
 *
 * 通信仕様は Android アプリ v6.7.0 の静的解析から得た。すべて `@FormUrlEncoded @POST` で、
 * `API_ENCRYPTION_KEY`（固定値）と `LOGIN_TERMINAL_ID`、認証系では `KAIIN_HASH_KEY` を送る。
 * リクエストごとの暗号化や端末 attestation は無い。
 *
 * ホストはエンドポイントで分かれる。`api/public/v1/...` は `hcsep.famipay.family.co.jp`、
 * `.jsp` 系は `famipay.family.co.jp`。URL の組み立ては `famipayApiUrl()` に集約している。
 *
 * 初回の `KAIIN_HASH_KEY` だけは Web ログイン（`webview/login.html`）で得る必要があり、
 * そこは `famipay-login.ts` が実ブラウザで処理する。
 */
import fs from "node:fs";
import path from "node:path";
import {
  FAMIPAY_API_ENCRYPTION_KEY,
  FAMIPAY_API_USER_AGENT,
  famipayApiUrl,
  parseAuthenticationCheck,
  parseHistoryDetail,
  parseHistoryPage,
  parseMemberInformation,
  parseZandaka,
  type FamipayBalance,
  type FamipayHistoryDetail,
  type FamipayHistoryRow,
  type FamipaySession,
} from "../../src/famipay.js";

const projectRoot = path.resolve(import.meta.dirname, "../../../..");
export const FAMIPAY_DATA_DIR = path.resolve(projectRoot, "data");
export const FAMIPAY_SESSION_PATH = path.resolve(FAMIPAY_DATA_DIR, "famipay-session.json");

/** セッションの有効期限の目安。アプリは 1 時間ごとに鍵をローテーションする。 */
const SESSION_TTL_MS = 60 * 60 * 1000;

export function loadSession(): FamipaySession | null {
  if (!fs.existsSync(FAMIPAY_SESSION_PATH)) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(FAMIPAY_SESSION_PATH, "utf8"),
    ) as Partial<FamipaySession>;
    if (!parsed.kaiinHashKey || !parsed.loginTerminalId) return null;
    return {
      applicationAuthenticationToken: parsed.applicationAuthenticationToken ?? "",
      kaiinHashKey: parsed.kaiinHashKey,
      loginTerminalId: parsed.loginTerminalId,
      savedAt: parsed.savedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveSession(session: FamipaySession): void {
  fs.mkdirSync(FAMIPAY_DATA_DIR, { recursive: true });
  fs.writeFileSync(FAMIPAY_SESSION_PATH, JSON.stringify(session, null, 2));
}

export function isSessionFresh(session: FamipaySession): boolean {
  const saved = Date.parse(session.savedAt);
  if (Number.isNaN(saved)) return false;
  return Date.now() - saved < SESSION_TTL_MS;
}

async function postForm(
  apiPath: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = famipayApiUrl(apiPath);
  const body = new URLSearchParams(fields);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": FAMIPAY_API_USER_AGENT,
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FamiPay ${apiPath} が HTTP ${res.status} を返しました: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`FamiPay ${apiPath} が JSON を返しませんでした: ${text.slice(0, 200)}`);
  }
}

const baseFields = (loginTerminalId: string): Record<string, string> => ({
  API_ENCRYPTION_KEY: FAMIPAY_API_ENCRYPTION_KEY,
  LOGIN_TERMINAL_ID: loginTerminalId,
});

/** `acquireMemberInformation.jsp`。初回トークンから KAIIN_HASH_KEY を得る。 */
export async function acquireMemberInformation(
  applicationAuthenticationToken: string,
  loginTerminalId: string,
): Promise<{ kaiinHashKey: string; kaiinNo: string | null; hashedMemberNo: string | null }> {
  const payload = await postForm("api/public/acquireMemberInformation.jsp", {
    ...baseFields(loginTerminalId),
    APPLICATION_AUTHENTICATION_TOKEN: applicationAuthenticationToken,
  });
  return parseMemberInformation(payload);
}

/** `authenticationCheck`。セッションキーをローテーションする。 */
export async function authenticationCheck(
  kaiinHashKey: string,
  loginTerminalId: string,
): Promise<{
  kaiinHashKey: string;
  webViewOneTimeToken: string | null;
  hashedMemberNo: string | null;
}> {
  const payload = await postForm("api/public/v1/authenticationCheck", {
    ...baseFields(loginTerminalId),
    KAIIN_HASH_KEY: kaiinHashKey,
  });
  return parseAuthenticationCheck(payload);
}

/** `getZandaka`。残高を返す。 */
export async function getZandaka(session: FamipaySession): Promise<FamipayBalance> {
  const payload = await postForm("api/public/v1/getZandaka", {
    ...baseFields(session.loginTerminalId),
    KAIIN_HASH_KEY: session.kaiinHashKey,
  });
  return parseZandaka(payload);
}

/** `listFamipayHistory.jsp`。1 ページ分の履歴を返す。 */
export async function listFamipayHistory(
  session: FamipaySession,
  from: string,
  to: string,
  pageNo: number,
): Promise<{ recordCount: number; rows: FamipayHistoryRow[] }> {
  const payload = await postForm("api/public/listFamipayHistory.jsp", {
    ...baseFields(session.loginTerminalId),
    KAIIN_HASH_KEY: session.kaiinHashKey,
    TORIHIKI_BI_FROM: from,
    TORIHIKI_BI_TO: to,
    PAGE_NO: String(pageNo),
  });
  return parseHistoryPage(payload);
}

/** `generateFamipayHistoryDetail.jsp`。1 件分の金額内訳を返す。 */
export async function generateHistoryDetail(
  session: FamipaySession,
  uriageNo: string,
): Promise<FamipayHistoryDetail> {
  const payload = await postForm("api/public/generateFamipayHistoryDetail.jsp", {
    API_ENCRYPTION_KEY: FAMIPAY_API_ENCRYPTION_KEY,
    KAIIN_HASH_KEY: session.kaiinHashKey,
    URIAGE_NO: uriageNo,
  });
  return parseHistoryDetail(payload, uriageNo);
}
