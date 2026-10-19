/**
 * pixivcoban の API 呼び出し（coban.pixiv.net 上の Cookie セッションを利用）。
 *
 * browser の page から同一オリジンの fetch を叩く。詳細は debug/coban-api-notes.md を参照。
 */
import type { Page } from "playwright";
import type { CobanBalance, CobanHistory, CobanHistoryEntry } from "../../src/scrapers/coban.js";

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { accept: "application/json" } });
    return { ok: r.ok, status: r.status, text: await r.text() };
  }, path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text) as T;
}

export async function fetchBalance(page: Page): Promise<CobanBalance> {
  return getJson<CobanBalance>(page, "/api/v1/balance");
}

/** 履歴が遡れる開始日時（ISO 8601）。 */
export async function fetchHistoryStartedAt(page: Page): Promise<string> {
  const res = await getJson<{ history_started_at: string }>(page, "/api/v1/history/started_at");
  return res.history_started_at;
}

/** YYYY-MM を指定して 1 か月分の履歴を取得する。 */
export async function fetchMonthHistory(page: Page, month: string): Promise<CobanHistoryEntry[]> {
  const res = await getJson<CobanHistory>(page, `/api/v1/history/${month}`);
  return res.histories ?? [];
}

/** "YYYY-MM" の一覧を from 〜 to（両端含む）で返す。 */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** 指定範囲の全履歴をまとめて取得する（古い順）。 */
export async function fetchHistories(
  page: Page,
  fromMonth: string,
  toMonth: string,
): Promise<CobanHistoryEntry[]> {
  const all: CobanHistoryEntry[] = [];
  for (const month of monthsBetween(fromMonth, toMonth)) {
    const entries = await fetchMonthHistory(page, month);
    if (entries.length > 0) console.log(`  ${month}: ${entries.length} 件`);
    all.push(...entries);
  }
  return all;
}
