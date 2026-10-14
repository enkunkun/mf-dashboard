import { describe, expect, it } from "vitest";
import { parseCrawlerRefreshStatus } from "./crawler-refresh-status";

const successRun = {
  version: 1,
  runId: "run-a",
  runStatus: "success",
  source: "manual",
  startedAt: "2026-10-14T00:00:00.000Z",
  finishedAt: "2026-10-14T00:05:00.000Z",
  current: null,
  progress: { completed: 1, total: 1 },
  timeline: [],
  reason: null,
};

describe("parseCrawlerRefreshStatus", () => {
  it("reads the categorization summary of the latest run", () => {
    const status = parseCrawlerRefreshStatus({
      running: false,
      latestRun: { ...successRun, categorization: { applied: 693, skipped: 1593 } },
    });

    expect(status.latestRun?.categorization).toEqual({ applied: 693, skipped: 1593 });
  });

  it("treats a run without a categorization summary as having none", () => {
    const status = parseCrawlerRefreshStatus({ running: false, latestRun: successRun });

    expect(status.latestRun).not.toBeNull();
    expect(status.latestRun?.categorization).toBeUndefined();
  });

  it("drops a malformed categorization summary", () => {
    const status = parseCrawlerRefreshStatus({
      running: false,
      latestRun: { ...successRun, categorization: { applied: -1, skipped: 2 } },
    });

    expect(status.latestRun).not.toBeNull();
    expect(status.latestRun?.categorization).toBeUndefined();
  });
});
