import { closeDb } from "@mf-dashboard/db";
import { getAllGroups } from "@mf-dashboard/db/queries/groups";
import { resolveAiApiKey } from "./auth/credentials.js";
import { buildCleanupGroupIds } from "./cleanup-groups.js";
import {
  handleCrawlerFailure,
  runAnalyticsPhase,
  runAuthPhase,
  runCashFlowHistoryPhase,
  runInstitutionCategoryPhase,
  runLoadPhase,
  runNotificationPhase,
  runSavePhase,
  runScrapePhase,
  runSetupPhase,
  type CrawlerRuntime,
} from "./crawler-phases.js";
import {
  CRAWLER_STEPS,
  normalizeCrawlerError,
  runCrawlerStep,
  type CrawlerProgressReporter,
} from "./crawler-progress.js";
import { error, info, warn } from "./logger.js";
import { applyMoneyForwardOperation } from "./moneyforward/operations.js";
import { createGroupScope, NO_GROUP_ID, switchGroup } from "./scrapers/group.js";
import { notifyWebRefresh } from "./web-refresh.js";

async function disposeGroupScope(
  groupScope: Awaited<ReturnType<typeof createGroupScope>>,
  crawlFailed: boolean,
): Promise<void> {
  try {
    await groupScope[Symbol.asyncDispose]();
  } catch (restoreError) {
    if (!crawlFailed) throw restoreError;
    warn("Group restoration also failed after the crawl had already failed");
  }
}

export async function runCrawler(
  progress: CrawlerProgressReporter,
  options: {
    month?: string;
    categorizeUncategorized?: boolean;
    operation?: import("./moneyforward/operations.js").MoneyForwardOperation;
  } = {},
): Promise<void> {
  await resolveAiApiKey();
  const config = runLoadPhase(options.month);
  let runtime: CrawlerRuntime | null = null;

  try {
    const activeRuntime = await runSetupPhase(config);
    runtime = activeRuntime;
    await runCrawlerStep(
      progress,
      CRAWLER_STEPS.authentication,
      () => runAuthPhase(activeRuntime.page, activeRuntime.context),
      { failureCode: "auth_failed" },
    );

    if (options.operation) {
      if (!config.targetMonth) throw new Error("MoneyForward operations require a target month");
      await runCrawlerStep(
        progress,
        CRAWLER_STEPS.monthlyCashFlow,
        async () => {
          await switchGroup(activeRuntime.page, NO_GROUP_ID);
          await applyMoneyForwardOperation(activeRuntime.page, {
            ...options.operation!,
            month: config.targetMonth!,
          });
        },
        { metadata: { month: config.targetMonth } },
      );
    }

    if (config.targetMonth) {
      if (options.categorizeUncategorized && !activeRuntime.categoryDecision.config) {
        throw new Error("Uncategorized classification is not configured");
      }
      await runCrawlerStep(progress, CRAWLER_STEPS.databaseSave, () =>
        runCashFlowHistoryPhase(
          activeRuntime.db,
          activeRuntime.page,
          {
            isHistoryMode: false,
            targetMonth: config.targetMonth,
            includeExistingUncategorized: options.categorizeUncategorized === true,
          },
          activeRuntime.categoryDecision,
          progress,
        ),
      );
      const groups = await getAllGroups(activeRuntime.db);
      await runCrawlerStep(progress, CRAWLER_STEPS.analytics, () =>
        runAnalyticsPhase(
          activeRuntime.db,
          groups.map((group) => ({ group })),
        ),
      );
      const webRefreshStep = await progress.startStep(CRAWLER_STEPS.webCacheRefresh);
      try {
        await notifyWebRefresh();
        await progress.completeStep(webRefreshStep);
      } catch (err) {
        await progress.warnStep(
          webRefreshStep,
          normalizeCrawlerError(err, "web_cache_refresh_failed"),
        );
        error("Failed to refresh web cache:", err);
      }
      info(`Reimported MoneyForward cash flow for ${config.targetMonth}`);
      return;
    }

    let scrapeResult: Awaited<ReturnType<typeof runScrapePhase>>;
    let originalGroup: Awaited<ReturnType<typeof createGroupScope>>["originalGroup"];
    const groupScope = await createGroupScope(activeRuntime.page);
    let crawlFailed = false;
    try {
      originalGroup = groupScope.originalGroup;
      scrapeResult = await runScrapePhase(activeRuntime.page, config, progress);
      const cleanupResult = config.cleanupGroups
        ? buildCleanupGroupIds(scrapeResult.groupDataList)
        : null;
      if (config.cleanupGroups && !cleanupResult) {
        warn(
          "Skipped group cleanup because no groups were scraped; group selector retrieval may have failed.",
        );
      }
      const institutionCategories = await runCrawlerStep(
        progress,
        CRAWLER_STEPS.institutionCategories,
        () => runInstitutionCategoryPhase(activeRuntime.page),
      );
      await runCrawlerStep(progress, CRAWLER_STEPS.databaseSave, () =>
        runCashFlowHistoryPhase(
          activeRuntime.db,
          activeRuntime.page,
          {
            ...config,
            activeAccountingMonth: scrapeResult.globalData.cashFlow.month,
          },
          activeRuntime.categoryDecision,
          progress,
          async (historyMonths) => {
            const savedCounts = await runSavePhase(
              activeRuntime.db,
              activeRuntime.page,
              scrapeResult,
              activeRuntime.categoryDecision,
              historyMonths,
              cleanupResult?.ids,
              institutionCategories,
            );
            if (cleanupResult) info("Cleaned up groups not found in MoneyForward");
            return savedCounts;
          },
        ),
      );
      await runCrawlerStep(progress, CRAWLER_STEPS.analytics, () =>
        runAnalyticsPhase(activeRuntime.db, scrapeResult.groupDataList),
      );
    } catch (err) {
      crawlFailed = true;
      throw err;
    } finally {
      await disposeGroupScope(groupScope, crawlFailed);
    }
    const notificationStep = await progress.startStep(CRAWLER_STEPS.notification);
    const notificationFailure = await runNotificationPhase(
      scrapeResult.groupDataList,
      originalGroup,
    );
    if (notificationFailure) {
      await progress.warnStep(
        notificationStep,
        normalizeCrawlerError(notificationFailure, "notification_failed"),
      );
    } else {
      await progress.completeStep(notificationStep);
    }

    const webRefreshStep = await progress.startStep(CRAWLER_STEPS.webCacheRefresh);
    try {
      await notifyWebRefresh();
      await progress.completeStep(webRefreshStep);
    } catch (err) {
      await progress.warnStep(
        webRefreshStep,
        normalizeCrawlerError(err, "web_cache_refresh_failed"),
      );
      error("Failed to refresh web cache:", err);
    }

    info("Completed!");
  } catch (err) {
    await handleCrawlerFailure(err, runtime?.page, config);
    throw err;
  } finally {
    try {
      if (runtime) {
        await runtime.browser.close();
      }
    } finally {
      closeDb();
    }
  }
}
