import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyMoneyForwardOperation } from "./operations.js";

const mocks = vi.hoisted(() => ({
  scrapeCashFlowHistory: vi.fn(),
  goToCashFlowMonth: vi.fn(),
  scrapeCategoryCandidates: vi.fn(),
  getCsrfToken: vi.fn(),
  updateTransactionCategory: vi.fn(),
}));

vi.mock("../scrapers/cash-flow-history.js", () => ({
  scrapeCashFlowHistory: mocks.scrapeCashFlowHistory,
  goToCashFlowMonth: mocks.goToCashFlowMonth,
}));
vi.mock("../scrapers/category-candidates.js", () => ({
  scrapeCategoryCandidates: mocks.scrapeCategoryCandidates,
}));
vi.mock("../hooks/helpers.js", () => ({
  getCsrfToken: mocks.getCsrfToken,
  updateTransactionCategory: mocks.updateTransactionCategory,
}));

const transaction = {
  mfId: "mf-tx-1",
  type: "expense",
  isTransfer: false,
  isExcludedFromCalculation: false,
  category: "食費",
  subCategory: "食料品",
};

describe("applyMoneyForwardOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scrapeCashFlowHistory.mockResolvedValue([{ data: { items: [transaction] } }]);
    mocks.scrapeCategoryCandidates.mockResolvedValue([
      {
        largeCategoryId: "2",
        largeCategoryName: "食費",
        middleCategoryId: "20",
        middleCategoryName: "食料品",
        isIncome: false,
      },
    ]);
    mocks.getCsrfToken.mockResolvedValue("csrf");
    mocks.updateTransactionCategory.mockResolvedValue({ ok: true, status: 200 });
  });

  test("updates only the target flag while preserving category and income type", async () => {
    await applyMoneyForwardOperation({} as never, {
      type: "set-calculation-exclusion",
      transactionId: "mf-tx-1",
      month: "2025-07",
      excluded: true,
    });

    expect(mocks.scrapeCashFlowHistory).toHaveBeenCalledWith(expect.anything(), 1, {
      targetMonth: "2025-07",
    });
    expect(mocks.updateTransactionCategory).toHaveBeenCalledWith({}, "csrf", "mf-tx-1", {
      largeCategoryId: "2",
      middleCategoryId: "20",
      isIncome: false,
      isTarget: false,
    });
  });

  test("returns to the month's cash flow table before updating the row", async () => {
    await applyMoneyForwardOperation({} as never, {
      type: "set-calculation-exclusion",
      transactionId: "mf-tx-1",
      month: "2025-07",
      excluded: true,
    });

    expect(mocks.goToCashFlowMonth).toHaveBeenCalledWith(expect.anything(), "2025-07");
    expect(mocks.scrapeCategoryCandidates.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.goToCashFlowMonth.mock.invocationCallOrder[0]!,
    );
    expect(mocks.goToCashFlowMonth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateTransactionCategory.mock.invocationCallOrder[0]!,
    );
  });

  test("does not call MoneyForward when the transaction already has the requested state", async () => {
    mocks.scrapeCashFlowHistory.mockResolvedValue([
      { data: { items: [{ ...transaction, isExcludedFromCalculation: true }] } },
    ]);

    await applyMoneyForwardOperation({} as never, {
      type: "set-calculation-exclusion",
      transactionId: "mf-tx-1",
      month: "2025-07",
      excluded: true,
    });

    expect(mocks.updateTransactionCategory).not.toHaveBeenCalled();
  });

  test.each([
    [[], "not found"],
    [[{ ...transaction, isTransfer: true, type: "transfer", category: null }], "transfer"],
  ])("refuses an unsupported transaction", async (items, message) => {
    mocks.scrapeCashFlowHistory.mockResolvedValue([{ data: { items } }]);

    await expect(
      applyMoneyForwardOperation({} as never, {
        type: "set-calculation-exclusion",
        transactionId: "mf-tx-1",
        month: "2025-07",
        excluded: true,
      }),
    ).rejects.toThrow(message);
    expect(mocks.updateTransactionCategory).not.toHaveBeenCalled();
  });
});
