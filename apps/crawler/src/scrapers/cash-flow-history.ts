import { getJstDateParts } from "@mf-dashboard/date-utils";
import type { CashFlowSummary, CashFlowItem } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Locator, Page } from "playwright";
import { getHistoryMonth } from "../history-months.js";
import { log, debug } from "../logger.js";
import { parseJapaneseNumber, convertDateToIso } from "../parsers.js";
import type { CashFlowHistoryResult } from "../types.js";

// Column indices for #cf-detail-table
// 計算対象 | 日付 | 内容 | 金額 | 保有金融機関 | 大項目 | 中項目 | メモ | 振替 | 削除
const DETAIL_COLUMNS = {
  DATE: 1,
  DESCRIPTION: 2,
  AMOUNT: 3,
  ACCOUNT: 4,
  CATEGORY: 5,
  SUB_CATEGORY: 6,
} as const;

// Column indices for #monthly_total_table_kakeibo
export const SUMMARY_COLUMNS = { INCOME: 0, EXPENSE: 2, BALANCE: 4 } as const;

/**
 * `#cf-detail-table` の 1 セルを、ページ内で 1 度だけ読み取ったスナップショット。
 * セル単位の要素参照を持たないため、表の再描画で内容が失われることがない。
 */
export type CashFlowDetailCell = {
  text: string;
  html: string;
  className: string | null;
  style: string | null;
  hasTransferBox: boolean;
  transferBoxText: string | null;
  noformSpanText: string | null;
};

/**
 * `#cf-detail-table` の 1 行分のスナップショット。
 * `cells` は `undefined` を含みうる（セルが描画されていない行を表現するため）。
 */
export type CashFlowDetailRow = {
  id: string | null;
  className: string | null;
  cells: (CashFlowDetailCell | undefined)[];
};

const TEXT_TIMEOUT = 1000;
const SUMMARY_TIMEOUT = 3000;
const CASH_FLOW_FETCH_TIMEOUT = 30_000;
const CASH_FLOW_AJAX_STATE = "__mfDashboardCashFlowAjax";
const CASH_FLOW_AMOUNT_PATTERN =
  /^(?:(?:[+\-−▲][¥$]?)|(?:[¥$][+\-−▲]?))?(?:\d{1,3}(?:,\d{3})+|\d+)(?:円)?$/;

function incompleteCashFlowRow(fields: string[]): Error {
  return new Error(`Incomplete cash flow transaction row (${fields.join(", ")})`);
}

export function isSupportedCashFlowAmount(value: string): boolean {
  const normalized = value.replace(/\s/g, "").replace(/\(振替\)$/, "");
  return CASH_FLOW_AMOUNT_PATTERN.test(normalized);
}

export async function verifyCashFlowRowsComplete(
  page: Page,
  detailCount: number,
  totals: readonly number[],
): Promise<void> {
  if (detailCount > 0) return;

  const hasCsvLink = (await page.locator("a[href*='/cf/csv']").count()) > 0;
  if (hasCsvLink || totals.some((total) => total !== 0)) {
    throw new Error("Could not verify an explicit empty cash flow period");
  }
}

