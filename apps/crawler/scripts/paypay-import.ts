/**
 * PayPay 取引履歴CSV を MoneyForward の手動口座に取り込む。
 *
 * 財布を 2 つ作る:
 *   - PayPay       (電子マネー・プリペイド) : 残高の出入り
 *   - PayPayカード (カード)                : カード利用
 * カード→PayPay のチャージは「振替」として記録し二重計上を避ける。
 *
 * この処理は `paypay-sync.ts`（本番の定期取込）からも `runPayPayImport()` として呼ばれる。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/paypay-import.ts                          # dry-run
 *   tsx --env-file=../../.env scripts/paypay-import.ts --reset                  # 口座を作り直す
 *   tsx --env-file=../../.env scripts/paypay-import.ts --apply [--limit N] [--kind チャージ]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { getCsrfToken } from "../src/hooks/helpers.js";
import { PAYPAY_DIR } from "./lib/paypay-tokens.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const statePath = path.resolve(projectRoot, "data/paypay-synced-ids.json");
const CSV_DIR = PAYPAY_DIR;

const ACCOUNTS = {
  paypay: { name: "PayPay", categoryLabel: "電子マネー・プリペイド" },
  card: { name: "PayPayカード", categoryLabel: "電子マネー・プリペイド" },
} as const;
type AccountKey = keyof typeof ACCOUNTS;

export type PayPayImportOptions = {
  /** 実際に MoneyForward へ登録する。false なら dry-run。 */
  apply?: boolean;
  /** 口座を作り直す（既存の PayPay 口座を削除）。 */
  reset?: boolean;
  /** 登録件数の上限（テスト用）。 */
  limit?: number;
  /** 取引内容で絞り込む。 */
  kind?: string;
};

type Entry = {
  mode: "expense" | "income" | "transfer";
  account?: AccountKey;
  from?: AccountKey;
  to?: AccountKey;
  date: string;
  amount: number;
  content: string;
  txId: string;
  kind: string;
  method: string;
  note?: string;
};

function parseAmount(v: string | undefined): number {
  const s = (v ?? "").replace(/,/g, "").trim();
  if (!s || s === "-") return 0;
  return Math.abs(Number(s));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const CARD_METHOD = /クレジット|PayPayカード/;

function classify(row: {
  date: string;
  kind: string;
  method: string;
  partner: string;
  outAmt: number;
  inAmt: number;
  txId: string;
}): Entry | null {
  const { date, kind, method, partner, outAmt, inAmt, txId } = row;
  const content = partner || kind;
  if (method === "PayPayポイント") return null;
  if (inAmt === 0 && outAmt === 0) return null;
  if (!txId) return null;

  if (CARD_METHOD.test(method)) {
    if (kind === "チャージ") {
      // カードで PayPay にチャージ = カード→財布の振替
      return {
        mode: "transfer",
        from: "card",
        to: "paypay",
        date,
        amount: inAmt,
        content,
        txId,
        kind,
        method,
      };
    }
    if (inAmt > 0) {
      return { mode: "income", account: "card", date, amount: inAmt, content, txId, kind, method };
    }
    return { mode: "expense", account: "card", date, amount: outAmt, content, txId, kind, method };
  }

  if (method === "PayPay残高") {
    return inAmt > 0
      ? { mode: "income", account: "paypay", date, amount: inAmt, content, txId, kind, method }
      : { mode: "expense", account: "paypay", date, amount: outAmt, content, txId, kind, method };
  }

  // 銀行/LINE Pay からのチャージ等（銀行側と重複する可能性あり）
  return inAmt > 0
    ? {
        mode: "income",
        account: "paypay",
        date,
        amount: inAmt,
        content,
        txId,
        kind,
        method,
        note: "bank",
      }
    : {
        mode: "expense",
        account: "paypay",
        date,
        amount: outAmt,
        content,
        txId,
        kind,
        method,
        note: "bank",
      };
}

export function loadEntries(): Entry[] {
  const files = fs
    .readdirSync(CSV_DIR)
    .filter((f) => /^paypay_\d.*\.csv$/.test(f))
    .sort();
  const entries: Entry[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(CSV_DIR, f), "utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = splitCsvLine(lines[0]!);
    const idx = (n: string) => header.indexOf(n);
    const [iDate, iOut, iIn, iKind, iPartner, iMethod, iId] = [
      "取引日",
      "出金金額（円）",
      "入金金額（円）",
      "取引内容",
      "取引先",
      "取引方法",
      "取引番号",
    ].map(idx);
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line);
      const e = classify({
        date: (c[iDate] ?? "").slice(0, 10),
        kind: c[iKind] ?? "",
        method: c[iMethod] ?? "",
        partner: (c[iPartner] ?? "").trim(),
        outAmt: parseAmount(c[iOut]),
        inAmt: parseAmount(c[iIn]),
        txId: (c[iId] ?? "").trim(),
      });
      if (e) entries.push(e);
    }
  }
  return entries;
}

