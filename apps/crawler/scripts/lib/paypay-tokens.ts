import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOpClient } from "../../src/auth/op-client.js";

/**
 * PayPay のトークン置き場。
 * 既定は `~/.local/share/paypay-hook`（環境変数 `PAYPAY_DIR` で変更可）。
 * **このディレクトリはリポジトリに含めない**（トークンと明細が入るため）。
 */
export const PAYPAY_DIR =
  process.env.PAYPAY_DIR ?? path.join(os.homedir(), ".local", "share", "paypay-hook");
export const TOKENS_PATH = path.resolve(PAYPAY_DIR, "tokens.json");

/**
 * tokens.json の形。expiredAt は accessToken の失効時刻（ISO）。
 * refreshToken は実測では refresh してもローテーションされない（同一値が返る）。
 */
export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiredAt?: string;
  issuedAt?: string;
  savedAt?: string;
  [k: string]: unknown;
};

/**
 * 1Password をトークンの保管先として使うか。
 * `OP_PAYPAY_ITEM` が設定されていれば 1Password、無ければローカルのファイルを使う。
 */
export function isOpTokenStoreEnabled(): boolean {
  return Boolean(process.env.OP_PAYPAY_ITEM);
}

function opTokenRef(): string {
  const vault = process.env.OP_VAULT || "";
  const item = process.env.OP_PAYPAY_ITEM || "";
  const field = process.env.OP_PAYPAY_FIELD || "tokens";
  return `op://${vault}/${item}/${field}`;
}

/**
 * トークンを読み込む。1Password が設定されていればそこから、無ければファイルから。
 */
export async function resolveTokens(): Promise<Tokens> {
  if (isOpTokenStoreEnabled()) {
    const client = await getOpClient();
    const raw = await client.secrets.resolve(opTokenRef());
    if (!raw) throw new Error(`1Password の PayPay トークンが空です: ${opTokenRef()}`);
    return JSON.parse(raw) as Tokens;
  }

  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error(
      `${TOKENS_PATH} がありません。先に \`npx tsx scripts/paypay-fetch.ts login:start\` でログインしてください`,
    );
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as Tokens;
}

/**
 * トークンを保存する。
 * 1Password が設定されていれば対象項目のフィールドを更新する。
 * 書き込み権限が無い場合は警告だけ出して続行する（読み取りはそのまま使えるため）。
 */
export async function persistTokens(tokens: Tokens): Promise<void> {
  if (isOpTokenStoreEnabled()) {
    try {
      await persistTokensToOp(tokens);
    } catch (err) {
      console.warn(
        `1Password へのトークン書き戻しに失敗しました（読み取りは継続できます）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }

  fs.mkdirSync(PAYPAY_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  fs.chmodSync(TOKENS_PATH, 0o600);
}

async function persistTokensToOp(tokens: Tokens): Promise<void> {
  const client = await getOpClient();
  const vaultName = process.env.OP_VAULT || "";
  const itemName = process.env.OP_PAYPAY_ITEM || "";
  const fieldName = process.env.OP_PAYPAY_FIELD || "tokens";

  const vault = (await client.vaults.list()).find(
    (v) => v.title === vaultName || v.id === vaultName,
  );
  if (!vault) throw new Error(`vault が見つかりません: ${vaultName}`);

  const overview = (await client.items.list(vault.id)).find(
    (i) => i.title === itemName || i.id === itemName,
  );
  if (!overview) throw new Error(`項目が見つかりません: ${itemName}`);

  const item = await client.items.get(vault.id, overview.id);
  const field = item.fields.find((f) => f.id === fieldName || f.title === fieldName);
  if (!field) throw new Error(`フィールドが見つかりません: ${fieldName}`);

  field.value = JSON.stringify(tokens);
  await client.items.put(item);
}
