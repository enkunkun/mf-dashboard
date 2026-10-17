import type { Locator, Page } from "playwright";

/**
 * Money Forward ページから CSRF トークンを取得する
 */
export async function getCsrfToken(page: Page): Promise<string | null> {
  const token = await page
    .locator("meta[name='csrf-token']")
    .getAttribute("content")
    .catch(() => null);

  return token || null;
}

type CategoryUpdateOptions = {
  largeCategoryId: string;
  middleCategoryId: string;
  isIncome?: boolean;
  isTarget?: boolean;
};

const AMOUNT_FIELD = "user_asset_act[amount]";

/**
 * 行の編集フォームの全項目を土台に /cf/update の本文を作る。
 * 手入力行は金額・日付・内容・口座を送らないと MoneyForward が 0 円などで上書きするため、
 * カテゴリと計算対象以外はフォームの値をそのまま送る。
 */
export function buildCategoryUpdateBody(
  transactionId: string,
  rowFields: Record<string, string>,
  options: CategoryUpdateOptions,
): string {
  if (rowFields["user_asset_act[id]"] !== transactionId) {
    throw new Error("Transaction form id does not match the requested transaction");
  }

  const body = new URLSearchParams(rowFields);
  body.set("user_asset_act[large_category_id]", options.largeCategoryId);
  body.set("user_asset_act[middle_category_id]", options.middleCategoryId);
  body.set("user_asset_act[is_income]", options.isIncome ? "1" : "0");
  body.set("user_asset_act[is_target]", (options.isTarget ?? true) ? "1" : "0");
  const amount = rowFields[AMOUNT_FIELD];
  // フォームの表示値は "-5,338" の形。金額は絶対値で送り、収支は is_income で表す
  if (amount !== undefined) body.set(AMOUNT_FIELD, amount.replace(/[-,\s]/g, ""));
  return body.toString();
}

/**
 * 表示中の /cf の行の編集フォームの全項目を読む。
 * 行が表示されていなければ null。
 */
export async function readTransactionRowFields(
  page: Page,
  transactionId: string,
): Promise<Record<string, string> | null> {
  return await page.evaluate((id) => {
    const row = document.getElementById(`js-transaction-${id}`);
    if (!row) return null;
    const fields: Record<string, string> = {};
    // 同名の項目は後ろのもの（表示用の select など）を採る
    row
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name], select[name]")
      .forEach((element) => {
        fields[element.name] = element.value;
      });
    return fields;
  }, transactionId);
}

/** /cf/update を PUT で叩く */
export async function putCfUpdate(
  page: Page,
  csrfToken: string,
  body: string,
): Promise<{ ok: boolean; status: number }> {
  return page.evaluate(
    async ({ body, csrf }) => {
      const res = await fetch("/cf/update", {
        method: "PUT",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": csrf,
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      return { status: res.status, ok: res.ok };
    },
    { body, csrf: csrfToken },
  );
}

/**
 * トランザクションのカテゴリを更新する
 * 表示中の /cf の行から編集フォームを読み、/cf/update API を呼び出す。
 * 行が表示されていなければ、項目の欠けた本文で上書きしないよう何も送らない。
 */
export async function updateTransactionCategory(
  page: Page,
  csrfToken: string,
  transactionId: string,
  options: CategoryUpdateOptions,
): Promise<{ ok: boolean; status: number }> {
  const rowFields = await readTransactionRowFields(page, transactionId);
  if (!rowFields) return { ok: false, status: 0 };

  const body = buildCategoryUpdateBody(transactionId, rowFields, options);
  return putCfUpdate(page, csrfToken, body);
}

/**
 * CF ページのトランザクション行を取得する
 * 事前に /cf ページへ遷移済みであること
 */
export function getTransactionRows(page: Page): Locator {
  return page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
}

/**
 * トランザクション行から ID を取得する
 */
export async function getTransactionId(row: Locator): Promise<string | null> {
  const id = await row
    .locator("input[name='user_asset_act[id]']")
    .getAttribute("value")
    .catch(() => null);

  return id || null;
}
