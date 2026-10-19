/**
 * ファミペイ (FamiPay) 連携の純粋ロジック。
 *
 * Android アプリ v6.7.0 (`jp.co.family.familymart_app`) の静的解析で判明した通信仕様
 * にもとづき、レスポンスの解釈と取引分類だけをここに閉じ込める。
 * ネットワーク I/O は `scripts/lib/famipay-api.ts` が担う。
 */

/** FamiPay API のベース URL。アプリ内定数 `HC_BASE_URL`。 */
const FAMIPAY_BASE_URL = "https://famipay.family.co.jp/";

/**
 * `api/public/v1/...` 系が載っているホスト。アプリ内定数 `HC_BASE_URL_V2`。
 *
 * `HC_BASE_URL` 側には存在せず、`.jsp` 系とは別ホストなので取り違えやすい。
 * デプロイ済みの `v1/getZandaka` を `HC_BASE_URL` へ投げると HTML の 404 が返る。
 */
const FAMIPAY_BASE_URL_V2 = "https://hcsep.famipay.family.co.jp/";

/**
 * API パスから実際に投げる URL を組み立てる。
 *
 * アプリの `NetworkModule` はエンドポイントごとに `HC_BASE_URL` と `HC_BASE_URL_V2` を
 * 使い分けており、`api/public/v1/` 配下（`getZandaka` など）だけが V2 ホストにある。
 */
export function famipayApiUrl(apiPath: string): string {
  const base = apiPath.startsWith("api/public/v1/") ? FAMIPAY_BASE_URL_V2 : FAMIPAY_BASE_URL;
  return new URL(apiPath, base).toString();
}

/**
 * すべての API に `API_ENCRYPTION_KEY` として付与する固定値。
 * リクエストごとの暗号化はなく、アプリ内定数 `HC_API_ENCRIPTED_KEY` をそのまま送る。
 */
export const FAMIPAY_API_ENCRYPTION_KEY = "fa58392c541f94ae";

/** `RESULT_CODE` の成功値（`ApiResultType.SUCCESS`）。 */
const FAMIPAY_SUCCESS_CODE = "000";

/**
 * 履歴一覧 API が 1 回に返す件数。
 *
 * レスポンスの `KENSU` は**そのページの件数**で、総件数ではない（最終ページでも
 * 同じ値が返る）。総件数を示す項目は無いので、返り件数がこれを下回ったら最終ページと
 * みなしてページ送りを止める。
 */
export const FAMIPAY_HISTORY_PAGE_SIZE = 30;

/** 初回ログインに使う WebView の URL（`BuildConfig.LOGIN_HTML`）。 */
export const FAMIPAY_LOGIN_URL = `${FAMIPAY_BASE_URL}webview/login.html`;

/** Web ログイン成功後に遷移先 URL へ付与されるクエリパラメータ名。 */
const FAMIPAY_APP_AUTH_TOKEN_PARAM = "APPLICATION_AUTHENTICATION_TOKEN";

/** API 呼び出しに付ける User-Agent（`UserAgentInterceptor.hcApiUserAgent` 相当）。 */
export const FAMIPAY_API_USER_AGENT =
  "familymart_app/6.7.0 (jp.co.family.familymart_app; build:127; Android 14) okhttp/4.12.0";

/** ログイン WebView の User-Agent（`WebSettingsExtKt` 相当）。 */
export const FAMIPAY_WEBVIEW_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 (Famipay App Client Android 6.7.0; Pixel 7)";

/** 認証情報。`APPLICATION_AUTHENTICATION_TOKEN` から導出したセッション。 */
export type FamipaySession = {
  /** Web ログインで得る初回トークン。 */
  applicationAuthenticationToken: string;
  /** すべての API が要求するセッションキー（`KAIIN_HASH_KEY`）。 */
  kaiinHashKey: string;
  /** 端末識別子。端末 attestation ではなく、こちらで生成して固定すればよい。 */
  loginTerminalId: string;
  /**
   * 電子レシート API が要求する会員ハッシュ（`HASHED_KAIIN_NO`）。
   * `authenticationCheck` のレスポンスから得られる。
   */
  hashedMemberNo?: string | null;
  savedAt: string;
};

