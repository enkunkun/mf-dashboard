/**
 * MF 用の永続ブラウザ基盤。
 *
 * 方針:
 *  - ブラウザは 1 つだけ起動しっぱなしにする（毎回 launch/close しないので画面がチラつかない）
 *  - 起動時に `--remote-debugging-port=9222` を開き、以降のスクリプトは CDP で接続して再利用する
 *  - MF のセッションは永続プロファイル（data/mf-browser-profile）に保存される
 *
 * 起動: npx tsx --env-file=../../.env scripts/mf-browser.ts   （バックグラウンドで常駐）
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "../../../..");
export const PROFILE_DIR = path.resolve(projectRoot, "data/mf-browser-profile");
const STATE_PATH = path.resolve(projectRoot, "data/auth-state.json");
export const CDP_URL = process.env.MF_CDP_URL ?? "http://127.0.0.1:9222";
export const DEBUG_PORT = 9222;

/** 永続ブラウザを起動する（既に起動済みなら CDP 接続を試す） */
export async function launchPersistentBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--disable-blink-features=AutomationControlled",
    ],
  });

  // 初回は auth-state.json の cookie を注入して MF セッションを引き継ぐ
  if (fs.existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { cookies?: unknown[] };
      if (Array.isArray(state.cookies) && state.cookies.length > 0) {
        // @ts-expect-error playwright の Cookie 型に合わせる
        await context.addCookies(state.cookies);
      }
    } catch {
      /* ignore */
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/** 起動済みブラウザに CDP で接続する */
export async function connectBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP にコンテキストがありません");
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}

/**
 * 既存ブラウザがあれば再利用、なければ起動する。
 * external=true のときは close してはいけない（常駐ブラウザを閉じてしまうため）。
 */
export async function getMFPage(): Promise<{
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  external: boolean;
}> {
  try {
    const { browser, context, page } = await connectBrowser();
    return { browser, context, page, external: true };
  } catch {
    const { context, page } = await launchPersistentBrowser();
    return { context, page, external: false };
  }
}

/**
 * /cf を開き、表示月を必ず「今月」に戻す。
 * スクレイパーは「表示中の月から遡る」実装なので、これをやらないと
 * 常駐ブラウザに残った過去月から遡ってしまう事故が起きる。
 */
export async function openCashFlowAtCurrentMonth(page: Page): Promise<void> {
  await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
  await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(1500);
  const today = page.locator("button.fc-button-today").first();
  if ((await today.count()) > 0) {
    await Promise.all([
      page
        .waitForResponse((r) => r.url().includes("/cf/fetch") && r.status() === 200)
        .catch(() => null),
      today.click(),
    ]);
    await page.waitForTimeout(1800);
  }
}
