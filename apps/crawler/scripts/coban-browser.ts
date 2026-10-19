/**
 * pixivcoban 用の永続ブラウザ基盤。
 *
 * mf-browser.ts / suica-browser.ts と同じ方針:
 *  - ブラウザは 1 つだけ起動しっぱなしにする（毎回 launch/close しない）
 *  - 既定は headless（コンテナ実行用）。ローカルで画面を見たいときは HEADED=1
 *  - 起動時に `--remote-debugging-port=9226` を開き、以降のスクリプトは CDP で接続して再利用
 *  - pixiv のセッションは永続プロファイル（data/coban-browser-profile）に保存される
 *
 * 起動: npx tsx --env-file=../../.env scripts/coban-browser.ts   （バックグラウンドで常駐）
 */
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
export const PROFILE_DIR = path.resolve(projectRoot, "data/coban-browser-profile");
export const CDP_URL = process.env.COBAN_CDP_URL ?? "http://127.0.0.1:9226";
export const DEBUG_PORT = 9226;

export const BASE_URL = "https://coban.pixiv.net";
const START_URL = process.env.COBAN_START_URL ?? `${BASE_URL}/`;

/** 起動済みブラウザに CDP で接続する */
export async function connectCobanBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP にコンテキストがありません");
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/** 永続ブラウザを起動する。 */
export async function launchCobanBrowser(): Promise<{ context: BrowserContext; page: Page }> {
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

/** 既存ブラウザがあれば再利用、なければ起動する。external=true のときは close してはいけない。 */
export async function getCobanPage(): Promise<{
  context: BrowserContext;
  page: Page;
  external: boolean;
}> {
  try {
    const { context, page } = await connectCobanBrowser();
    return { context, page, external: true };
  } catch {
    const { context, page } = await launchCobanBrowser();
    await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    return { context, page, external: false };
  }
}

async function main() {
  process.env.HEADED ??= "1";
  const { context, page } = await launchCobanBrowser();
  console.log(`永続ブラウザ起動: profile=${PROFILE_DIR}`);
  console.log(`CDP: ${CDP_URL}`);

  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(`pixivcoban を表示: ${page.url()}`);
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