export function parseCashFlowMonthHeader(headerText: string | null): string | null {
  const match =
    headerText?.match(/(\d{4})年(\d{1,2})月/) ??
    headerText?.match(/\d{4}\/\d{1,2}\/\d{1,2}\s*-\s*(\d{4})\/(\d{1,2})\/\d{1,2}/);
  if (!match) return null;

  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

export function parseCashFlowMonthCsvHref(href: string | null): string | null {
  const year = href?.match(/[?&]year=(\d{4})/)?.[1];
  const month = Number(href?.match(/[?&]month=(\d{1,2})/)?.[1]);
  if (!year || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function waitForCashFlowFetchApplied(
  page: Page,
  navigate: () => Promise<void>,
): Promise<void> {
  await page.evaluate((stateKey) => {
    type AjaxSettings = { url?: string };
    type AjaxHandler = (event: unknown, xhr: unknown, settings: AjaxSettings) => void;
    type JQueryTarget = {
      on: (eventName: string, handler: AjaxHandler) => void;
      off: (eventName: string, handler: AjaxHandler) => void;
    };
    type JQueryFactory = (target: Document) => JQueryTarget;

    const jquery = Reflect.get(window, "jQuery") as JQueryFactory | undefined;
    if (!jquery) throw new Error("Cash flow AJAX lifecycle is unavailable");

    const target = jquery(document);
    const state = { completed: false, target, handler: null as AjaxHandler | null };
    state.handler = (_event, _xhr, settings) => {
      if (settings.url?.includes("/cf/fetch")) {
        state.completed = true;
        target.off("ajaxComplete.mfDashboardCashFlow", state.handler!);
      }
    };
    target.on("ajaxComplete.mfDashboardCashFlow", state.handler);
    Reflect.set(window, stateKey, state);
  }, CASH_FLOW_AJAX_STATE);

  try {
    await navigate();
    await page.waitForFunction(
      (stateKey) => Reflect.get(window, stateKey)?.completed === true,
      CASH_FLOW_AJAX_STATE,
    );
  } finally {
    await page
      .evaluate((stateKey) => {
        const state = Reflect.get(window, stateKey);
        if (state?.handler) {
          state.target.off("ajaxComplete.mfDashboardCashFlow", state.handler);
        }
        Reflect.deleteProperty(window, stateKey);
      }, CASH_FLOW_AJAX_STATE)
      .catch(() => undefined);
  }
}

/**
 * 明細テーブルを 1 回の `page.evaluate` でスナップショットとして読み取る。
 *
 * 行ごと・セルごとに locator で読むと、明細が多い月では表の再描画と競合し、
 * DOM から外れた要素を読んで全セルが空として観測される。その結果
 * `Incomplete cash flow transaction row` で月次抽出が落ちたり、逆に不完全な
 * 月次結果で置換してしまう。1 往復で同期的に読み切ることでこの競合を排除する。
 */
export async function readCashFlowDetailRows(page: Page): Promise<CashFlowDetailRow[]> {
  return page.evaluate((): CashFlowDetailRow[] => {
    const table = document.querySelector("#cf-detail-table");
    if (!table) throw new Error("Cash flow detail table is unavailable");

    return Array.from(table.querySelectorAll("tbody > tr")).map((row) => ({
      id: row.getAttribute("id"),
      className: row.getAttribute("class"),
      cells: Array.from(row.querySelectorAll(":scope > td")).map((cell) => {
        const transferBox = cell.querySelector(".transfer_account_box");
        const noformSpan = cell.querySelector("div.noform span");
        return {
          text: (cell.textContent ?? "").trim(),
          html: cell.innerHTML,
          className: cell.getAttribute("class"),
          style: cell.getAttribute("style"),
          hasTransferBox: transferBox !== null,
          transferBoxText: transferBox ? (transferBox.textContent ?? "").trim() : null,
          noformSpanText: noformSpan ? (noformSpan.textContent ?? "").trim() : null,
        };
      }),
    }));
  });
}

async function getTextWithFailureSignal(
  locator: Locator,
  timeout = TEXT_TIMEOUT,
): Promise<string | null> {
  try {
    return (await locator.textContent({ timeout }))?.trim() ?? "";
  } catch {
    return null;
  }
}

async function getOptionalText(locator: Locator, timeout = TEXT_TIMEOUT): Promise<string | null> {
  if ((await locator.count()) === 0) return null;
  const text = await locator.first().textContent({ timeout });
  return text?.trim() ?? "";
}

async function getOptionalAttribute(locator: Locator, name: string): Promise<string | null> {
  if ((await locator.count()) === 0) return null;
  return locator.first().getAttribute(name);
}

function parseAccountCell(accountCell: CashFlowDetailCell | undefined): {
  accountFrom?: string;
  accountTo?: string;
  hasTransferBox: boolean;
} {
  if (!accountCell) throw incompleteCashFlowRow(["account"]);

  if (accountCell.hasTransferBox) {
    const toText = accountCell.transferBoxText ?? "";
    const accountFrom = accountCell.text.replace(toText, "").trim();
    return {
      hasTransferBox: true,
      accountFrom: accountFrom || undefined,
      accountTo: toText || undefined,
    };
  }

  const accountFrom = accountCell.noformSpanText ?? accountCell.text;
  return {
    hasTransferBox: false,
    accountFrom: accountFrom || undefined,
    accountTo: undefined,
  };
}

/**
 * ページから表示中の月を検出する
 */
function toIsoDate(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function resolveCashFlowPeriod(
  headerText: string | null,
  month: string,
): { periodStart: string; periodEnd: string } {
  const rangeMatch = headerText?.match(
    /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/,
  );
  if (rangeMatch) {
    const periodStart = toIsoDate(rangeMatch[1], rangeMatch[2], rangeMatch[3]);
    const periodEnd = toIsoDate(rangeMatch[4], rangeMatch[5], rangeMatch[6]);
    if (periodStart && periodEnd && periodStart <= periodEnd) return { periodStart, periodEnd };
  }

  const range = buildMonthRange(month);
  return { periodStart: range.from.replaceAll("/", "-"), periodEnd: range.to.replaceAll("/", "-") };
}

export function resolveCashFlowDate(
  dateText: string,
  fallbackYear: number,
  period?: { periodStart: string; periodEnd: string },
): string {
  if (period) {
    const candidateYears = new Set([
      Number(period.periodStart.slice(0, 4)),
      Number(period.periodEnd.slice(0, 4)),
      fallbackYear,
    ]);
    for (const year of candidateYears) {
      const candidate = convertDateToIso(dateText, year);
      if (candidate >= period.periodStart && candidate <= period.periodEnd) return candidate;
    }
  }
  return convertDateToIso(dateText, fallbackYear);
}

async function detectMonth(
  page: Page,
): Promise<{ month: string; periodStart: string; periodEnd: string }> {
  const today = getJstDateParts();
  let year = today.year;
  let month = today.month;

  const headerTitle = await getOptionalText(page.locator(".fc-header-title h2"), SUMMARY_TIMEOUT);

  // Prefer the CSV period because range headers can start in the previous calendar month.
  const csvLink = await getOptionalAttribute(page.locator("a[href*='/cf/csv']").first(), "href");
  const csvMonth = parseCashFlowMonthCsvHref(csvLink);
  if (csvMonth) {
    return { month: csvMonth, ...resolveCashFlowPeriod(headerTitle, csvMonth) };
  }

  const headerMonth = parseCashFlowMonthHeader(headerTitle);
  if (headerMonth) {
    return { month: headerMonth, ...resolveCashFlowPeriod(headerTitle, headerMonth) };
  }

  const pageText = await getOptionalText(
    page.locator(".heading-small, .month-title, [class*='month']").first(),
  );
  const match = pageText?.match(/(\d{4})年(\d{1,2})月/) || pageText?.match(/(\d{4})\/(\d{1,2})/);

  if (match) {
    year = parseInt(match[1]);
    month = parseInt(match[2]);
  }

  const detectedMonth = `${year}-${String(month).padStart(2, "0")}`;
  return { month: detectedMonth, ...resolveCashFlowPeriod(headerTitle, detectedMonth) };
}

/**
 * 金額セルからタイプ（収入/支出/振替）を判定
 */
function detectTransactionType(
  amountCell: CashFlowDetailCell | undefined,
  categoryText: string,
): "income" | "expense" | "transfer" {
  if (categoryText === "") return "transfer";

  const amountClass = amountCell?.className ?? "";
  const amountStyle = amountCell?.style ?? "";
  const amountHtml = amountCell?.html ?? "";

  const isIncome =
    amountClass.includes("plus") ||
    amountClass.includes("income") ||
    amountClass.includes("blue") ||
    amountStyle.includes("blue") ||
    amountHtml.includes("plus") ||
    (amountHtml.includes("color") && amountHtml.includes("blue"));

  return isIncome ? "income" : "expense";
}

/**
 * 詳細行のスナップショットから取引データをパース
 */
export function parseDetailRow(
  row: CashFlowDetailRow,
  year: number,
  period?: { periodStart: string; periodEnd: string },
): CashFlowItem {
  const cellText = (index: number): string | null => row.cells[index]?.text ?? null;

  const mfId = row.id?.startsWith("js-transaction-") ? row.id.slice("js-transaction-".length) : "";
  const dateText = cellText(DETAIL_COLUMNS.DATE) ?? "";
  const description = cellText(DETAIL_COLUMNS.DESCRIPTION);
  const amountText = cellText(DETAIL_COLUMNS.AMOUNT) ?? "";
  const date = resolveCashFlowDate(dateText, year, period);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const isValidDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === date;

  // A monthly replacement is safe only when every rendered transaction row was extracted.
  const incompleteFields = [
    !mfId ? "id" : null,
    row.className === null ? "class" : null,
    !isValidDate ? "date" : null,
    description === null ? "description" : null,
    !isSupportedCashFlowAmount(amountText) ? "amount" : null,
  ].filter((field): field is string => field !== null);
  if (incompleteFields.length > 0) {
    // どのセルが欠けているかを診断できるよう、行の構造を併記する。
    throw incompleteCashFlowRow([...incompleteFields, `cells=${row.cells.length}`]);
  }

  const categoryText = cellText(DETAIL_COLUMNS.CATEGORY);
  const subCategoryText = cellText(DETAIL_COLUMNS.SUB_CATEGORY);

  if (categoryText === null || subCategoryText === null) {
    throw incompleteCashFlowRow(["category"]);
  }

  const { accountFrom, accountTo, hasTransferBox } = parseAccountCell(
    row.cells[DETAIL_COLUMNS.ACCOUNT],
  );

  const isExcludedFromCalculation = (row.className ?? "").includes("mf-grayout");

  const type = detectTransactionType(row.cells[DETAIL_COLUMNS.AMOUNT], categoryText);
  const isTransfer = type === "transfer";

  let accountName: string | undefined;
  let transferTarget: string | undefined;

  if (hasTransferBox) {
    // 振替の場合、下段（transfer_account_box）がこのトランザクションの所有者
    // 上段が振替相手先（送金元/送金先）
    accountName = accountTo || undefined;
    transferTarget = accountFrom || undefined;
  } else if (isTransfer && accountFrom && !accountFrom.includes("口座")) {
    transferTarget = accountFrom;
  } else if (accountFrom) {
    accountName = accountFrom;
  }

  return {
    mfId,
    date,
    category: categoryText || null,
    subCategory: subCategoryText || null,
    description: description ?? "",
    amount: Math.abs(parseJapaneseNumber(amountText)),
    type,
    isTransfer,
    isExcludedFromCalculation,
    transferTarget,
    accountName,
  };
}

/**
 * 現在表示中のページから家計簿データを取得
 */
export async function extractCashFlowFromPage(
  page: Page,
  displayedPeriod?: { month: string; periodStart: string; periodEnd: string },
): Promise<CashFlowSummary> {
  const { month, periodStart, periodEnd } = displayedPeriod ?? (await detectMonth(page));
  const year = Number(month.slice(0, 4));
  debug(`  Extracting data for ${month}...`);

  // Get totals from summary table (並列取得)
  const summaryRow = page.locator("#monthly_total_table_kakeibo tbody tr").first();
  const summaryCells = summaryRow.locator("td");

  const [incomeText, expenseText, balanceText] = await Promise.all([
    getTextWithFailureSignal(summaryCells.nth(SUMMARY_COLUMNS.INCOME), SUMMARY_TIMEOUT),
    getTextWithFailureSignal(summaryCells.nth(SUMMARY_COLUMNS.EXPENSE), SUMMARY_TIMEOUT),
    getTextWithFailureSignal(summaryCells.nth(SUMMARY_COLUMNS.BALANCE), SUMMARY_TIMEOUT),
  ]);

  if (
    incomeText === null ||
    expenseText === null ||
    balanceText === null ||
    ![incomeText, expenseText, balanceText].every(isSupportedCashFlowAmount)
  ) {
    throw new Error("Could not verify the complete cash flow summary");
  }

  const totalIncome = parseJapaneseNumber(incomeText || "0");
  const totalExpense = parseJapaneseNumber(expenseText || "0");
  const balance = parseJapaneseNumber(balanceText || "0");

  // Parse detail items
  // 表の再描画と競合しないよう、行数ぶんのスナップショットを 1 往復で読み切ってから解析する。
  const detailRows = await readCashFlowDetailRows(page);
  await verifyCashFlowRowsComplete(page, detailRows.length, [totalIncome, totalExpense, balance]);
  const items = detailRows.map((row) => parseDetailRow(row, year, { periodStart, periodEnd }));

  return {
    month,
    periodStart,
    periodEnd,
    isComplete: true,
    totalIncome,
    totalExpense,
    balance,
    items,
  };
}

export function buildMonthRange(month: string): { from: string; to: string } {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText);
  const lastDay = new Date(year, monthIndex, 0).getDate();

  return {
    from: `${yearText}/${monthText}/01`,
    to: `${yearText}/${monthText}/${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * CSV linkから現在表示中の月を取得
 */
async function getMonthFromCsvLink(page: Page): Promise<string | null> {
  const csvLink = await getOptionalAttribute(page.locator("a[href*='/cf/csv']").first(), "href");
  return parseCashFlowMonthCsvHref(csvLink);
}

async function getDisplayedCashFlowMonth(page: Page): Promise<string> {
  const csvMonth = await getMonthFromCsvLink(page);
  if (csvMonth) return csvMonth;
  return (await detectMonth(page)).month;
}

const MONTH_BUTTON_SELECTORS = {
  previous: "button.fc-button-prev, span.fc-button-prev",
  next: "button.fc-button-next, span.fc-button-next",
} as const;

async function stepCashFlowMonth(
  page: Page,
  direction: keyof typeof MONTH_BUTTON_SELECTORS,
): Promise<boolean> {
  const currentMonth = await getDisplayedCashFlowMonth(page);
  const prevButton = page.locator(MONTH_BUTTON_SELECTORS[direction]).first();
  await waitForCashFlowFetchApplied(page, async () => {
    const [fetchResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/cf/fetch") && res.status() === 200, {
        timeout: CASH_FLOW_FETCH_TIMEOUT,
      }),
      prevButton.click(),
    ]);
    const responseFailure = await fetchResponse.finished();
    if (responseFailure) throw responseFailure;
  });
  const newMonth = await getDisplayedCashFlowMonth(page);
  if (newMonth === currentMonth) {
    log(`  No more months available after ${currentMonth}, stopping.`);
    return false;
  }
  return true;
}

function goToPreviousCashFlowMonth(page: Page): Promise<boolean> {
  return stepCashFlowMonth(page, "previous");
}

/**
 * 既に開いている /cf を再利用できるか。明細テーブルが見えていれば、
 * 開き直さずに表示中の月から前月・翌月ボタンで移動できる。
 */
async function isCashFlowPageOpen(page: Page): Promise<boolean> {
  try {
    if (new URL(page.url()).pathname !== new URL(mfUrls.cashFlow).pathname) return false;
    return await page.locator("#cf-detail-table").first().isVisible();
  } catch {
    return false;
  }
}

async function openCashFlowPage(page: Page): Promise<void> {
  await page.goto(mfUrls.cashFlow, { waitUntil: "domcontentloaded" });
  // テーブルが表示されるまで待機
  await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 10000 });
}

async function navigateToCashFlowMonth(page: Page, month: string): Promise<void> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Invalid target cash flow month");
  }
  let displayedMonth = await getDisplayedCashFlowMonth(page);
  while (displayedMonth !== month) {
    const direction = displayedMonth > month ? "previous" : "next";
    if (!(await stepCashFlowMonth(page, direction))) {
      throw new Error(`MoneyForward does not have cash flow data for ${month}`);
    }
    displayedMonth = await getDisplayedCashFlowMonth(page);
  }
  if (displayedMonth !== month) {
    throw new Error(`MoneyForward does not have cash flow data for ${month}`);
  }
}

/**
 * 指定した月の明細が表示されるまで月送りする。
 * /cf が開いていれば表示中の月から前月・翌月へ移動し、開き直して当月から
 * 戻る往復（過去の月ほど数十回のクリック）を避ける。
 */
export async function goToCashFlowMonth(page: Page, month: string): Promise<void> {
  if (!(await isCashFlowPageOpen(page))) await openCashFlowPage(page);
  await navigateToCashFlowMonth(page, month);
}

/**
 * 過去N月分の家計簿データを取得
 * UIの前月ボタンをクリックして月を切り替えながら取得
 */
export async function scrapeCashFlowHistory(
  page: Page,
  monthsToScrape: number = 12,
  callbacks: {
    onMonthStart?: (month: string) => Promise<void> | void;
    onMonthComplete?: (month: string) => Promise<void> | void;
    onMonthFailure?: (month: string, error: unknown) => Promise<void> | void;
    targetMonth?: string;
  } = {},
): Promise<CashFlowHistoryResult[]> {
  log(`Scraping cash flow history for ${monthsToScrape} months...`);

  await openCashFlowPage(page);

  if (callbacks.targetMonth) {
    await navigateToCashFlowMonth(page, callbacks.targetMonth);
    monthsToScrape = 1;
  }

  const results: CashFlowHistoryResult[] = [];

  for (let i = 0; i < monthsToScrape; i++) {
    const targetMonth = await getDisplayedCashFlowMonth(page).catch(() =>
      getHistoryMonth(new Date(), i),
    );
    await callbacks.onMonthStart?.(targetMonth);
    try {
      const data = await extractCashFlowFromPage(page);
      results.push({ month: data.month, progressMonth: targetMonth, data });
      log(`  ${data.month}: ${data.items.length} transactions`);

      if (i < monthsToScrape - 1) {
        if (!(await goToPreviousCashFlowMonth(page))) {
          await callbacks.onMonthComplete?.(targetMonth);
          break;
        }
      }
      await callbacks.onMonthComplete?.(targetMonth);
    } catch (error) {
      await callbacks.onMonthFailure?.(targetMonth, error);
      throw error;
    }
  }

  return results;
}
