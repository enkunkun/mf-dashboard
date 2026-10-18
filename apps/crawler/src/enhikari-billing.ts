import type { EnhikariAllocationConfig } from "./enhikari-allocation.js";

/**
 * enひかり電気の会員ページ（ご利用明細）の読み取り。
 *
 * ページは月ごとに
 *   <div class="panel panel-default charge-item">
 *     …<a href="#p_1">2026年9月分 enひかり電気料金合計(税込）
 *        <span class="total-price">17,051.<span class="down">66</span> 円</span></a>…
 * の形で過去 24 か月を並べる（スマホ用の同じ並びがもう 1 組ある）。
 */

/** 1 か月分の電気料金。month は明細の月（"2026-09" = 2026年9月分） */
export interface EnhikariCharge {
  month: string;
  /** 税込の合計。enひかり料金と合算したときに小数点以下が切り捨てられるため小数を持つ */
  total: number;
}

export function parseEnhikariChargeHistory(html: string): EnhikariCharge[] {
  // 金額は <span class="total-price">17,051.<span class="down">66</span> 円</span> の形。
  // 入れ子の span に入っていることもあるので、内側のタグを外してから数値にする。
  const pattern = /(\d{4})年(\d{1,2})月分.{0,160}?class="total-price">([\s\S]*?)<\/span>/g;
  const byMonth = new Map<string, number>();
  for (const match of html.matchAll(pattern)) {
    const [, year, month, rawTotal] = match;
    const cleaned = rawTotal!.replace(/<[^>]*>/g, "").replace(/[,円\s]|&nbsp;/g, "");
    const total = Number(cleaned);
    const key = `${year}-${month!.padStart(2, "0")}`;
    if (!Number.isFinite(total) || cleaned === "") {
      throw new Error(`${key} の料金を読めない: ${JSON.stringify(rawTotal)}`);
    }
    const known = byMonth.get(key);
    if (known !== undefined && known !== total) {
      throw new Error(`${key} の料金が複数ある: ${known} と ${total}`);
    }
    byMonth.set(key, total);
  }
  return [...byMonth].map(([month, total]) => ({ month, total }));
}

/** "YYYY-MM" を months か月ずらす */
export function shiftMonth(month: string, months: number): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + months, 1));
  return shifted.toISOString().slice(0, 7);
}

/**
 * 明細を按分ファイル（enhikari-alloc.ts が読む形）に変換する。
 *
 * カードの「光コラボ回収代行分」は明細の月よりあとに請求される。
 * 実測では明細月 + 2 か月のカード明細に対応した（2025-09 分 → 2025-11-24 の請求）。
 */
export function toAllocationConfig(params: {
  charges: EnhikariCharge[];
  offsetMonths: number;
  match: EnhikariAllocationConfig["match"];
  electricityCategory: EnhikariAllocationConfig["electricityCategory"];
  internetCategory: EnhikariAllocationConfig["internetCategory"];
  /** この明細月以降だけ入れる（"2025-09" など） */
  from?: string;
}): EnhikariAllocationConfig {
  const electricityByMonth: Record<string, number> = {};
  for (const charge of [...params.charges].sort((a, b) => a.month.localeCompare(b.month))) {
    if (params.from && charge.month < params.from) continue;
    const key = shiftMonth(charge.month, params.offsetMonths);
    electricityByMonth[key] = Math.round(charge.total);
  }
  return {
    match: params.match,
    electricityCategory: params.electricityCategory,
    internetCategory: params.internetCategory,
    electricityByMonth,
  };
}
