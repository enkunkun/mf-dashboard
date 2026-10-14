import { loginWithAuthState } from "../src/auth/login.js";
/**
 * 永続ブラウザを起動して常駐させる（画面チラつき防止 & CDP デバッグ用）。
 * このプロセスが生きている間ブラウザは開いたままになる。
 *
 * 実行: npx tsx --env-file=../../.env scripts/mf-browser.ts
 */
import { CDP_URL, launchPersistentBrowser, PROFILE_DIR } from "./lib/mf-browser.js";

async function main() {
  const { context, page } = await launchPersistentBrowser();
  console.log(`永続ブラウザ起動: profile=${PROFILE_DIR}`);
  console.log(`CDP: ${CDP_URL}`);

  await loginWithAuthState(page, context);
  await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log("MF にログイン済み・/cf を表示。このプロセスは常駐します（Ctrl+C で終了）。");

  // 常駐（終了しない）
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await context.close();
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
