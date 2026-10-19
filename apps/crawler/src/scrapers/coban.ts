// pixivcoban の残高・入出金履歴の解釈ロジック（DOM/HTTP 非依存）。
// 取得元: https://coban.pixiv.net/api/v1/balance, /api/v1/history/{YYYY-MM}

/** GET /api/v1/balance */
export type CobanBalance = {
  balance: number;
  expectation_expired_coin: number;
  free_coin: number;
  paid_coin: number;
  pixiv_user_id: number;
};

type CobanGain = {
  amount: number;
  expired_at_epoch: number;
  is_paid: boolean;
  type: string;
};

type CobanLossSummary = {
  expired_at_epoch?: number;
  free_amount: number;
  paid_amount: number;
};

/** /api/v1/history/{YYYY-MM} の histories[] の 1 件 */
export type CobanHistoryEntry = {
  amount: number;
  /** ISO 8601（+09:00） */
  date_time: string;
  detail: string;
  summary: string;
  /** "paid" | "free" | "usage" | "expired" */
  type: string;
  service_name: string | null;
  gain?: CobanGain;
  lossSummary?: CobanLossSummary;
};

export type CobanHistory = {
  histories: CobanHistoryEntry[];
  month: string;
  pixiv_user_id: number;
};

/** MoneyForward の手動口座へ登録する 1 明細 */
export type CobanEntry = {
  /** YYYY-MM-DD */
  date: string;
  isIncome: boolean;
  amount: number;
  content: string;
  /** 重複判定用キー */
  key: string;
};

/** 残高を増やす種別（コバン購入・コバン付与） */
const GAIN_TYPES = new Set(["paid", "free"]);

/**
 * 明細の一意キー。coban の履歴には ID がないため、
 * マイクロ秒精度の日時 + 種別 + 金額 + 内容で重複を判定する。
 */
export function cobanEntryKey(e: CobanHistoryEntry): string {
  return `${e.date_time}|${e.type}|${e.amount}|${e.detail}`;
}

function contentOf(e: CobanHistoryEntry): string {
  if (e.service_name) return `${e.summary}（${e.service_name}）`;
  return e.summary;
}

/**
 * 履歴を MF 登録用の明細へ変換する（古い順）。
 * コバン購入/付与=収入、コバン利用/失効=支出。金額 0 の行は除外する。
 */
export function toCobanEntries(histories: CobanHistoryEntry[]): CobanEntry[] {
  return histories
    .filter((e) => e.amount > 0)
    .map((e) => ({
      date: e.date_time.slice(0, 10),
      isIncome: GAIN_TYPES.has(e.type),
      amount: e.amount,
      content: contentOf(e),
      key: cobanEntryKey(e),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export type CobanReconcile = {
  /** 明細の純増減（収入-支出） */
  net: number;
  /** coban が表示する実際の残高 */
  actualBalance: number;
  /** actualBalance - net（0 なら明細と残高が一致） */
  difference: number;
};

/**
 * 取得した全履歴の純増減を、coban の残高と突き合わせる。
 * 履歴は口座開設（残高 0）から始まる前提。coban の履歴は欠落があり得るため、
 * 差異は情報として扱い、口座残高は actualBalance を正とする。
 */
export function reconcileCoban(entries: CobanEntry[], actualBalance: number): CobanReconcile {
  const net = entries.reduce((acc, e) => acc + (e.isIncome ? e.amount : -e.amount), 0);
  return { net, actualBalance, difference: actualBalance - net };
}
