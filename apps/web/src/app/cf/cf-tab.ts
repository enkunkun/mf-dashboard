export type CFTab = "summary" | "transactions";

export function resolveCFTab(tab: string | string[] | undefined): CFTab {
  return tab === "transactions" ? "transactions" : "summary";
}
