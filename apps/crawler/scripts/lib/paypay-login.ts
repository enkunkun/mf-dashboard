/**
 * PayPay のログイン（OAuth2 + PAR + OTP）をブラウザ経由で完了させ、トークンを保存する。
 *
 * この工程だけは実 Chrome が必要（AWS WAF Bot Control の JS チャレンジを解くため）。
 * 既存の永続 Chrome（CDP）を再利用し、起動していなければ起こす。
 *
 * 手順:
 *   1. `paypay-fetch.ts login:start`
 *      → PAR を投げてブラウザに認可ページを開く
 *   2. ブラウザで 電話番号 → パスワード → 「別端末が手元にない」 を選ぶ
 *      （「別端末が手元にある」は PayPay アプリ専用 deeplink に飛ぶので使えない）
 *   3. SMS に届く `XX-1234` 形式のコードの 4 桁を `login:otp` に渡す
 *
 * 取得できないときは素直に「実 Chrome で人が 1 回ログインする」しかない。
 * トークンは 90 日有効で、以降は refresh で延命できる。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { CDP_URL, launchPersistentBrowser } from "./mf-browser.js";
import {
  CLIENT_ID,
  LOGIN_STATE_PATH,
  ORIGIN,
  REDIRECT_URI,
  baseHeaders,
  persistTokens,
  type Tokens,
} from "./paypay-api.js";

const AUTHORIZE_URL = (requestUri: string) =>
  `https://www.paypay.ne.jp/portal/api/v2/oauth2/authorize?client_id=${CLIENT_ID}&request_uri=${requestUri}`;
const OTP_URL = `https://www.paypay.ne.jp/portal/oauth2/otl-otp?client_id=${CLIENT_ID}&mode=navigation-2fa`;

type LoginState = { verifier: string; state: string; requestUri: string; at: string };

type CdpTab = { id: string; webSocketDebuggerUrl: string; url: string };

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 永続 Chrome が起動していなければ起こす。 */
export async function ensureBrowser(): Promise<void> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    if (res.ok) return;
  } catch {
    // 起動していない
  }
  await launchPersistentBrowser();
}

async function listTabs(): Promise<CdpTab[]> {
  return (await fetch(`${CDP_URL}/json`).then((r) => r.json())) as CdpTab[];
}

