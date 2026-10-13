// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassifyUncategorizedButton } from "./classify-uncategorized-button";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn<() => void>() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

class EventSourceMock {
  static instances: EventSourceMock[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn<() => void>();

  constructor(_url: string) {
    EventSourceMock.instances.push(this);
  }
}

describe("ClassifyUncategorizedButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    EventSourceMock.instances = [];
  });

  it("starts classification for the displayed month and reports that it started", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("EventSource", EventSourceMock);
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    render(<ClassifyUncategorizedButton month="2026-10" />);

    fireEvent.click(screen.getByRole("button", { name: "未分類をAI分類" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/crawler/refresh/",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ month: "2026-10", categorizeUncategorized: true }),
        }),
      ),
    );
    expect(await screen.findByText(/分類と再取り込みを開始しました/)).toBeTruthy();
  });

  it("starts classification for all months after explaining the full-period update", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("EventSource", EventSourceMock);
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    render(<ClassifyUncategorizedButton allMonths />);

    fireEvent.click(screen.getByRole("button", { name: "未分類を全期間一括処理" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("データがある全期間"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/crawler/refresh/",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ allMonths: true, categorizeUncategorized: true }),
        }),
      ),
    );
    expect(await screen.findByText(/分類と再取り込みを開始しました/)).toBeTruthy();
  });

  it("prevents duplicate starts while the request is pending", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("EventSource", EventSourceMock);
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(global, "fetch").mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<ClassifyUncategorizedButton month="2026-10" />);
    const button = screen.getByRole("button", { name: "未分類をAI分類" });

    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "開始中…" }).hasAttribute("disabled")).toBe(true);
    resolveFetch(new Response(null, { status: 202 }));
    await screen.findByText(/分類と再取り込みを開始しました/);
    expect(screen.getByRole("button", { name: "分類を開始済み" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("does not start until the user confirms the AI and MoneyForward update", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.spyOn(global, "fetch");
    render(<ClassifyUncategorizedButton month="2026-10" />);

    fireEvent.click(screen.getByRole("button", { name: "未分類をAI分類" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-enables after the run finishes and refreshes the displayed data", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("EventSource", EventSourceMock);
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    render(<ClassifyUncategorizedButton month="2026-10" />);
    fireEvent.click(screen.getByRole("button", { name: "未分類をAI分類" }));

    await screen.findByRole("button", { name: "分類を開始済み" });
    const eventSource = EventSourceMock.instances[0]!;
    eventSource.onmessage?.({
      data: JSON.stringify({
        available: true,
        running: false,
        source: "manual",
        startedAt: "2026-10-11T00:00:00.000Z",
        latestRun: {
          version: 1,
          runId: "run-a",
          source: "manual",
          startedAt: "2026-10-11T00:00:00.000Z",
          finishedAt: "2026-10-11T00:01:00.000Z",
          timeline: [],
          runStatus: "success",
          current: null,
          progress: { completed: 1, total: 1 },
          reason: null,
        },
      }),
    } as MessageEvent<string>);

    expect(await screen.findByRole("button", { name: "未分類をAI分類" })).toBeTruthy();
    expect(routerRefresh).toHaveBeenCalledOnce();
    expect(await screen.findByText("分類と再取り込みが完了しました。")).toBeTruthy();
  });
});
