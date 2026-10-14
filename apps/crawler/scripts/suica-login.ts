import { loginWithPasskey } from "./lib/suica-auth.js";
/**
 * JRE ID パスキー自動ログインの確認用エントリ。
 * ログイン処理は scripts/lib/suica-auth.ts に集約している。
 *
 * 実行:
 *   npx tsx scripts/suica-login.ts                     # ~/Downloads の最新 bitwarden_export_*.json を使用
 *   npx tsx scripts/suica-login.ts --export /path/to.json
 */
import { connectSuicaBrowser } from "./suica-browser.js";

async function main() {
  const { page, context } = await connectSuicaBrowser();
  await loginWithPasskey(page, context);
  const loggedIn = /ログアウト/.test(await page.evaluate(() => document.body.innerText));
  console.log(`ログイン${loggedIn ? "済み" : "失敗"}: ${page.url()}`);
  process.exit(loggedIn ? 0 : 1);
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
