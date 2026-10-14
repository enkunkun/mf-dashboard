// モバイルSuica の SF(電子マネー)利用履歴の解釈ロジック（DOM 非依存）。
// pages: https://www.mobilesuica.com/iq/ir/SuicaDisp.aspx

export type SuicaHistoryRow = {
  /** "08/31" 形式 */
  monthDay: string;
  kindIn: string;
  placeIn: string;
  kindOut: string;
  placeOut: string;
  balance: number;
  /** 入金・利用額（利用は負、チャージは正） */
  amount: number;
};

export type SuicaEntry = {
  /** YYYY-MM-DD */
  date: string;
  isIncome: boolean;
  amount: number;
  content: string;
  balance: number;
  /** 重複判定用キー */
  key: string;
};

export type SuicaDateAnchor = { year: number; month: number; day: number };

const MONTH_DAY = /^(\d{1,2})\/(\d{1,2})$/;

function toNumber(v: string | undefined): number {
  if (v === undefined) return Number.NaN;
  const s = v.replace(/[^\d-]/g, "");
  if (!s || s === "-") return Number.NaN;
  return Number(s);
}

function normalizePlace(s: string | undefined): string {
  return (s ?? "").replace(/[\s\u3000]/g, "");
}

/** 履歴テーブルのセル配列から、金額のある行だけを取り出す（ヘッダ・金額なし行は除外）。 */
export function parseHistoryCells(cells: string[][]): SuicaHistoryRow[] {
  const rows: SuicaHistoryRow[] = [];
  for (const c of cells) {
    if (c.length < 8) continue;
    if (!MONTH_DAY.test((c[1] ?? "").trim())) continue;
    const amount = toNumber(c[7]);
    if (Number.isNaN(amount) || amount === 0) continue;
    const balance = toNumber(c[6]);
    rows.push({
      monthDay: (c[1] ?? "").trim(),
      kindIn: (c[2] ?? "").trim(),
      placeIn: c[3] ?? "",
      kindOut: (c[4] ?? "").trim(),
      placeOut: c[5] ?? "",
      balance: Number.isNaN(balance) ? 0 : balance,
      amount,
    });
  }
  return rows;
}

/**
 * 降順の月日リストに、検索アンカー日から遡って YYYY-MM-DD を割り当てる。
 * リストは「アンカー日以前の直近100件」で、月を跨ぐため、月が戻った地点で年も繰り下げる。
 */
export function assignDates(rows: SuicaHistoryRow[], anchor: SuicaDateAnchor): string[] {
  let year = anchor.year;
  let month = anchor.month;
  return rows.map((r) => {
    const md = MONTH_DAY.exec(r.monthDay);
    if (!md) return "";
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m !== month) {
      if (m < month) {
        month = m;
      } else {
        year -= 1;
        month = m;
      }
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  });
}

function describe(row: SuicaHistoryRow): string {
  const placeIn = normalizePlace(row.placeIn);
  const placeOut = normalizePlace(row.placeOut);
  if (row.kindIn === "入" || row.kindOut === "出") return `${placeIn}→${placeOut}`;
  if (row.kindIn === "物販") return placeOut ? `物販 ${placeOut}` : "物販";
  if (row.kindIn === "ﾊﾞｽ等") return `バス${placeIn ? ` ${placeIn}` : ""}`;
  if (row.kindIn === "ｶｰﾄﾞ") return `チャージ${placeIn ? ` ${placeIn}` : ""}`;
  return `${row.kindIn}${placeIn}`;
}

export function toSuicaEntries(rows: SuicaHistoryRow[], anchor: SuicaDateAnchor): SuicaEntry[] {
  const dates = assignDates(rows, anchor);
  return rows.map((r, i) => {
    const date = dates[i] ?? "";
    return {
      date,
      isIncome: r.amount > 0,
      amount: Math.abs(r.amount),
      content: describe(r),
      balance: r.balance,
      key: `${date}|${r.kindIn}|${normalizePlace(r.placeIn)}|${r.kindOut}|${normalizePlace(r.placeOut)}|${r.amount}|${r.balance}`,
    };
  });
}

type SuicaReconcileGap = {
  date: string;
  content: string;
  expectedBalance: number;
  actualBalance: number;
};

export type SuicaReconcile = {
  count: number;
  /** 取込んだ最古明細の直前の残高 */
  openingBalance: number;
  /** 取込んだ明細の純増減（収入-支出） */
  net: number;
  /** opening + net（明細から期待される現在残高） */
  expectedClosing: number;
  /** Suicaが表示する実際の現在残高 */
  actualClosing: number;
  /** actualClosing - expectedClosing（0なら一致） */
  difference: number;
  /** 残高が連続していない箇所 */
  gaps: SuicaReconcileGap[];
};

/**
 * 取込んだ明細から現在残高を再計算し、Suica表示の残高と突き合わせる。
 * 明細は古い順に並んでいる前提（直前残高＋収支＝その行の残高）。
 */
export function reconcileEntries(entries: SuicaEntry[]): SuicaReconcile {
  if (entries.length === 0) {
    return {
      count: 0,
      openingBalance: 0,
      net: 0,
      expectedClosing: 0,
      actualClosing: 0,
      difference: 0,
      gaps: [],
    };
  }
  const signed = (e: SuicaEntry) => (e.isIncome ? e.amount : -e.amount);
  const first = entries[0]!;
  const openingBalance = first.balance - signed(first);
  const gaps: SuicaReconcileGap[] = [];
  let running = openingBalance;
  let net = 0;
  for (const e of entries) {
    const expected = running + signed(e);
    if (expected !== e.balance) {
      gaps.push({
        date: e.date,
        content: e.content,
        expectedBalance: expected,
        actualBalance: e.balance,
      });
    }
    running = e.balance;
    net += signed(e);
  }
  const expectedClosing = openingBalance + net;
  const actualClosing = entries[entries.length - 1]!.balance;
  return {
    count: entries.length,
    openingBalance,
    net,
    expectedClosing,
    actualClosing,
    difference: actualClosing - expectedClosing,
    gaps,
  };
}
