import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  handleCrawlerFailure,
  runAnalyticsPhase,
  runAuthPhase,
  runCashFlowHistoryPhase,
  runExistingCashFlowCategorizationPhase,
  runInstitutionCategoryPhase,
  runLoadPhase,
  runNotificationPhase,
  runSavePhase,
  runScrapePhase,
  runSetupPhase,
} from "./crawler-phases.js";
import { CRAWLER_STEPS, createCrawlerProgressReporter } from "./crawler-progress.js";
import { runCrawler } from "./run.js";
import { createGroupScope } from "./scrapers/group.js";
import { notifyWebRefresh } from "./web-refresh.js";

vi.mock("@mf-dashboard/db", () => ({
  closeDb: vi.fn<() => void>(),
  getAvailableMonths: vi.fn<() => Promise<Array<{ month: string }>>>(),
}));
vi.mock("@mf-dashboard/db/queries/groups", () => ({
  getAllGroups: vi.fn<() => Promise<Array<{ id: string; name: string }>>>(),
}));
vi.mock("./crawler-phases.js", () => ({
  handleCrawlerFailure: vi.fn<() => void>(),
  runAnalyticsPhase: vi.fn<() => void>(),
  runAuthPhase: vi.fn<() => void>(),
  runCashFlowHistoryPhase: vi.fn<() => void>(),
  runExistingCashFlowCategorizationPhase: vi.fn<() => Promise<number>>().mockResolvedValue(0),
  runInstitutionCategoryPhase: vi.fn<() => Map<string, string>>(),
  runLoadPhase: vi.fn<() => void>(),
  runNotificationPhase: vi.fn<() => void>(),
  runSavePhase: vi.fn<() => void>(),
  runScrapePhase: vi.fn<() => void>(),
  runSetupPhase: vi.fn<() => void>(),
}));
vi.mock("./scrapers/group.js", () => ({ createGroupScope: vi.fn<() => void>() }));
vi.mock("./web-refresh.js", () => ({ notifyWebRefresh: vi.fn<() => void>() }));

let tempDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "crawler-run-progress-"));
  vi.mocked(runLoadPhase).mockReturnValue({
    skipRefresh: false,
    cleanupGroups: false,
    authState: "configured",
    dbPath: "/tmp/demo.db",
    dbExists: true,
    scrapeMode: "month",
    isHistoryMode: false,
    isDebug: false,
    isHeaded: false,
  });
  vi.mocked(runSetupPhase).mockResolvedValue({
    db: {} as never,
    browser: { close: vi.fn<() => Promise<void>>() } as never,
    context: {} as never,
    page: {} as never,
    categoryDecision: { config: null, usage: { llmCallsUsed: 0 } },
  });
  vi.mocked(createGroupScope).mockResolvedValue({
    originalGroup: null,
    [Symbol.asyncDispose]: vi.fn<() => Promise<void>>(),
  });
  vi.mocked(runNotificationPhase).mockResolvedValue(null);
  const { getAllGroups } = await import("@mf-dashboard/db/queries/groups");
  vi.mocked(getAllGroups).mockResolvedValue([
    {
      id: "group-a",
      name: "Group A",
      isCurrent: true,
      lastScrapedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  vi.mocked(notifyWebRefresh).mockResolvedValue(undefined);
  vi.mocked(runSavePhase).mockResolvedValue([]);
  vi.mocked(runInstitutionCategoryPhase).mockResolvedValue(new Map([["account-a", "銀行"]]));
  vi.mocked(runCashFlowHistoryPhase).mockImplementation(
    async (_db, _page, _config, _categoryDecision, _progress, publishHistory) => {
      if (publishHistory) await publishHistory([]);
    },
  );
  vi.mocked(runScrapePhase).mockImplementation(async (_page, _config, progress) => {
    for (const [step, metadata] of [
      [CRAWLER_STEPS.groupList],
      [CRAWLER_STEPS.refresh],
      [CRAWLER_STEPS.registeredAccounts],
      [CRAWLER_STEPS.portfolio],
      [CRAWLER_STEPS.liabilities],
      [CRAWLER_STEPS.monthlyCashFlow, { month: "2026-07" }],
      [CRAWLER_STEPS.groupData, { groupName: "Group A" }],
    ] as const) {
      const stepId = await progress.startStep(step, metadata);
      await progress.completeStep(stepId);
    }
    return {
      defaultGroup: null,
      globalData: {
        registeredAccounts: { accounts: [] },
        portfolio: { items: [], totalAssets: 0 },
        liabilities: { items: [], totalLiabilities: 0 },
        cashFlow: {
          month: "2026-07",
          totalIncome: 0,
          totalExpense: 0,
          balance: 0,
          items: [],
        },
        refreshResult: { completed: true, incompleteAccounts: [] },
      },
      groupDataList: [],
    };
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("runCrawler progress", () => {
  test("分類設定がない場合は全期間の未分類再処理を開始しない", async () => {
    const progress = await createCrawlerProgressReporter(
      path.join(tempDir, "all-months-disabled.json"),
      {
        id: "run-all-months-disabled",
        source: "test",
        startedAt: "2026-07-01T00:00:00.000Z",
      },
    );

    await expect(
      runCrawler(progress, { allMonths: true, categorizeUncategorized: true }),
    ).rejects.toThrow("All-month uncategorized classification is not configured");

    expect(runCashFlowHistoryPhase).not.toHaveBeenCalled();
    expect(handleCrawlerFailure).toHaveBeenCalled();
  });

  test("全期間分類は新しい月から既存の未分類明細を順番に再処理する", async () => {
    const { getAvailableMonths } = await import("@mf-dashboard/db");
    vi.mocked(getAvailableMonths).mockResolvedValue([{ month: "2026-08" }, { month: "2026-09" }]);
    vi.mocked(runSetupPhase).mockResolvedValueOnce({
      db: {} as never,
      browser: { close: vi.fn<() => Promise<void>>() } as never,
      context: {} as never,
      page: {} as never,
      categoryDecision: { config: {} as never, usage: { llmCallsUsed: 0 } },
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "all-months.json"), {
      id: "run-all-months",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress, { allMonths: true, categorizeUncategorized: true });

    // 取得はせず、既存の未分類明細だけを再処理する
    expect(runExistingCashFlowCategorizationPhase).toHaveBeenCalledOnce();
    expect(runCashFlowHistoryPhase).not.toHaveBeenCalled();
    expect(runScrapePhase).not.toHaveBeenCalled();
    expect(runAnalyticsPhase).toHaveBeenCalledOnce();
  });

  test("分類設定がない場合は未分類取引の再処理を開始しない", async () => {
    vi.mocked(runLoadPhase).mockReturnValueOnce({
      skipRefresh: false,
      cleanupGroups: false,
      authState: "configured",
      dbPath: "/tmp/demo.db",
      dbExists: true,
      scrapeMode: "month",
      isHistoryMode: false,
      isDebug: false,
      isHeaded: false,
      targetMonth: "2025-07",
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "uncategorized.json"), {
      id: "run-uncategorized",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(
      runCrawler(progress, { month: "2025-07", categorizeUncategorized: true }),
    ).rejects.toThrow("Uncategorized classification is not configured");

    expect(runCashFlowHistoryPhase).not.toHaveBeenCalled();
    expect(handleCrawlerFailure).toHaveBeenCalled();
  });

  test("指定月の再取り込みは全口座スクレイプをせず対象月と分析だけ更新する", async () => {
    vi.mocked(runLoadPhase).mockReturnValueOnce({
      skipRefresh: false,
      cleanupGroups: false,
      authState: "configured",
      dbPath: "/tmp/demo.db",
      dbExists: true,
      scrapeMode: "month",
      isHistoryMode: false,
      isDebug: false,
      isHeaded: false,
      targetMonth: "2025-07",
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "targeted.json"), {
      id: "run-targeted",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress, { month: "2025-07" });

    expect(runCashFlowHistoryPhase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ targetMonth: "2025-07" }),
      expect.anything(),
      expect.anything(),
    );
    expect(runScrapePhase).not.toHaveBeenCalled();
    expect(runSavePhase).not.toHaveBeenCalled();
    expect(runInstitutionCategoryPhase).not.toHaveBeenCalled();
    expect(runAnalyticsPhase).toHaveBeenCalledWith(expect.anything(), [
      {
        group: expect.objectContaining({ id: "group-a", name: "Group A" }),
      },
    ]);
  });

  test("複数月の再取り込みは指定順に各月を取り込み、分析と web 更新は最後に 1 回だけ行う", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "months.json"), {
      id: "run-months",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress, { months: ["2026-09", "2025-07"] });

    expect(vi.mocked(runCashFlowHistoryPhase).mock.calls.map(([, , options]) => options)).toEqual([
      expect.objectContaining({ targetMonth: "2026-09", includeExistingUncategorized: false }),
      expect.objectContaining({ targetMonth: "2025-07", includeExistingUncategorized: false }),
    ]);
    expect(runScrapePhase).not.toHaveBeenCalled();
    expect(runSavePhase).not.toHaveBeenCalled();
    expect(runAnalyticsPhase).toHaveBeenCalledOnce();
    expect(notifyWebRefresh).toHaveBeenCalledOnce();
  });

  test("複数月の再取り込みは途中の月で失敗すると後続の月と分析を実行しない", async () => {
    vi.mocked(runCashFlowHistoryPhase).mockRejectedValueOnce(
      new Error("MoneyForward does not have cash flow data for 2026-09"),
    );
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "months-failed.json"), {
      id: "run-months-failed",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(runCrawler(progress, { months: ["2026-09", "2025-07"] })).rejects.toThrow(
      "MoneyForward does not have cash flow data for 2026-09",
    );

    expect(runCashFlowHistoryPhase).toHaveBeenCalledOnce();
    expect(runAnalyticsPhase).not.toHaveBeenCalled();
    expect(notifyWebRefresh).not.toHaveBeenCalled();
    expect(handleCrawlerFailure).toHaveBeenCalled();
  });

  test("認証失敗時はスクレイプを開始しない", async () => {
    const authError = new Error("Login failed");
    vi.mocked(runAuthPhase).mockRejectedValueOnce(authError);
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(runCrawler(progress)).rejects.toBe(authError);

    expect(runScrapePhase).not.toHaveBeenCalled();
    expect(createGroupScope).not.toHaveBeenCalled();
    expect(handleCrawlerFailure).toHaveBeenCalledWith(
      authError,
      expect.anything(),
      expect.anything(),
    );
  });

  test("atomic database save失敗を database save step に記録する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(runSavePhase).mockRejectedValueOnce(new Error("database cleanup failed"));

    await expect(runCrawler(progress)).rejects.toThrow("database cleanup failed");

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({ step: "database_save", status: "failed" }),
    );
  });

  test("通常成功でユーザー向けの全 step を順に記録する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress);
    await progress.finish("success");

    expect(progress.getState().runStatus).toBe("success");
    expect(progress.getState().timeline.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "authentication", status: "done" },
      { step: "group_list", status: "done" },
      { step: "moneyforward_refresh", status: "done" },
      { step: "registered_accounts", status: "done" },
      { step: "portfolio", status: "done" },
      { step: "liabilities", status: "done" },
      { step: "cash_flow_history", status: "done" },
      { step: "group_data", status: "done" },
      { step: "institution_categories", status: "done" },
      { step: "database_save", status: "done" },
      { step: "analytics", status: "done" },
      { step: "notification", status: "done" },
      { step: "web_cache_refresh", status: "done" },
    ]);
    expect(runAuthPhase).toHaveBeenCalledOnce();
    expect(runSavePhase).toHaveBeenCalledOnce();
    expect(runInstitutionCategoryPhase).toHaveBeenCalledOnce();
    expect(runCashFlowHistoryPhase).toHaveBeenCalledOnce();
    expect(runCashFlowHistoryPhase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ activeAccountingMonth: "2026-07" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(runAnalyticsPhase).toHaveBeenCalledOnce();
  });

  test("グループ復元を完了してから成功通知を送る", async () => {
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.mocked(createGroupScope).mockResolvedValueOnce({
      originalGroup: null,
      [Symbol.asyncDispose]: dispose,
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress);

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runNotificationPhase).mock.invocationCallOrder[0]!,
    );
  });

  test("グループ復元に失敗した場合は成功通知とweb refreshを実行しない", async () => {
    const restoreError = new Error("Group switch timed out");
    vi.mocked(createGroupScope).mockResolvedValueOnce({
      originalGroup: null,
      [Symbol.asyncDispose]: vi.fn<() => Promise<void>>().mockRejectedValue(restoreError),
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(runCrawler(progress)).rejects.toThrow("Group switch timed out");

    expect(runNotificationPhase).not.toHaveBeenCalled();
    expect(notifyWebRefresh).not.toHaveBeenCalled();
    expect(handleCrawlerFailure).toHaveBeenCalledWith(
      restoreError,
      expect.anything(),
      expect.anything(),
    );
  });

  test("crawlとグループ復元が両方失敗した場合は元のcrawl errorを保持する", async () => {
    const crawlError = new Error("portfolio scrape failed");
    const restoreError = new Error("Group switch timed out");
    vi.mocked(runScrapePhase).mockRejectedValueOnce(crawlError);
    vi.mocked(createGroupScope).mockResolvedValueOnce({
      originalGroup: null,
      [Symbol.asyncDispose]: vi.fn<() => Promise<void>>().mockRejectedValue(restoreError),
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(runCrawler(progress)).rejects.toBe(crawlError);
    expect(handleCrawlerFailure).toHaveBeenCalledWith(
      crawlError,
      expect.anything(),
      expect.anything(),
    );
  });

  test("history replacementsをcurrent dataと同じsave phaseへ渡す", async () => {
    vi.mocked(runLoadPhase).mockReturnValue({
      skipRefresh: false,
      cleanupGroups: false,
      authState: "configured",
      dbPath: "/tmp/demo.db",
      dbExists: true,
      scrapeMode: "history",
      isHistoryMode: true,
      isDebug: false,
      isHeaded: false,
    });
    const historyMonths = [{ items: [], month: "2026-06" }];
    vi.mocked(runCashFlowHistoryPhase).mockImplementation(
      async (_db, _page, _config, _categoryDecision, _progress, publishHistory) => {
        if (!publishHistory) throw new Error("publishHistory is required");
        await publishHistory(historyMonths);
      },
    );
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await runCrawler(progress);

    expect(runSavePhase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      historyMonths,
      undefined,
      new Map([["account-a", "銀行"]]),
    );
  });
});
