/**
 * ファミペイ用の永続ブラウザ基盤。
 *
 * mf-browser.ts / suica-browser.ts と同じ方針:
 *  - ブラウザは 1 つだけ起動しっぱなしにする（毎回 launch/close しない）
 *  - `--remote-debugging-port=9224` を開き、以降のスクリプトは CDP で接続して再利用する
 *  - ログイン状態は永続プロファイル（data/famipay-profile）に残る
 *
 * ファミペイの Web ログインは「毎回 SMS のワンタイムコードを人が入力する」前提なので、
 * 調査やログインは常駐ブラウザを 1 つ開いて可変に操作する。画面を見ながら
 * DOM を確認し、失敗したらその場で直して再実行する。
 *
 * 起動: npx tsx scripts/famipay-browser.ts   （バックグラウンドで常駐）
 */
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { FAMIPAY_LOGIN_URL, FAMIPAY_WEBVIEW_USER_AGENT } from "../src/famipay.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
export const PROFILE_DIR = path.resolve(projectRoot, "data/famipay-profile");
export const CDP_URL = process.env.FAMIPAY_CDP_URL ?? "http://127.0.0.1:9224";
export const DEBUG_PORT = 9224;
export const START_URL = FAMIPAY_LOGIN_URL;

/** 起動済みブラウザに CDP で接続する。 */
export async function connectFamipayBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP にコンテキストがありません");
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/**
 * 永続ブラウザを起動する。
 * 既定は画面あり（SMS コードの入力と DOM 調査を人が行うため）。HEADLESS=1 でヘッドレス。
 */
export async function launchFamipayBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const headless = process.env.HEADLESS === "1";
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: headless ? { width: 430, height: 900 } : null,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: FAMIPAY_WEBVIEW_USER_AGENT,
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/**
 * 常駐ブラウザがあれば再利用し、無ければ起動する。
 * 常駐ブラウザを閉じてしまう事故を防ぐため、external=true のときは close してはいけない。
 */
export async function getFamipayPage(): Promise<{
  context: BrowserContext;
  page: Page;
  external: boolean;
}> {
  try {
    const { context, page } = await connectFamipayBrowser();
    return { context, page, external: true };
  } catch {
    const { context, page } = await launchFamipayBrowser();
    await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    return { context, page, external: false };
  }
}

/** ページの読み込みが落ち着くまで待ち、URL とタイトルを返す。 */
export async function describePage(page: Page): Promise<{ url: string; title: string }> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);
  return { url: page.url(), title: await page.title().catch(() => "") };
}

async function main(): Promise<void> {
  const { context, page } = await launchFamipayBrowser();
  console.log(`永続ブラウザ起動: profile=${PROFILE_DIR}`);
  console.log(`CDP: ${CDP_URL}`);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  const described = await describePage(page);
  console.log(`ファミペイ ログインページ: ${described.url} (${described.title})`);
  console.log("このプロセスは常駐します（Ctrl+C で終了）。");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await context.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("error:", err);
    process.exit(1);
  });
}
