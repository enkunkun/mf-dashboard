import { describe, expect, it } from "vitest";
import { resolveCFTab } from "./cf-tab";

describe("resolveCFTab", () => {
  it("selects the transaction tab when requested", () => {
    expect(resolveCFTab("transactions")).toBe("transactions");
  });

  it.each([undefined, "summary", "unknown", ["transactions", "summary"]])(
    "defaults invalid tab values to summary (%s)",
    (tab) => {
      expect(resolveCFTab(tab)).toBe("summary");
    },
  );
});
