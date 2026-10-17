/**
 * 家計簿の整理指示ファイル（JSON）に従って、MF の明細の分類と振替を直す。
 * 指示ファイルには個人の取引が入るので、リポジトリの外に置いてパスで渡す。
 *
 * - set_category: 一致が 1 件で、分類が MF に実在する時だけ書き換える
 * - cash_withdrawal: 現金口座が無い前提で fallback の分類を付ける
 * - link_transfer: 出金と入金を両方振替にし、互いの口座を振替先にする
 * - review: 触らない
 *
 * --patch には ID ごとの上書き（例: 小分類の指定）か、新しい ID の指示を書く。
 *
 * 使い方:
 *   tsx --env-file=../../.env scripts/mf-cleanup.ts <指示.json> [--patch <patch.json>] [--only ME-001,ME-002]           # dry-run
 *   tsx --env-file=../../.env scripts/mf-cleanup.ts <指示.json> [--patch <patch.json>] [--only ME-001,ME-002] --apply
 */
import { readFileSync } from "node:fs";
import type { CashFlowItem } from "@mf-dashboard/db/types";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loginWithAuthState } from "../src/auth/login.js";
import { createBrowserContext } from "../src/browser/context.js";
import type { CategoryCandidate } from "../src/category-decision/types.js";
import { getCsrfToken, updateTransactionCategory } from "../src/hooks/helpers.js";
import {
  planLinkTransfer,
  planSetCategory,
  type CleanupMatch,
  type CleanupPlan,
  type LinkTransferOperation,
  type LinkTransferPlan,
  type SetCategoryOperation,
} from "../src/mf-cleanup.js";
import { extractCashFlowFromPage, goToCashFlowMonth } from "../src/scrapers/cash-flow-history.js";
import { scrapeCategoryCandidates } from "../src/scrapers/category-candidates.js";

interface RawOperation {
  id: string;
  action: string;
  match?: CleanupMatch;
  target?: SetCategoryOperation["target"];
  fallback?: SetCategoryOperation["target"];
  outflow?: CleanupMatch;
  inflow?: CleanupMatch;
}

interface CleanupFile {
  period: [string, string];
  operations: RawOperation[];
  manual_review?: RawOperation[];
}

type Operation = SetCategoryOperation | LinkTransferOperation;

function arg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function loadOperations(file: CleanupFile, patchPath: string | undefined): Operation[] {
  const patch = patchPath
    ? (JSON.parse(readFileSync(patchPath, "utf8")) as Record<string, Partial<RawOperation>>)
    : {};
  const raw = file.operations.map((op) => ({ ...op, ...patch[op.id], id: op.id }));
  const known = new Set(raw.map((op) => op.id));
  for (const [id, op] of Object.entries(patch)) {
    if (!known.has(id)) raw.push({ ...(op as RawOperation), id });
  }

  return raw.flatMap((op): Operation[] => {
    if (op.action === "set_category" && op.match && op.target) {
      return [{ id: op.id, action: "set_category", match: op.match, target: op.target }];
    }
    if (op.action === "cash_withdrawal" && op.match && op.fallback) {
      return [
        { id: op.id, action: "set_category", match: op.match, target: op.target ?? op.fallback },
      ];
    }
    if (op.action === "link_transfer" && op.outflow && op.inflow) {
      return [{ id: op.id, action: "link_transfer", outflow: op.outflow, inflow: op.inflow }];
    }
    if (op.action !== "skip") console.log(`${op.id}: 未対応の指示 ${op.action}`);
    return [];
  });
}