export type FamipayBalance = {
  /** ファミペイ残高（プリペイド）。`MN_ZNDK` */
  money: number;
  /** ファミペイボーナス。`PT_ZNDK` */
  points: number;
  /** あと払い残高。`ATOBARAI_ZNDK` */
  deferredPayment: number;
  passcodeOmissionFlag: string | null;
};

export type FamipayHistoryRow = {
  /** 明細の主キー。詳細 API の `URIAGE_NO` に渡す。 */
  uriageNo: string;
  denpyoNo: string | null;
  date: string;
  time: string | null;
  /** 取引区分。`TORIHIKI_KBN` */
  transactionKind: number | null;
  storeKind: number | null;
  detailKind: number | null;
  place: string | null;
  reason: string | null;
  /** 付与ポイント。`FUYO_PT` */
  addedPoints: number | null;
  /** 利用ポイント。`RIYO_PT` */
  usedPoints: number | null;
};

export type FamipayHistoryDetail = {
  uriageNo: string;
  date: string;
  time: string | null;
  transactionKind: number | null;
  storeKind: number | null;
  detailKind: number | null;
  place: string | null;
  reason: string | null;
  /** 支払い総額のうち現金で払った分。`MONEY_CASH` */
  cash: number;
  /** 支払い総額のうちファミペイ残高から払った分。`MONEY_PREPAID` */
  prepaid: number;
  /** 利用ポイント合計。`RIYO_PT_KEI` */
  usedPoints: number;
  /** あと払いフラグ。`ATOBARAI` */
  deferredPayment: string | null;
};

/** FamiPay の API は成功時 `RESULT_CODE === "000"`。それ以外は例外にする。 */
function assertFamipaySuccess(payload: Record<string, unknown>, label: string): void {
  const code = str(payload.RESULT_CODE);
  if (code === FAMIPAY_SUCCESS_CODE) return;
  const item = str(payload.ERR_KOMOKU_MEI) ?? "";
  throw new Error(
    `FamiPay ${label} が失敗しました: RESULT_CODE=${code ?? "(なし)"}` + (item ? ` (${item})` : ""),
  );
}

/**
 * Web ログイン後の遷移先 URL から `APPLICATION_AUTHENTICATION_TOKEN` を取り出す。
 * クエリでもフラグメントでも拾う（アプリはクエリを読む）。
 */