async function findAccountHash(page: Page, name: string): Promise<string | null> {
  await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  return await page.evaluate((n) => {
    const links = Array.from(document.querySelectorAll('a[href*="show_manual"]'));
    const t = links.find((a) => (a.textContent || "").trim() === n);
    const href = t?.getAttribute("href") || "";
    const m = href.match(/show_manual\/(.+)$/);
    return m ? m[1]! : null;
  }, name);
}

async function deleteAccount(page: Page, name: string): Promise<void> {
  const hash = await findAccountHash(page, name);
  if (!hash) {
    console.log(`削除対象なし: ${name}`);
    return;
  }
  const csrf = await getCsrfToken(page);
  const status = await page.evaluate(
    async ({ token, hash }) => {
      const body = new URLSearchParams();
      body.append("authenticity_token", token || "");
      body.append("_method", "delete");
      body.append("account_id_hash", hash);
      body.append("commit", "削除");
      const res = await fetch("/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return res.status;
    },
    { token: csrf, hash },
  );
  console.log(`削除 ${name}: status=${status}`);
}

async function ensureAccount(page: Page, key: AccountKey): Promise<void> {
  const { name, categoryLabel } = ACCOUNTS[key];
  if (await findAccountHash(page, name)) {
    console.log(`口座「${name}」は既に存在します`);
    return;
  }
  console.log(`口座「${name}」を作成...`);
  await page.goto("https://moneyforward.com/accounts/new/manual?category_type=MANUAL", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2000);
  await page.selectOption('select[name="new_manual_account[category_id]"]', {
    label: categoryLabel,
  });
  await page.waitForTimeout(1800);
  await page.fill('input[name="new_manual_account[name]"]', name);
  const valueInput = await page.$('input[name="new_manual_account[value]"]');
  if (valueInput) await valueInput.fill("0");
  const submitted = await page.evaluate(() => {
    const input = document.querySelector('input[name="new_manual_account[name]"]');
    const f = input ? (input.closest("form") as HTMLFormElement | null) : null;
    if (!f) return null;
    const a = f.getAttribute("action");
    f.requestSubmit();
    return a;
  });
  if (!submitted) throw new Error("manual account form not found");
  await page.waitForTimeout(4000);
  const ok = await findAccountHash(page, name);
  console.log(ok ? `作成しました: ${name}` : `⚠️ 作成を確認できませんでした: ${name}`);
}

async function resolveSubHashes(page: Page): Promise<Record<AccountKey, string>> {
  const names = { paypay: ACCOUNTS.paypay.name, card: ACCOUNTS.card.name };
  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const map = await page.evaluate((names) => {
      const out: Record<string, string> = {};
      const s = document.querySelector('select[name="user_asset_act[sub_account_id_hash]"]');
      if (!s) return out;
      const opts = Array.from(s.querySelectorAll("option")).map((o) => ({
        v: o.getAttribute("value") || "",
        t: (o.textContent || "").trim(),
      }));
      for (const [key, name] of Object.entries(names)) {
        const hit = opts.find((o) => o.t.startsWith(name));
        if (hit) out[key] = hit.v;
      }
      return out;
    }, names);
    if (map.paypay && map.card) return map as Record<AccountKey, string>;
    console.log(`sub hash 解決リトライ ${attempt}/6: ${JSON.stringify(map)}`);
    await page.waitForTimeout(4000);
  }
  throw new Error("sub_account_id_hash 解決失敗");
}