/** 締め日のずれで隣の月のページに載る明細もあるので、期間の前後 1 か月も読む */
function monthsAround([start, end]: [string, string]): string[] {
  const months: string[] = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  const last = new Date(`${end.slice(0, 7)}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1);
  while (cursor <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

interface Snapshot {
  items: CashFlowItem[];
  monthByMfId: Map<string, string>;
}

async function readMonths(page: Page, months: string[]): Promise<Snapshot> {
  const items: CashFlowItem[] = [];
  const monthByMfId = new Map<string, string>();
  for (const month of months) {
    await goToCashFlowMonth(page, month);
    for (const item of (await extractCashFlowFromPage(page)).items) {
      if (monthByMfId.has(item.mfId)) continue;
      monthByMfId.set(item.mfId, month);
      items.push(item);
    }
  }
  return { items, monthByMfId };
}

type Plan = CleanupPlan | LinkTransferPlan;

function planAll(operations: Operation[], items: CashFlowItem[], candidates: CategoryCandidate[]) {
  return operations.map((op): { op: Operation; plan: Plan } => ({
    op,
    plan:
      op.action === "set_category"
        ? planSetCategory(op, items, candidates)
        : planLinkTransfer(op, items),
  }));
}

function report(plans: { op: Operation; plan: Plan }[]): void {
  const counts = new Map<string, number>();
  for (const { op, plan } of plans) {
    counts.set(plan.status, (counts.get(plan.status) ?? 0) + 1);
    let detail = "";
    if ("reason" in plan) detail = plan.reason;
    else if (plan.status === "apply" && "candidate" in plan) {
      detail = `${plan.item.category}/${plan.item.subCategory} → ${plan.candidate.largeCategoryName}/${plan.candidate.middleCategoryName}`;
    } else if (plan.status === "apply" && op.action === "link_transfer") {
      detail = `${op.outflow.account} → ${op.inflow.account} を振替にする`;
    }
    console.log(`  ${op.id.padEnd(8)} ${plan.status.padEnd(6)} ${detail}`);
  }
  console.log(`  集計: ${[...counts].map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

async function enableTransfer(page: Page, mfId: string, token: string): Promise<number> {
  return await page.evaluate(
    async ({ mfId, token }) => {
      const r = await fetch(`/cf/update.js?change_type=enable_transfer&id=${mfId}`, {
        headers: { "X-CSRF-Token": token, "X-Requested-With": "XMLHttpRequest" },
      });
      return r.status;
    },
    { mfId, token },
  );
}

/** 振替先はモーダルの選択肢から口座名で選ぶ。同名の口座が複数あれば選ばない */
async function setTransferPartner(page: Page, mfId: string, partner: string): Promise<string> {
  const anchor = page.locator(`#change_act_type_${mfId}`);
  if ((await anchor.count()) === 0) return "振替先リンクが無い";
  await anchor.click();
  // 選択肢はモーダルを開いてから読み込まれる
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll(
          '#modal_change_act_type select[name="user_asset_act[partner_account_id_hash]"] option',
        ).length > 1,
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});
  const select = page.locator(
    '#modal_change_act_type select[name="user_asset_act[partner_account_id_hash]"]',
  );
  const labels = await select.locator("option").allTextContents();
  const hits = labels.filter((label) => label.trim() === partner).length;
  if (hits !== 1) {
    await page.keyboard.press("Escape");
    return `振替先 ${partner} の候補が ${hits} 件（選択肢: ${labels.map((l) => l.trim()).join(", ")}）`;
  }
  await select.selectOption({ label: partner });
  await page.click('#modal_change_act_type input[name="commit"]');
  await page.waitForTimeout(1600);
  const stillOpen = await page.evaluate(
    () => document.querySelector("#modal_change_act_type")?.classList.contains("in") ?? false,
  );
  return stillOpen ? "モーダルが閉じない" : "OK";
}

type TransferApply = {
  op: LinkTransferOperation;
  plan: Extract<LinkTransferPlan, { status: "apply" }>;
};

function transferApplies(plans: { op: Operation; plan: Plan }[]): TransferApply[] {
  return plans.flatMap(({ op, plan }) =>
    op.action === "link_transfer" && plan.status === "apply" && "outflow" in plan
      ? [{ op, plan }]
      : [],
  );
}

async function applyPlans(
  page: Page,
  plans: { op: Operation; plan: Plan }[],
  monthByMfId: Map<string, string>,
  reread: () => Promise<{
    plans: { op: Operation; plan: Plan }[];
    monthByMfId: Map<string, string>;
  }>,
): Promise<void> {
  const byMonth = new Map<string, Extract<CleanupPlan, { status: "apply" }>[]>();
  for (const { plan } of plans) {
    if (plan.status !== "apply" || !("candidate" in plan)) continue;
    const month = monthByMfId.get(plan.item.mfId)!;
    byMonth.set(month, [...(byMonth.get(month) ?? []), plan]);
  }

  for (const [month, monthPlans] of byMonth) {
    await goToCashFlowMonth(page, month);
    const token = await getCsrfToken(page);
    if (!token) throw new Error("CSRF token not found");
    for (const plan of monthPlans) {
      const result = await updateTransactionCategory(page, token, plan.item.mfId, {
        largeCategoryId: plan.candidate.largeCategoryId,
        middleCategoryId: plan.candidate.middleCategoryId,
        isIncome: plan.candidate.isIncome,
        isTarget: !plan.item.isExcludedFromCalculation,
      });
      console.log(`  分類 ${plan.id}: status=${result.status}`);
      await page.waitForTimeout(300);
    }
  }

  // enable_transfer は表示を更新せず、直後に開き直してもモーダルの選択肢が読み込まれない。
  // 先に全件を振替化し、全月を読み直してから振替先を選ぶ
  let transfers = transferApplies(plans);
  let enabled = 0;
  for (const { plan } of transfers) {
    for (const item of [plan.outflow, plan.inflow]) {
      if (item.type === "transfer") continue;
      await goToCashFlowMonth(page, monthByMfId.get(item.mfId)!);
      const token = await getCsrfToken(page);
      if (!token) throw new Error("CSRF token not found");
      console.log(`  振替化 ${plan.id}: status=${await enableTransfer(page, item.mfId, token)}`);
      enabled++;
    }
  }
  if (enabled > 0) {
    const reloaded = await reread();
    transfers = transferApplies(reloaded.plans);
    monthByMfId = reloaded.monthByMfId;
  }

  for (const { op, plan } of transfers) {
    const sides = [
      { item: plan.outflow, partner: op.inflow.account },
      { item: plan.inflow, partner: op.outflow.account },
    ];
    for (const side of sides) {
      await goToCashFlowMonth(page, monthByMfId.get(side.item.mfId)!);
      console.log(
        `  振替先 ${plan.id} → ${side.partner}: ${await setTransferPartner(page, side.item.mfId, side.partner)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filePath = args[0];
  if (!filePath || filePath.startsWith("--")) throw new Error("指示ファイルのパスを渡す");
  const apply = args.includes("--apply");
  const only = arg(args, "--only")?.split(",");

  const file = JSON.parse(readFileSync(filePath, "utf8")) as CleanupFile;
  const operations = loadOperations(file, arg(args, "--patch")).filter(
    (op) => !only || only.includes(op.id),
  );
  const months = monthsAround(file.period);

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  try {
    const context = await createBrowserContext(browser, { useAuthState: true });
    const page = await context.newPage();
    await loginWithAuthState(page, context);

    const candidates = await scrapeCategoryCandidates(page);
    const before = await readMonths(page, months);
    const plans = planAll(operations, before.items, candidates);
    console.log(`${months.join(", ")} の明細 ${before.items.length} 件に対する計画:`);
    report(plans);
    for (const review of file.manual_review ?? [])
      console.log(`  ${review.id.padEnd(8)} review 触らない`);

    if (!apply) {
      console.log("\ndry-run 完了（--apply を付けると書き換える）");
      return;
    }

    console.log("\n適用:");
    await applyPlans(page, plans, before.monthByMfId, async () => {
      const snapshot = await readMonths(page, months);
      return {
        plans: planAll(operations, snapshot.items, candidates),
        monthByMfId: snapshot.monthByMfId,
      };
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    const after = await readMonths(page, months);
    console.log("\n適用後の再照合:");
    report(planAll(operations, after.items, candidates));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
