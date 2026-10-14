import { execFileSync } from "node:child_process";
/**
 * JRE ID パスキー自動ログインの共通処理。
 *
 * Bitwarden（CLI `bw` またはエクスポートファイル）から得た JRE ID パスキー秘密鍵を
 * CDP の WebAuthn 仮想認証器へ読み込み、モバイルSuica 会員メニューへのログインを自動化する。
 *
 * 知見:
 *  - CDP の WebAuthn.addCredential は「標準 base64（パディング付き）」を要求する（base64url は Invalid parameters）
 *  - Bitwarden の credentialId は UUID 文字列で保持される。UUID の 16 バイトに戻すと
 *    サーバーの allowCredentials（base64url）と一致する
 *  - 仮想認証器は CDP 環境ごとに 1 つだけ
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";

export type Passkey = {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  discoverable: boolean;
};

type VaultItem = {
  name?: string;
  login?: {
    username?: string;
    uris?: Array<{ uri?: string }>;
    fido2Credentials?: Array<Record<string, unknown>>;
  };
};

/** Bitwarden のエクスポートパスを解決する（引数 → 環境変数 → ~/Downloads の最新） */
export function findBitwardenExport(): string {
  const i = process.argv.indexOf("--export");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (process.env.JRE_EXPORT) return process.env.JRE_EXPORT;
  const dir = path.join(os.homedir(), "Downloads");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^bitwarden_export_.*\.json$/.test(f))
    .sort();
  if (!files.length)
    throw new Error("Bitwarden export が見つかりません。--export <path> を指定してください");
  return path.join(dir, files[files.length - 1]!);
}

/** Bitwarden の item 配列から JRE ID のパスキーを取り出す（export / CLI 共通） */
function extractJrePasskey(
  items: VaultItem[] | undefined,
): { passkey: Passkey; username?: string } | null {
  for (const item of items ?? []) {
    const hosts = (item.login?.uris ?? []).map((u) => u.uri ?? "");
    for (const c of item.login?.fido2Credentials ?? []) {
      const rpId = String(c.rpId ?? "");
      const isJre = rpId.includes("jreast") || hosts.some((h) => h.includes("jreast"));
      if (!isJre) continue;
      const keyValue = c.keyValue;
      if (typeof keyValue !== "string" || !keyValue) continue;
      return {
        username: item.login?.username,
        passkey: {
          credentialId: String(c.credentialId),
          rpId,
          privateKey: keyValue,
          userHandle: typeof c.userHandle === "string" && c.userHandle ? c.userHandle : undefined,
          signCount: Number(c.counter ?? 0) || 0,
          discoverable: c.discoverable === true || c.discoverable === "true",
        },
      };
    }
  }
  return null;
}

function loadFromExport(exportPath: string): { passkey: Passkey; username?: string } {
  const data = JSON.parse(fs.readFileSync(exportPath, "utf8")) as { items?: VaultItem[] };
  const found = extractJrePasskey(data.items);
  if (!found) throw new Error("エクスポートに JRE ID のパスキーが見つかりません");
  return found;
}

/**
 * Bitwarden CLI (`bw list items`) から JRE ID のパスキーを取得する。
 * `bw` が入っていて BW_SESSION が有効なときだけ使う（エクスポート不要）。
 */