export async function runPayPayImport(options: PayPayImportOptions = {}): Promise<void> {
  const { apply = false, reset = false, limit, kind } = options;
  let entries = loadEntries();
  if (kind) entries = entries.filter((e) => e.kind === kind);

  const byMode = entries.reduce<Record<string, number>>((a, e) => {
    const k = e.mode === "transfer" ? `${e.from}->${e.to}` : `${e.mode}:${e.account}`;
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});
  console.log(`取込対象 ${entries.length} 件`);
  console.log("内訳:", JSON.stringify(byMode, null, 2));

  let synced = new Set<string>();
  if (fs.existsSync(statePath)) {
    try {
      synced = new Set(JSON.parse(fs.readFileSync(statePath, "utf8")) as string[]);
    } catch {
      /* ignore */
    }
  }
  const targets = entries.filter((e) => !synced.has(e.txId));
  console.log(`未取込 ${targets.length} 件（取込済 ${synced.size}）`);
  for (const e of targets.slice(0, 4)) {
    const label = e.mode === "transfer" ? `${e.from}→${e.to}(振替)` : `${e.mode}:${e.account}`;
    console.log(`  ${e.date} ${label} ${e.amount} ${e.content} [${e.kind}/${e.method}]`);
  }

  if (!reset && !apply) {
    console.log("\n--dry-run 完了（--reset / --apply を付けると書き込みます）");
    return;
  }

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await createBrowserContext(browser, { useAuthState: true });
  const page = await context.newPage();
  await loginWithAuthState(page, context);

  if (reset) {
    await deleteAccount(page, ACCOUNTS.paypay.name);
    await deleteAccount(page, ACCOUNTS.card.name);
    if (fs.existsSync(statePath)) {
      fs.rmSync(statePath);
      console.log("state をクリアしました");
    }
    synced = new Set<string>();
  }
  await ensureAccount(page, "paypay");
  await ensureAccount(page, "card");

  const sub = await resolveSubHashes(page);
  console.log("sub hashes:", JSON.stringify(sub));

  if (!apply) {
    console.log("--apply なしのため登録は行いません");
    await browser.close();
    return;
  }

  const toImport = limit ? targets.slice(0, limit) : targets;
  const csrf = await getCsrfToken(page);
  if (!csrf) throw new Error("CSRF token not found");

  let ok = 0;
  let ng = 0;
  for (const [i, e] of toImport.entries()) {
    process.stdout.write(
      `[${i + 1}/${toImport.length}] ${e.date} ${e.mode} ${e.amount} ${e.content} ... `,
    );
    const res = await page.evaluate(
      async ({ token, entry, sub }) => {
        const body = new URLSearchParams();
        body.append("authenticity_token", token);
        body.append("user_asset_act[updated_at]", entry.date);
        body.append("user_asset_act[amount]", String(entry.amount));
        body.append("user_asset_act[content]", entry.content || entry.kind);
        if (entry.mode === "transfer") {
          body.append("user_asset_act[is_transfer]", "1");
          body.append("user_asset_act[is_income]", "0");
          body.append("user_asset_act[sub_account_id_hash_from]", sub[entry.from]);
          body.append("user_asset_act[sub_account_id_hash_to]", sub[entry.to]);
        } else {
          body.append("user_asset_act[is_transfer]", "0");
          body.append("user_asset_act[is_income]", entry.mode === "income" ? "1" : "0");
          body.append("user_asset_act[sub_account_id_hash]", sub[entry.account]);
          body.append("user_asset_act[large_category_id]", "");
          body.append("user_asset_act[middle_category_id]", "");
        }
        const r = await fetch("/cf/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRF-Token": token,
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
        });
        return { ok: r.ok, status: r.status };
      },
      { token: csrf, entry: e, sub },
    );
    if (res.ok) {
      ok++;
      synced.add(e.txId);
      process.stdout.write("OK\n");
    } else {
      ng++;
      process.stdout.write(`NG(${res.status})\n`);
    }
    await page.waitForTimeout(120);
  }
  fs.writeFileSync(statePath, JSON.stringify([...synced], null, 2));
  console.log(`\n完了: OK=${ok} NG=${ng}`);
  await browser.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const valueOf = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limitArg = valueOf("--limit");

  runPayPayImport({
    apply: has("--apply"),
    reset: has("--reset"),
    limit: limitArg ? Number(limitArg) : undefined,
    kind: valueOf("--kind"),
  }).catch((err) => {
    console.error("error:", err);
    process.exit(1);
  });
}
