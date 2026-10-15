/**
 * モバイルSuica 用の永続ブラウザ基盤。
 *
 * mf-browser.ts と同じ方針:
 *  - ブラウザは 1 つだけ起動しっぱなしにする（毎回 launch/close しない）
 *  - `--remote-debugging-port=9223` を開き、以降のスクリプトは CDP で接続して再利用する
 *  - Suica のセッションは永続プロファイル（data/suica-profile）に保存される
 *
 * 起動: npx tsx scripts/suica-browser.ts   （バックグラウンドで常駐）
 */
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
export const PROFILE_DIR = path.resolve(projectRoot, "data/suica-profile");
export const CDP_URL = process.env.SUICA_CDP_URL ?? "http://127.0.0.1:9223";
export const DEBUG_PORT = 9223;

const START_URL = process.env.SUICA_START_URL ?? "https://www.mobilesuica.com/";

/** 起動済みブラウザに CDP で接続する */
export async function connectSuicaBrowser(): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP にコンテキストがありません");
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/**
 * 永続ブラウザを起動する。
 * 既定は headless（コンテナ実行用）。ローカルで画面を見たいときは HEADED=1 を付ける。
 * Chrome 固有機能は使わないので Playwright 同梱の Chromium で動かす。
 */
export async function launchSuicaBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const headless = !process.env.HEADED;
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/**
 * 既存ブラウザがあれば再利用、なければ起動する。
 * 常駐ブラウザを閉じてしまう事故を防ぐため、external=true のときは close してはいけない。
 */
export async function getSuicaPage(): Promise<{
  context: BrowserContext;
  page: Page;
  external: boolean;
}> {
  try {
    const { context, page } = await connectSuicaBrowser();
    return { context, page, external: true };
  } catch {
    const { context, page } = await launchSuicaBrowser();
    await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    return { context, page, external: false };
  }
}

async function main() {
  // 常駐ブラウザとして手元で使う想定なので、既定は画面あり
  process.env.HEADED ??= "1";
  const { context, page } = await launchSuicaBrowser();
  console.log(`永続ブラウザ起動: profile=${PROFILE_DIR}`);
  console.log(`CDP: ${CDP_URL}`);

  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(`モバイルSuica ログインページを表示: ${page.url()}`);
  console.log("このプロセスは常駐します（Ctrl+C で終了）。");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await context.close();
}

// 直接実行されたときだけ起動する（import 時は何もしない）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("error:", err);
    process.exit(1);
  });
}
