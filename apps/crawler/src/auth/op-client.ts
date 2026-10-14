import { createClient, type Client } from "@1password/sdk";
import { debug, error } from "../logger.js";

// 1Password SDK client (singleton)
let _opClient: Client | null = null;

/**
 * 1Password SDK クライアントを取得する
 */
export async function getOpClient(): Promise<Client> {
  if (_opClient) {
    return _opClient;
  }

  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    error("OP_SERVICE_ACCOUNT_TOKEN が設定されていません");
    process.exit(1);
  }

  debug("1Password SDK クライアントを初期化しています...");
  _opClient = await createClient({
    auth: token,
    integrationName: "mf-dashboard",
    integrationVersion: "1.0.0",
  });

  return _opClient;
}

/**
 * テスト用: クライアントをリセット
 */
export function _resetOpClient(): void {
  _opClient = null;
}
