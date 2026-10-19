/**
 * ファミペイの Web ログインを実ブラウザで完了させ、セッションを確立する。
 *
 * ファミペイの API はすべて `KAIIN_HASH_KEY` を要求するが、その初回発行だけは
 * `https://famipay.family.co.jp/webview/login.html` での Web ログイン結果
 * （遷移先 URL の `APPLICATION_AUTHENTICATION_TOKEN`）から `acquireMemberInformation.jsp`
 * を叩いて得るしかない。アプリも同じ経路（LoginActivity → LoginPresenterImpl）。
 *
 * ID / パスワードは 1Password から取り、SMS のワンタイムコードは人が入力する前提
 * （毎回のログインで SMS 認証が必要）。自動入力に失敗しても、ブラウザで人が
 * ログインし終えれば、遷移先 URL を見てトークンを拾える。
 *
 * ブラウザは `famipay-browser.ts` の常駐ブラウザを 1 つ使う。ここでは閉じない
 * （画面を見ながら可変に調査・再実行できるようにするため）。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { getOpClient } from "../../src/auth/op-client.js";
import {
  FAMIPAY_LOGIN_URL,
  extractApplicationAuthToken,
  type FamipaySession,
} from "../../src/famipay.js";
import { describePage, getFamipayPage } from "../famipay-browser.js";
import {
  acquireMemberInformation,
  authenticationCheck,
  isSessionFresh,
  loadSession,
  saveSession,
} from "./famipay-api.js";

const OP_ITEM = process.env.OP_FAMIPAY_ITEM ?? "FamiPay";
const OP_VAULT = process.env.OP_FAMIPAY_VAULT ?? "apps";

/** ログイン完了（トークン捕捉）を待つ既定の秒数。SMS 入力の余裕をみて 10 分。 */
const DEFAULT_LOGIN_TIMEOUT_SEC = Number(process.env.FAMIPAY_LOGIN_TIMEOUT_SEC ?? 600);

export type FamipayCredentials = { username: string; password: string };

/** 1Password（または環境変数）からログイン情報を取り出す。無ければ null。 */
export async function loadCredentials(): Promise<FamipayCredentials | null> {
  const fromEnv = {
    username: process.env.FAMIPAY_ID,
    password: process.env.FAMIPAY_PASSWORD,
  };
  if (fromEnv.username && fromEnv.password) {
    console.log("ログイン情報の取得元: 環境変数");
    return { username: fromEnv.username, password: fromEnv.password };
  }

  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    const fromSdk = await loadFrom1PasswordSdk();
    if (fromSdk) {
      console.log("ログイン情報の取得元: 1Password (SDK)");
      return fromSdk;
    }
  }

  const fromCli = loadFrom1PasswordCli();
  if (fromCli) {
    console.log("ログイン情報の取得元: 1Password (op item get)");
    return fromCli;
  }

  console.warn(
    `1Password の「${OP_ITEM}」からログイン情報を取得できませんでした。手入力してください。`,
  );
  return null;
}

