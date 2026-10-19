/**
 * ファミペイの電子レシート API クライアント。
 *
 * 実体は AWS AppSync の GraphQL。APK の `res/raw/awsconfiguration` から取得した
 * 固定の API キーで認証する（会員トークンは不要）。会員の識別は
 * `hashedMemberNo`（`authenticationCheck` の `HASHED_KAIIN_NO`）で行う。
 */
import type { FamipaySession } from "../../src/famipay.js";
import { authenticationCheck, loadSession, saveSession } from "./famipay-api.js";

const ENDPOINT = "https://naepsp.famipay.family.co.jp/graphql";
const API_KEY = "da2-gha5hgh7qfecfkqhkwizfvww5u";

const QUERY_MONTHS = `query GetEReceipts($searchInput: SearchEReceiptsInput) {
  getEReceipts(searchInput: $searchInput) {
    __typename error { __typename code message } status errorName detailCode
    transactions { __typename year months }
  }
}`;

const QUERY_BY_YEAR_MONTH = `query GetEReceiptsByYearMonth($searchInput: SearchEReceiptsByYearMonthInput) {
  getEReceiptsByYearMonth(searchInput: $searchInput) {
    __typename error { __typename code message } status errorName detailCode
    eReceipts { __typename transactionId purchasedDateTime storeName total }
  }
}`;

const QUERY_BY_TRANSACTION = `query GetEReceiptByTransaction($searchInput: SearchEReceiptByTransactionInput) {
  getEReceiptByTransaction(searchInput: $searchInput) {
    __typename error { __typename code message } status errorName detailCode
    printedTextChunks
  }
}`;

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message?: string }[];
};

async function query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ query: document, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `電子レシート API が HTTP ${response.status} を返しました: ${text.slice(0, 200)}`,
    );
  }
  const payload = JSON.parse(text) as GraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(`電子レシート API エラー: ${payload.errors[0]?.message ?? "不明"}`);
  }
  if (!payload.data) throw new Error("電子レシート API が data を返しませんでした");
  return payload.data;
}

/** 電子レシート API 用の会員ハッシュ。無ければセッションから補って保存する。 */
export async function resolveHashedMemberNo(session?: FamipaySession): Promise<string> {
  const current = session ?? loadSession();
  if (!current) throw new Error("ファミペイのセッションがありません。先にログインしてください。");
  if (current.hashedMemberNo) return current.hashedMemberNo;

  const rotated = await authenticationCheck(current.kaiinHashKey, current.loginTerminalId);
  if (!rotated.hashedMemberNo) {
    throw new Error("authenticationCheck に HASHED_KAIIN_NO がありません");
  }
  saveSession({
    ...current,
    kaiinHashKey: rotated.kaiinHashKey,
    hashedMemberNo: rotated.hashedMemberNo,
    savedAt: new Date().toISOString(),
  });
  return rotated.hashedMemberNo;
}

export type ERceiptMonth = {
  year: string;
  months: string[];
};

export type ERceiptSummary = {
  transactionId: string;
  /** 例: `10/17 17:36` */
  purchasedDateTime: string;
  storeName: string;
  total: number;
};

export async function listReceiptMonths(hashedMemberNo: string): Promise<EReceiptMonth[]> {
  const data = await query<{
    getEReceipts: { status: string; transactions: ERceiptMonth[] | null } | null;
  }>(QUERY_MONTHS, { searchInput: { hashedMemberNo } });
  const result = data.getEReceipts;
  if (!result || result.status !== "000") return [];
  return result.transactions ?? [];
}

/** `yearMonth` は `YYYYMM` 形式（例: `202610`）。 */
export async function listReceiptsByYearMonth(
  hashedMemberNo: string,
  yearMonth: string,
): Promise<EReceiptSummary[]> {
  const data = await query<{
    getEReceiptsByYearMonth: {
      status: string;
      eReceipts:
        | {
            transactionId: string;
            purchasedDateTime: string;
            storeName: string;
            total: string | number;
          }[]
        | null;
    } | null;
  }>(QUERY_BY_YEAR_MONTH, { searchInput: { hashedMemberNo, transactionYearMonth: yearMonth } });
  const result = data.getEReceiptsByYearMonth;
  if (!result || result.status !== "000") return [];
  return (result.eReceipts ?? []).map((receipt) => ({
    transactionId: receipt.transactionId,
    purchasedDateTime: receipt.purchasedDateTime,
    storeName: receipt.storeName,
    total: Number(receipt.total),
  }));
}

/** レシート印字行を返す。取得できなければ空配列。 */
export async function fetchReceiptText(
  hashedMemberNo: string,
  transactionId: string,
): Promise<string[]> {
  const data = await query<{
    getEReceiptByTransaction: {
      status: string;
      printedTextChunks: string[] | null;
    } | null;
  }>(QUERY_BY_TRANSACTION, { searchInput: { hashedMemberNo, transactionId } });
  const result = data.getEReceiptByTransaction;
  if (!result || result.status !== "000") return [];
  return result.printedTextChunks ?? [];
}
