import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import { getCsrfToken } from "../src/hooks/helpers.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const userDataDir = path.resolve(projectRoot, "data/revolut-profile");
const rawTxsPath = path.resolve(projectRoot, "data/revolut-transactions.json");
const rawWalletPath = path.resolve(projectRoot, "data/revolut-wallet.json");
const syncedIdsPath = path.resolve(projectRoot, "data/revolut-synced-ids.json");
const REVOLUT_SUB_ACCOUNT_HASH = "g_HdKBkHtz0XQHuDTr2NF8lQ5L5zjrwV0MFYNXmcMgo";
const REVOLUT_ACCOUNT_HASH = "AbWd9NXBCTfWHP7aIKDMZtiL-fSigM8MSpyc0b68nYk";

type RevolutTx = {
  id: string;
  type: string;
  state: string;
  startedDate: number;
  currency: string;
  amount: number;
  description: string;
};

type WalletPocket = {
  currency: string;
  balance: number;
  blockedAmount?: number;
};

type WalletData = {
  pockets: WalletPocket[];
};

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

async function calculateTotalJpyBalance(wallet: WalletData): Promise<number> {
  // 為替レート取得 (JPY基準)
  let rates: Record<string, number> = {};
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/JPY");
    const data = await res.json();
    if (data && data.rates) {
      rates = data.rates;
    }
  } catch (e) {
    console.warn("為替レート取得失敗。主要通貨の固定レートを使用します。");
    rates = { EUR: 0.0056, USD: 0.0063, SGD: 0.0081, JPY: 1 };
  }

  let totalJpy = 0;
  for (const pocket of wallet.pockets) {
    const ccy = pocket.currency;
    // JPYは整数単位、他通貨(EUR, USD, SGD等)はセント(1/100)単位
    const actualAmount = ccy === "JPY" ? pocket.balance : pocket.balance / 100;
    const rateToJpy = ccy === "JPY" ? 1 : rates[ccy] ? 1 / rates[ccy] : 0;
    const jpyValue = actualAmount * rateToJpy;
    totalJpy += jpyValue;
  }

  return Math.round(totalJpy);
}

async function fetchRevolutData(): Promise<{ txs: RevolutTx[]; totalBalanceJpy: number | null }> {
  console.log("1. Revolutを起動中（必要に応じてTouch IDでロック解除してください）...");

  const context = await chromium
    .launchPersistentContext(userDataDir, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled"],
    })
    .catch(async () => {
      console.warn("Chrome起動リトライ中...");
      return chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: "chrome",
        viewport: { width: 1280, height: 800 },
        args: ["--disable-blink-features=AutomationControlled"],
      });
    });

  const page = context.pages()[0] || (await context.newPage());
  let capturedTxs: RevolutTx[] = [];
  let capturedWallet: WalletData | null = null;
  let txApiSeen = false;

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/api/retail/user/current/transactions/last")) {
      txApiSeen = true;
      try {
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          capturedTxs = json;
          fs.writeFileSync(rawTxsPath, JSON.stringify(json, null, 2));
        }
      } catch {
        // ignore
      }
    }
    if (url.includes("/api/retail/user/current/wallet") || url.includes("/api/retail/wallets")) {
      try {
        const json = await res.json();
        const walletObj = Array.isArray(json?.PERSONAL) ? json.PERSONAL[0] : json;
        if (walletObj && Array.isArray(walletObj.pockets)) {
          capturedWallet = walletObj;
          fs.writeFileSync(rawWalletPath, JSON.stringify(walletObj, null, 2));
        }
      } catch {
        // ignore
      }
    }
  });

  await page.goto("https://app.revolut.com/home", { timeout: 30000 }).catch(() => {});

  process.stdout.write("認証・データ受信待機中 ");
  const MAX_WAIT_SECONDS = 180;
  let lastLoggedUrl = page.url();
  for (let i = 0; i < MAX_WAIT_SECONDS; i++) {
    if (capturedTxs.length > 0 && capturedWallet !== null) {
      process.stdout.write(" [完了]\n");
      break;
    }
    const currentUrl = page.url();
    if (currentUrl !== lastLoggedUrl) {
      lastLoggedUrl = currentUrl;
      process.stdout.write(`\n  [${i}s] 遷移: ${currentUrl.slice(0, 120)}\n  `);
    }
    process.stdout.write(".");
    await page.waitForTimeout(1000);
  }
  console.log("");

  await context.close();

  if (!txApiSeen) {
    throw new Error(
      `Revolut の明細APIを ${MAX_WAIT_SECONDS} 秒待っても観測できませんでした。` +
        "ログインが完了していないか、signin から app.revolut.com/home へ戻っていません。" +
        "古いキャッシュで続行すると誤った残高になるため中止します。",
    );
  }

  if (capturedTxs.length === 0 && fs.existsSync(rawTxsPath)) {
    console.warn("最新明細APIがスキップされたため、キャッシュデータを使用します。");
    capturedTxs = JSON.parse(fs.readFileSync(rawTxsPath, "utf8"));
  }
  if (!capturedWallet && fs.existsSync(rawWalletPath)) {
    console.warn("最新ウォレットAPIがスキップされたため、キャッシュデータを使用します。");
    capturedWallet = JSON.parse(fs.readFileSync(rawWalletPath, "utf8"));
  }

  let totalBalanceJpy: number | null = null;
  if (capturedWallet) {
    totalBalanceJpy = await calculateTotalJpyBalance(capturedWallet);
  }

  console.log(`Revolut明細取得: ${capturedTxs.length} 件`);
  if (totalBalanceJpy !== null) {
    console.log(`Revolut総資産(円換算): ¥${totalBalanceJpy.toLocaleString()}`);
  }

  return { txs: capturedTxs, totalBalanceJpy };
}

