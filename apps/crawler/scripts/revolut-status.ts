import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const statePath = path.resolve(projectRoot, "data/revolut-sync-state.json");
const syncedIdsPath = path.resolve(projectRoot, "data/revolut-synced-ids.json");

function main() {
  let lastSyncedAt: Date | null = null;
  let count = 0;

  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.lastSyncedAt) {
        lastSyncedAt = new Date(state.lastSyncedAt);
      }
      count = state.syncedCount || 0;
    } catch {}
  }

  if (!lastSyncedAt && fs.existsSync(syncedIdsPath)) {
    try {
      const stats = fs.statSync(syncedIdsPath);
      lastSyncedAt = stats.mtime;
      const ids = JSON.parse(fs.readFileSync(syncedIdsPath, "utf8"));
      count = Array.isArray(ids) ? ids.length : 0;
    } catch {}
  }

  console.log("=========================================");
  console.log("   Revolut ⇄ MoneyForward 同期ステータス");
  console.log("=========================================");

  if (!lastSyncedAt) {
    console.log("ステータス: 未同期（一度も同期されていません）");
    console.log("次のアクション: pnpm sync:revolut を実行してください");
    return;
  }

  const now = new Date();
  const diffMs = now.getTime() - lastSyncedAt.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  const formattedDate = lastSyncedAt.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  console.log(`最終同期日時: ${formattedDate} (${diffDays === 0 ? `${diffHours}時間前` : `${diffDays}日前`})`);
  console.log(`同期済み件数: ${count} 件`);

  if (diffDays >= 7) {
    console.log("\n⚠️  警告: 最終同期から1週間以上経過しています！");
    console.log("👉 pnpm sync:revolut で差分を同期してください。");
  } else if (diffDays >= 3) {
    console.log("\nℹ️  注意: 最終同期から3日以上経過しています。");
    console.log("👉 最近Revolutで決済した場合は pnpm sync:revolut を実行してください。");
  } else {
    console.log("\n✅ 直近で同期されています（同期状態は良好です）。");
  }
  console.log("=========================================\n");
}

main();