function loadFromBitwardenCli(): { passkey: Passkey; username?: string } | null {
  const session = process.env.BW_SESSION;
  if (!session) return null;
  try {
    const out = execFileSync("bw", ["list", "items", "--session", session], {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return extractJrePasskey(JSON.parse(out) as VaultItem[]);
  } catch {
    return null;
  }
}

/**
 * 1Password CLI (`op item get`) から JRE ID パスキーを取得する。
 * 該当アイテム（既定タイトル "JRE ID passkey (Suica)"）に
 * credentialId / privateKey / userHandle / signCount を custom field として保存しておく。
 */
function loadFrom1Password(): { passkey: Passkey; username?: string } | null {
  const title = process.env.SUICA_OP_ITEM ?? "JRE ID passkey (Suica)";
  const vault = process.env.SUICA_OP_VAULT ?? "apps";
  try {
    const out = execFileSync("op", ["item", "get", title, "--vault", vault, "--format", "json"], {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const item = JSON.parse(out) as {
      fields?: Array<{ id?: string; label?: string; value?: string }>;
    };
    const get = (key: string) => item.fields?.find((f) => f.id === key || f.label === key)?.value;
    const privateKey = get("privateKey");
    const credentialId = get("credentialId");
    if (!privateKey || !credentialId) return null;
    return {
      username: get("username"),
      passkey: {
        credentialId,
        rpId: get("rpId") ?? "id.jreast.co.jp",
        privateKey,
        userHandle: get("userHandle") || undefined,
        signCount: Number(get("signCount") ?? 0) || 0,
        discoverable: (get("discoverable") ?? "true") === "true",
      },
    };
  } catch {
    return null;
  }
}

/**
 * JRE ID のパスキーを取得する。
 * 優先順: 1Password CLI → Bitwarden CLI（BW_SESSION があれば）→ エクスポートファイル。
 */
export function loadJrePasskey(exportPath?: string): { passkey: Passkey; username?: string } {
  const from1password = loadFrom1Password();
  if (from1password) {
    console.log("パスキー取得元: 1Password (op item get)");
    return from1password;
  }
  const fromCli = loadFromBitwardenCli();
  if (fromCli) {
    console.log("パスキー取得元: Bitwarden CLI (bw list items)");
    return fromCli;
  }
  console.log("パスキー取得元: Bitwarden エクスポート");
  return loadFromExport(exportPath ?? findBitwardenExport());
}

/** base64 / base64url どちらでも CDP が要求する標準 base64（パディング付き）に正規化する */
function toStdBase64(s: string): string {
  let t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  while (t.length % 4) t += "=";
  return t;
}

/**
 * Bitwarden の credentialId を CDP 用 base64 に変換する。
 * UUID 文字列の場合は UUID の 16 バイトを base64 化したものが本来の credential ID。
 */
function parseCredentialId(s: string): string {
  const isUuid =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
  if (isUuid) return Buffer.from(s.replace(/-/g, ""), "hex").toString("base64");
  return toStdBase64(s);
}

/** 仮想認証器を CDP に設置して JRE ID のパスキーを登録する（client は保持すること） */
export async function installPasskeyAuthenticator(
  context: BrowserContext,
  page: Page,
  passkey: Passkey,
): Promise<CDPSession> {
  const client = await context.newCDPSession(page);
  await client.send("WebAuthn.enable" as never);
  const { authenticatorId } = (await client.send(
    "WebAuthn.addVirtualAuthenticator" as never,
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    } as never,
  )) as { authenticatorId: string };
  await client.send(
    "WebAuthn.addCredential" as never,
    {
      authenticatorId,
      credential: {
        credentialId: parseCredentialId(passkey.credentialId),
        isResidentCredential: passkey.discoverable,
        rpId: passkey.rpId,
        privateKey: toStdBase64(passkey.privateKey),
        userHandle: passkey.userHandle ? toStdBase64(passkey.userHandle) : undefined,
        signCount: passkey.signCount,
      },
    } as never,
  );
  return client;
}

/**
 * モバイルSuica 会員メニューへパスキーでログインする。
 * 成功後は mobilesuica.com/ka/lg/ReceiveAuthorizationCode.aspx に遷移している。
 */
export async function loginWithPasskey(
  page: Page,
  context: BrowserContext,
  exportPath?: string,
): Promise<void> {
  const { passkey, username } = loadJrePasskey(exportPath);
  await installPasskeyAuthenticator(context, page, passkey);

  await page.goto("https://www.mobilesuica.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // すでにログイン済みなら mobilesuica.com/ が会員メニューを表示する
  if (/会員メニュー/.test(await page.title())) return;

  // 「JRE IDでログイン」はアコーディオン(toggle2)の中なので開く
  const accLabel = page.locator('label[for="toggle2"]');
  if (await accLabel.count()) {
    await accLabel
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.locator("a.to-jresite-btn").first().click({ timeout: 15000 });
  await page.waitForURL(/id\.jreast\.co\.jp/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // パスキー画面は「ログイン」ビュー→「パスキーでログイン」ビューの2段のことがある。
  // ボタンは locator.click が効かない場合があるため DOM click を使い、数回リトライする。
  for (let i = 0; i < 6; i++) {
    if (!page.url().includes("id.jreast.co.jp")) break;
    const idInput = page.locator('input[name="id"]').first();
    if (username && (await idInput.count())) {
      await idInput.fill(username).catch(() => {});
    }
    const btn = page.locator('button:has-text("パスキーでログインする")').first();
    if (await btn.count()) {
      await btn.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
    }
    await page.waitForTimeout(4000);
  }

  await page
    .waitForURL(/mobilesuica\.com\/ka\/lg\/ReceiveAuthorizationCode\.aspx/, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
}