async function syncToMoneyForward(txs: RevolutTx[], totalBalanceJpy: number | null) {
  let syncedIds = new Set<string>();
  if (fs.existsSync(syncedIdsPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(syncedIdsPath, "utf8"));
      syncedIds = new Set(list);
    } catch {
      // ignore
    }
  }

  const targetTxs = txs
    .filter((t) => t.state === "COMPLETED" && t.type !== "EXCHANGE" && !syncedIds.has(t.id))
    .sort((a, b) => a.startedDate - b.startedDate);

  console.log(`2. MoneyForwardへ未同期明細を登録中 (新規: ${targetTxs.length} 件)...`);

  const browser = await chromium.launch({ headless: true });
  const context = await createBrowserContext(browser, { useAuthState: true });
  const page = await context.newPage();
  await loginWithAuthState(page, context);

  // 1. 未同期明細の登録
  if (targetTxs.length > 0) {
    await page.goto("https://moneyforward.com/cf");
    const csrf = await getCsrfToken(page);
    if (!csrf) throw new Error("CSRF token not found");

    let successCount = 0;
    for (let i = 0; i < targetTxs.length; i++) {
      const tx = targetTxs[i]!;
      const isIncome = tx.amount > 0 || tx.type === "CARD_REFUND" || tx.type === "TOPUP";
      const absAmount = Math.abs(tx.amount);
      const dateStr = formatDate(tx.startedDate);
      const content = tx.description || "Revolut Payment";

      process.stdout.write(
        `[${i + 1}/${targetTxs.length}] ${dateStr} ${isIncome ? "収入" : "支出"} ¥${absAmount} - ${content} ... `,
      );

      const res = await page.evaluate(
        async ({ csrfToken, subAccountHash, date, amount, isInc, desc }) => {
          const formData = new URLSearchParams();
          formData.append("authenticity_token", csrfToken);
          formData.append("user_asset_act[is_transfer]", "0");
          formData.append("user_asset_act[is_income]", isInc ? "1" : "0");
          formData.append("user_asset_act[updated_at]", date);
          formData.append("user_asset_act[amount]", String(amount));
          formData.append("user_asset_act[sub_account_id_hash]", subAccountHash);
          formData.append("user_asset_act[large_category_id]", "");
          formData.append("user_asset_act[middle_category_id]", "");
          formData.append("user_asset_act[content]", desc);

          const response = await fetch("/cf/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-CSRF-Token": csrfToken,
              "X-Requested-With": "XMLHttpRequest",
            },
            body: formData.toString(),
          });
          return { ok: response.ok, status: response.status };
        },
        {
          csrfToken: csrf,
          subAccountHash: REVOLUT_SUB_ACCOUNT_HASH,
          date: dateStr,
          amount: absAmount,
          isInc: isIncome,
          desc: content,
        },
      );

      if (res.ok) {
        process.stdout.write("OK\n");
        syncedIds.add(tx.id);
        successCount++;
      } else {
        process.stdout.write(`FAILED (${res.status})\n`);
      }

      await page.waitForTimeout(150);
    }

    fs.writeFileSync(syncedIdsPath, JSON.stringify(Array.from(syncedIds), null, 2));
    console.log(`明細同期完了: ${successCount} 件登録`);
  } else {
    console.log("未同期の新規明細はありません。");
  }

  // 同期ステータスを記録
  const statePath = path.resolve(projectRoot, "data/revolut-sync-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        lastSyncedAt: new Date().toISOString(),
        syncedCount: syncedIds.size,
      },
      null,
      2,
    ),
  );

  // 2. 口座残高を最新のRevolut円換算残高へ自動修正
  if (totalBalanceJpy !== null) {
    console.log(
      `3. MF上のRevolut残高を最新の円換算残高 (¥${totalBalanceJpy.toLocaleString()}) に調整中...`,
    );
    const manualUrl = `https://moneyforward.com/accounts/show_manual/${REVOLUT_ACCOUNT_HASH}`;
    await page.goto(manualUrl);

    // 残高修正モーダルを開く
    await page.click("a[href='#modal_rollover']");
    await page.waitForSelector("#rollover_info_value", { state: "visible" });

    // 値を更新
    await page.fill("#rollover_info_value", String(totalBalanceJpy));
    await page.dispatchEvent("#rollover_info_value", "change");

    // 不明金として記帳するチェックを外す
    const isChecked = await page.isChecked("#rollover_info_transaction_flag");
    if (isChecked) {
      await page.uncheck("#rollover_info_transaction_flag");
    }

    // 送信
    await page.click("#rollover_form input[type='submit']");
    await page.waitForTimeout(4000);

    const bodyText = await page.locator("body").innerText();
    const balanceLine = bodyText
      .split("\n")
      .find((l) => l.includes("残高：") || (l.includes("残高") && l.includes("円")));
    console.log(`残高同期完了: ${balanceLine?.trim() || `¥${totalBalanceJpy.toLocaleString()}`}`);
  }

  await browser.close();
}

async function main() {
  const { txs, totalBalanceJpy } = await fetchRevolutData();
  await syncToMoneyForward(txs, totalBalanceJpy);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