async function openTab(url: string): Promise<CdpTab> {
  return (await fetch(`${CDP_URL}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  }).then((r) => r.json())) as CdpTab;
}

/** 最小限の CDP クライアント。 */
async function connect(tab: CdpTab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, (v: unknown) => void>();
  const listeners: ((msg: { method?: string; params?: Record<string, unknown> }) => void)[] = [];

  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
      return;
    }
    for (const listener of listeners) listener(msg);
  };
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression: string): Promise<unknown> => {
    const result = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return result.result?.value;
  };

  return { ws, send, evaluate, on: (fn: (typeof listeners)[number]) => listeners.push(fn) };
}

/** PAR を投げ、ブラウザに認可ページを開き、PKCE を保存する。 */
export async function loginStart(): Promise<void> {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");

  const res = await fetch(`${ORIGIN}/bff/v2/oauth2/par`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders() },
    body: new URLSearchParams({
      clientId: CLIENT_ID,
      clientAppVersion: "5.69.0",
      clientOsVersion: "17.0.0",
      clientOsType: "ANDROID",
      redirectUri: REDIRECT_URI,
      responseType: "code",
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "REGULAR",
      tokenVersion: "v2",
      uiLocales: "ja",
    }),
  });
  const body = (await res.json()) as { payload?: { requestUri?: string } };
  const requestUri = body.payload?.requestUri;
  if (!requestUri) throw new Error(`PAR 失敗: ${JSON.stringify(body).slice(0, 300)}`);

  const loginState: LoginState = { verifier, state, requestUri, at: new Date().toISOString() };
  fs.mkdirSync(LOGIN_STATE_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(LOGIN_STATE_PATH, JSON.stringify(loginState, null, 2));

  await ensureBrowser();
  await openTab(AUTHORIZE_URL(requestUri));

  console.log("ブラウザに認可ページを開きました。");
  console.log("  1) 電話番号 → パスワード を入力");
  console.log("  2) 「別端末は手元にありますか？」で「別端末が手元にない」を選ぶ");
  console.log("  3) SMS の 4 桁が届いたら:");
  console.log("     npx tsx scripts/paypay-fetch.ts login:otp <4桁>");
}

/**
 * OTP を流し込んで認可コードを捕まえ、トークン交換まで行う。
 * 自動入力が効かない場合は、ブラウザで手入力してもらえばそのまま拾える。
 */
export async function completeLogin(digits: string, timeoutMs = 180_000): Promise<void> {
  if (!/^\d{4}$/.test(digits)) throw new Error("4 桁の数字を渡してください");
  if (!fs.existsSync(LOGIN_STATE_PATH)) {
    throw new Error("先に login:start を実行してください");
  }
  const loginState = JSON.parse(fs.readFileSync(LOGIN_STATE_PATH, "utf8")) as LoginState;

  const tab = (await listTabs()).find((t) => t.url.includes("paypay.ne.jp"));
  if (!tab) {
    throw new Error(
      "PayPay のタブが見つかりません。認可ページを開いたままにして、もう一度実行してください",
    );
  }

  const cdp = await connect(tab);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");

  let code: string | null = null;
  cdp.on((msg) => {
    if (msg.method !== "Page.frameRequestedNavigation") return;
    const url = String((msg.params as { url?: string })?.url ?? "");
    const matched = /[?&]code=([^&]+)/.exec(url);
    if (matched?.[1]) code = matched[1];
  });

  // OTP 入力ページへ。既に居るならそのまま。
  const current = await cdp.evaluate("location.href");
  if (!String(current).includes("/oauth2/otl-otp")) {
    await cdp.send("Page.navigate", { url: OTP_URL });
    await sleep(6_000);
  }

  // 4 桁を流し込む（1 桁ずつ。SPA が自動でフォーカスを進める想定）
  for (let i = 0; i < digits.length; i += 1) {
    await cdp.evaluate(
      `(()=>{const els=[...document.querySelectorAll('input')];const el=els[${i}]||els[0];if(!el)return;
        el.focus();el.value='${digits[i]}';
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await cdp.send("Input.insertText", { text: digits[i] });
    await sleep(300);
  }
  await cdp.evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/認証|確認|次へ|送信|ログイン/.test(x.innerText||''));if(b)b.click();})()`,
  );

  console.log("認証コードを送信しました。確定を待っています…");
  const deadline = Date.now() + timeoutMs;
  while (!code && Date.now() < deadline) await sleep(1_500);

  if (!code) {
    cdp.ws.close();
    throw new Error(
      "認可コードを取得できませんでした。ブラウザで認証コードを手入力してから、もう一度 login:otp を実行してください",
    );
  }

  const res = await fetch(`${ORIGIN}/bff/v2/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders() },
    body: new URLSearchParams({
      clientId: CLIENT_ID,
      code,
      codeVerifier: loginState.verifier,
      redirectUri: REDIRECT_URI,
      tokenVersion: "v2",
    }),
  });
  const tokens = (await res.json()) as { payload?: Partial<Tokens> };
  if (!tokens.payload?.accessToken) {
    cdp.ws.close();
    throw new Error(`トークン交換に失敗: ${JSON.stringify(tokens).slice(0, 300)}`);
  }
  await persistTokens({ ...(tokens.payload as Tokens), savedAt: new Date().toISOString() });
  cdp.ws.close();
  console.log(`✅ トークンを保存しました（有効期限: ${tokens.payload.expiredAt ?? "不明"}）`);
}