async function loadFrom1PasswordSdk(): Promise<FamipayCredentials | null> {
  try {
    const client = await getOpClient();
    const vault = (await client.vaults.list()).find(
      (v) => v.title === OP_VAULT || v.id === OP_VAULT,
    );
    if (!vault) return null;
    const overview = (await client.items.list(vault.id)).find(
      (i) => i.title === OP_ITEM || i.id === OP_ITEM,
    );
    if (!overview) return null;
    const item = await client.items.get(vault.id, overview.id);
    const get = (key: string): string | undefined => {
      const field = item.fields.find((f) => f.id === key || f.title === key);
      return field?.value === undefined || field.value === null ? undefined : String(field.value);
    };
    const username = get("username");
    const password = get("password");
    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

function loadFrom1PasswordCli(): FamipayCredentials | null {
  try {
    const out = execFileSync(
      "op",
      ["item", "get", OP_ITEM, "--vault", OP_VAULT, "--format", "json"],
      {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const item = JSON.parse(out) as {
      fields?: Array<{ id?: string; label?: string; value?: string }>;
    };
    const get = (key: string): string | undefined =>
      item.fields?.find((f) => f.id === key || f.label === key)?.value ?? undefined;
    const username = get("username");
    const password = get("password");
    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

/** ログインフォームの各要素。login.html の実物から確認した名前。 */
const LOGIN_FORM = {
  /** 電話番号（ハイフン不要、11 桁）。 */
  phone: 'input[name="CP_NO"]',
  /** パスワード。 */
  password: 'input[name="KAIIN_PASSWD"]',
  /** 「ログイン」ボタン。`onsubmit="return false"` なので click で送信する。 */
  submit: "button.buttonPrimary",
  /** エラー表示領域。 */
  error: "#errorMessageArea",
} as const;

/**
 * ログインフォームに電話番号とパスワードを流し込み、送信まで行う。
 *
 * 送信すると SMS のワンタイムコード入力画面へ進む（`send_with_sms` →
 * `/webview/login.html?action=sms_auth_inputentry_id`）。
 * `LOGIN_HASH` はページ側が `MD5(電話番号 + パスワード + seed)` で組み立てるので、
 * 値はそのまま入力すればよい。
 *
 * 送信は 1 回だけ行う。`sms_cookie_refresh()` が送信回数を cookie で数えており、
 * 連打すると上限に達して一時的に送信できなくなる。
 */
async function fillAndSubmitLogin(
  page: Awaited<ReturnType<typeof getFamipayPage>>["page"],
  credentials: FamipayCredentials | null,
): Promise<void> {
  const input = page.locator(LOGIN_FORM.phone);
  if ((await input.count()) === 0) {
    console.log("電話番号欄が見つかりません。ブラウザで直接ログインしてください。");
    return;
  }
  if (!credentials) {
    console.log("電話番号とパスワードを入力して「ログイン」を押してください。");
    return;
  }

  await input.fill(credentials.username);
  await page.locator(LOGIN_FORM.password).fill(credentials.password);
  console.log("電話番号とパスワードを自動入力しました。「ログイン」を押します。");
  await page
    .locator(LOGIN_FORM.submit)
    .click()
    .catch(() => {
      console.log("「ログイン」ボタンのクリックに失敗しました。手で押してください。");
    });
  await page.waitForTimeout(2000);

  const error = await page
    .locator(LOGIN_FORM.error)
    .innerText()
    .catch(() => "");
  if (error.trim()) console.log(`エラー表示: ${error.trim().slice(0, 200)}`);
  else console.log("SMS のワンタイムコードを入力してください。");
}

/**
 * 常駐ブラウザを使い、`APPLICATION_AUTHENTICATION_TOKEN` を捕捉する。
 * 人がログインし終えるまで待つ（SMS コードの入力が必要）。ブラウザは閉じない。
 */
export async function loginAndCaptureToken(
  timeoutSec: number = DEFAULT_LOGIN_TIMEOUT_SEC,
): Promise<string> {
  const { page, external } = await getFamipayPage();
  console.log(external ? "常駐ブラウザに接続しました。" : "ブラウザを起動しました。");

  let token: string | null = null;
  const capture = (url: string): void => {
    const found = extractApplicationAuthToken(url);
    if (found) token = found;
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      console.log(`  遷移: ${frame.url()}`);
      capture(frame.url());
    }
  });
  page.on("request", (request) => capture(request.url()));
  capture(page.url());

  if (!token) {
    if (!/webview\/login\.html/.test(page.url())) {
      await page.goto(FAMIPAY_LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    capture(page.url());
    await fillAndSubmitLogin(page, await loadCredentials());
  }

  if (!token) {
    console.log(`ブラウザでログインしてください（最大 ${timeoutSec} 秒待ちます）。`);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let ticks = 0;
  while (!token && Date.now() < deadline) {
    await page.waitForTimeout(1000);
    // 30 秒ごとに今どの画面にいるかを出す（SMS 入力待ちか、エラーか分かるように）
    if (++ticks % 30 === 0) {
      const { url, title } = await describePage(page).catch(() => ({ url: page.url(), title: "" }));
      console.log(`  待機中: ${url} (${title})`);
    }
  }

  if (!token) {
    const { url, title } = await describePage(page);
    throw new Error(
      `ログイン完了（APPLICATION_AUTHENTICATION_TOKEN）を ${timeoutSec} 秒待っても確認できませんでした。` +
        `現在のページ: ${url} (${title})。ブラウザは開いたままにしています。`,
    );
  }

  console.log("APPLICATION_AUTHENTICATION_TOKEN を捕捉しました。");
  return token;
}

/** 端末識別子は一度作ったら使い回す（アプリの `installationId` 相当）。 */
function resolveLoginTerminalId(existing: FamipaySession | null): string {
  return existing?.loginTerminalId ?? crypto.randomUUID();
}

/**
 * 有効なセッションを返す。キャッシュが無効ならログインからやり直す。
 * ローテーション可能なセッションは `authenticationCheck` で延命を試す。
 */
export async function ensureFamipaySession(): Promise<FamipaySession> {
  const existing = loadSession();

  if (existing && isSessionFresh(existing)) {
    return existing;
  }

  if (existing) {
    try {
      const rotated = await authenticationCheck(existing.kaiinHashKey, existing.loginTerminalId);
      const session: FamipaySession = {
        ...existing,
        kaiinHashKey: rotated.kaiinHashKey,
        hashedMemberNo: rotated.hashedMemberNo ?? existing.hashedMemberNo ?? null,
        savedAt: new Date().toISOString(),
      };
      saveSession(session);
      console.log("既存セッションをローテーションして再利用しました。");
      return session;
    } catch {
      console.log("既存セッションは無効でした。ログインし直します。");
    }
  }

  const token = await loginAndCaptureToken();
  const loginTerminalId = resolveLoginTerminalId(existing);
  const info = await acquireMemberInformation(token, loginTerminalId);
  const session: FamipaySession = {
    applicationAuthenticationToken: token,
    kaiinHashKey: info.kaiinHashKey,
    loginTerminalId,
    hashedMemberNo: info.hashedMemberNo,
    savedAt: new Date().toISOString(),
  };
  saveSession(session);
  console.log("ファミペイのセッションを保存しました。");
  return session;
}
