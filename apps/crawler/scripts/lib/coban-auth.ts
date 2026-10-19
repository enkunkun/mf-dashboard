/**
 * pixivcoban へのログイン（pixiv アカウント）を自動化する。
 *
 * flow:
 *   coban.pixiv.net「pixivアカウントでログインする」
 *     → accounts.pixiv.net/login（メール + パスワード → ログイン）
 *     → coban.pixiv.net へ戻る
 *
 * 認証情報は環境変数 `COBAN_USERNAME`/`COBAN_PASSWORD`、または 1Password
 * （`OP_VAULT` / `OP_COBAN_ITEM`。既定アイテム名は未設定）から取得する。
 * セッションは永続プロファイルに保存されるため、通常は再ログイン不要。
 */
import type { Page } from "playwright";
import { getOpClient } from "../../src/auth/op-client.js";
import { BASE_URL } from "../coban-browser.js";

const LOGIN_BUTTON = 'button:has-text("pixivアカウントでログインする")';
const EMAIL_INPUT = 'input[placeholder="メールアドレスまたはpixiv ID"]';
const PASSWORD_INPUT = 'input[placeholder="パスワード"]';

export type PixivCredentials = { username: string; password: string };

/** 環境変数 → 1Password の順で pixiv の認証情報を解決する。 */
export async function loadPixivCredentials(): Promise<PixivCredentials> {
  const envUser = process.env.COBAN_USERNAME;
  const envPass = process.env.COBAN_PASSWORD;
  if (envUser && envPass) return { username: envUser, password: envPass };

  const item = process.env.OP_COBAN_ITEM;
  const vault = process.env.OP_VAULT || "";
  if (item && vault) {
    const client = await getOpClient();
    const [username, password] = await Promise.all([
      client.secrets.resolve(`op://${vault}/${item}/username`),
      client.secrets.resolve(`op://${vault}/${item}/password`),
    ]);
    if (username && password) return { username, password };
  }

  throw new Error(
    "pixiv の認証情報がありません（COBAN_USERNAME/COBAN_PASSWORD か OP_COBAN_ITEM を設定してください）",
  );
}

/** ダッシュボードが表示できていればログイン済みとみなす。 */
async function isLoggedIn(page: Page): Promise<boolean> {
  return (await page.locator(LOGIN_BUTTON).count()) === 0;
}

/**
 * coban にログインする。既にログイン済みなら何もしない。
 * 成功後は coban.pixiv.net のダッシュボードに居る。
 */
export async function loginWithPixiv(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  if (await isLoggedIn(page)) return;

  console.log("pixiv にログインします...");
  const { username, password } = await loadPixivCredentials();

  const btn = page.locator(LOGIN_BUTTON).first();
  if ((await btn.count()) === 0) {
    throw new Error("ログインボタンが見つかりません（pixivcoban の画面ではありません）");
  }
  await btn.click();
  await page.waitForURL(/accounts\.pixiv\.net/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const email = page.locator(EMAIL_INPUT).first();
  await email.waitFor({ state: "visible", timeout: 15000 });
  await email.fill(username);
  await page.locator(PASSWORD_INPUT).first().fill(password);
  await page.waitForTimeout(400);
  await page.locator('button:has-text("ログイン")').first().click();

  // coban に戻るまで待つ
  await page.waitForURL(/coban\.pixiv\.net/, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  if (!(await isLoggedIn(page))) {
    throw new Error("pixiv ログインに失敗しました（reCAPTCHA 等の可能性）");
  }
  console.log("ログインしました");
}