export function extractApplicationAuthToken(url: string): string | null {
  const query = /\?[^#]*/.exec(url)?.[0] ?? "";
  const hash = /#.*/.exec(url)?.[0] ?? "";
  for (const part of [query, hash]) {
    const m = new RegExp(`[?&#]${FAMIPAY_APP_AUTH_TOKEN_PARAM}=([^&#]+)`).exec(part);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** `acquireMemberInformation.jsp` のレスポンスからセッションの材料を取り出す。 */
export function parseMemberInformation(payload: Record<string, unknown>): {
  kaiinHashKey: string;
  kaiinNo: string | null;
  hashedMemberNo: string | null;
} {
  assertFamipaySuccess(payload, "acquireMemberInformation");
  const kaiinHashKey =
    str(payload.KAIIN_HASH_KEY) ??
    str(payload.HASHED_MEMBER_KEY) ??
    str(payload.HASHED_KAIIN_NO) ??
    null;
  if (!kaiinHashKey) {
    throw new Error(
      `acquireMemberInformation に KAIIN_HASH_KEY がありません: ${Object.keys(payload).join(",")}`,
    );
  }
  return {
    kaiinHashKey,
    kaiinNo: str(payload.KAIIN_NO) ?? null,
    hashedMemberNo: str(payload.KAIIN_HASH_NO) ?? str(payload.HASHED_KAIIN_NO) ?? null,
  };
}

/** `authenticationCheck.jsp` のレスポンスからローテーション後の鍵を取り出す。 */
export function parseAuthenticationCheck(payload: Record<string, unknown>): {
  kaiinHashKey: string;
  webViewOneTimeToken: string | null;
  hashedMemberNo: string | null;
} {
  assertFamipaySuccess(payload, "authenticationCheck");
  const kaiinHashKey = str(payload.KAIIN_HASH_KEY);
  if (!kaiinHashKey) throw new Error("authenticationCheck に KAIIN_HASH_KEY がありません");
  return {
    kaiinHashKey,
    webViewOneTimeToken: str(payload.WEBVIEW_ONETIME_TOKEN) ?? null,
    hashedMemberNo: str(payload.HASHED_KAIIN_NO),
  };
}

/** `getZandaka` のレスポンスを残高に変換する。 */
export function parseZandaka(payload: Record<string, unknown>): FamipayBalance {
  assertFamipaySuccess(payload, "getZandaka");
  return {
    money: num(payload.MN_ZNDK) ?? 0,
    points: num(payload.PT_ZNDK) ?? 0,
    deferredPayment: num(payload.ATOBARAI_ZNDK) ?? 0,
    passcodeOmissionFlag: str(payload.PASSCD_OMISSION_FLAG) ?? null,
  };
}

/** `listFamipayHistory.jsp` の 1 ページを変換する。 */
export function parseHistoryPage(payload: Record<string, unknown>): {
  recordCount: number;
  rows: FamipayHistoryRow[];
} {
  assertFamipaySuccess(payload, "listFamipayHistory");
  const list = Array.isArray(payload.PT_RIREKI) ? payload.PT_RIREKI : [];
  const rows: FamipayHistoryRow[] = [];
  for (const raw of list) {
    const row = asRecord(raw);
    if (!row) continue;
    const uriageNo = str(row.URIAGE_NO);
    if (!uriageNo) continue;
    rows.push({
      uriageNo,
      denpyoNo: str(row.DENPYO_NO) ?? null,
      date: str(row.TORIHIKI_BI) ?? "",
      time: str(row.TORIHIKI_TIME) ?? null,
      transactionKind: num(row.TORIHIKI_KBN),
      storeKind: num(row.GAIBU_KMT_KBN),
      detailKind: num(row.DETAIL_KBN),
      place: str(row.PLACE) ?? null,
      reason: str(row.SOUSA_RIYU) ?? null,
      addedPoints: num(row.FUYO_PT),
      usedPoints: num(row.RIYO_PT),
    });
  }
  // `KENSU` はこのページの件数（総件数ではない）。総件数を知る方法は無い。
  return { recordCount: num(payload.KENSU) ?? rows.length, rows };
}

/** `generateFamipayHistoryDetail.jsp` のレスポンスを変換する。 */
export function parseHistoryDetail(
  payload: Record<string, unknown>,
  uriageNo: string,
): FamipayHistoryDetail {
  assertFamipaySuccess(payload, "generateFamipayHistoryDetail");
  return {
    uriageNo,
    date: str(payload.TORIHIKI_BI) ?? "",
    time: str(payload.TORIHIKI_TIME) ?? null,
    transactionKind: num(payload.TORIHIKI_KBN),
    storeKind: num(payload.GAIBU_KMT_KBN),
    detailKind: num(payload.DETAIL_KBN),
    place: str(payload.PLACE) ?? null,
    reason: str(payload.SOUSA_RIYU) ?? null,
    cash: num(payload.MONEY_CASH) ?? 0,
    prepaid: num(payload.MONEY_PREPAID) ?? 0,
    usedPoints: num(payload.RIYO_PT_KEI) ?? 0,
    deferredPayment: str(payload.ATOBARAI) ?? null,
  };
}

/**
 * 取引の種類。アプリの `FamipayHistoryEntryModel.TransactionType` と同じ区分。
 */
export type FamipayTransactionKind = "purchase" | "charge" | "refund" | "other";

/** `TORIHIKI_KBN` と取引の種類の対応。値は `TransactionType` の定義そのもの。 */
const FAMIPAY_TRANSACTION_KINDS: Record<number, FamipayTransactionKind> = {
  1: "purchase",
  2: "charge",
  3: "refund",
  9: "other",
};

/** `TORIHIKI_KBN` を取引の種類に変換する。未知の値は `other` にする。 */
export function parseTransactionKind(value: number | null): FamipayTransactionKind {
  if (value === null) return "other";
  return FAMIPAY_TRANSACTION_KINDS[value] ?? "other";
}

/** 取引の種類の日本語表示。 */
const FAMIPAY_KIND_LABELS: Record<FamipayTransactionKind, string> = {
  purchase: "支払い",
  charge: "チャージ",
  refund: "返金",
  other: "その他",
};

/**
 * ファミマポイントの獲得行。`TORIHIKI_KBN=9`。
 * 残高は動かないので取り込まない。同じ `URIAGE_NO` を利用行と共有する点に注意。
 */
const FAMIPAY_POINT_KIND = 9;

/**
 * 売上明細 API を叩く必要がある行か。
 *
 * `DETAIL_KBN` が 1 の行だけが売上明細を持つ。チャージ（2）とポイント獲得（9）は 0 で、
 * 明細 API は `RESULT_CODE=008`（選択したFamiPay履歴が見つかりません）を返す。
 */
export function needsFamipayDetail(row: FamipayHistoryRow): boolean {
  return row.detailKind === 1;
}

/**
 * 一覧の 1 行を一意に識別するキー。
 * `URIAGE_NO` はポイント獲得行が利用行と共有するため、単独では主キーにならない。
 */
export function famipayEntryKey(row: FamipayHistoryRow): string {
  return `${row.uriageNo}:${row.transactionKind ?? "?"}:${row.date}`;
}

/**
 * 取引区分と金額から残高の増減を求める。
 *
 * 向きは `TORIHIKI_KBN` で決まる（1=支払い / 2=チャージ / 3=返金 / 9=その他）。
 * 明細があれば金額はアプリの明細画面と同じ `MONEY_CASH + MONEY_PREPAID`。
 * 明細が無いチャージは、一覧の `FUYO_PT` がチャージ額そのもの（1 pt = 1 円で記録されている）。
 * 向きが分からない `other` のときだけ金額の符号で補い、増減 0 なら null を返す。
 */
function classifyFamipayMovement(
  input: { transactionKind: number | null; addedPoints?: number | null },
  money: { prepaid: number; cash: number } | null,
): { kind: FamipayTransactionKind; amount: number; isIncome: boolean } | null {
  const kind = parseTransactionKind(input.transactionKind);
  if (money) {
    const total = money.prepaid + money.cash;
    if (total === 0) return null;
    const isIncome =
      kind === "charge" || kind === "refund" ? true : kind === "purchase" ? false : total < 0;
    return { kind, amount: Math.abs(total), isIncome };
  }
  if (kind === "charge") {
    const amount = Math.abs(input.addedPoints ?? 0);
    return amount === 0 ? null : { kind, amount, isIncome: true };
  }
  return null;
}

/** 明細 1 件の残高増減を求める。 */
export function classifyFamipayEntry(detail: FamipayHistoryDetail): {
  kind: FamipayTransactionKind;
  amount: number;
  isIncome: boolean;
} | null {
  return classifyFamipayMovement(detail, { prepaid: detail.prepaid, cash: detail.cash });
}

/**
 * 一覧の 1 行と（あれば）明細から残高増減を求める。
 * ポイント獲得行（`TORIHIKI_KBN=9`）は残高が動かないため常に null。
 */
export function classifyFamipayRow(
  row: FamipayHistoryRow,
  detail: FamipayHistoryDetail | null,
): { kind: FamipayTransactionKind; amount: number; isIncome: boolean } | null {
  if (row.transactionKind === FAMIPAY_POINT_KIND) return null;
  return classifyFamipayMovement(
    row,
    detail ? { prepaid: detail.prepaid, cash: detail.cash } : null,
  );
}

/** 摘要を組み立てるのに必要な項目。一覧の行と明細の両方が満たす。 */
export type FamipayEntryFields = Pick<FamipayHistoryRow, "place" | "reason" | "transactionKind">;

/** MoneyForward に登録する摘要。店名と理由を並べ、無ければ取引の種類にする。 */
export function famipayEntryContent(entry: FamipayEntryFields): string {
  const parts = [entry.place, entry.reason]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));
  return parts.length > 0
    ? parts.join(" ")
    : FAMIPAY_KIND_LABELS[parseTransactionKind(entry.transactionKind)];
}

/**
 * FamiPay の日付表記を MoneyForward の `updated_at` 形式 (`YYYY/MM/DD`) に直す。
 * `YYYYMMDD` / `YYYY/MM/DD` / `YYYY-MM-DD` を受け付ける。
 */
export function toMoneyForwardDate(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}/${m}/${d}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
