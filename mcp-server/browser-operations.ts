export const BROWSER_API_OPERATIONS = [
  "openTab",
  "closeTabs",
  "getTabList",
  "getCurrentTab",
  "getTabMetadata",
  "getBrowserRecentHistory",
  "getTabContent",
  "reorderTabs",
  "findHighlight",
  "groupTabs",
] as const;

export type BrowserApiOperation = (typeof BROWSER_API_OPERATIONS)[number];

const BROWSER_API_OPERATION_SET = new Set<string>(BROWSER_API_OPERATIONS);

export function isBrowserApiOperation(value: string): value is BrowserApiOperation {
  return BROWSER_API_OPERATION_SET.has(value);
}
