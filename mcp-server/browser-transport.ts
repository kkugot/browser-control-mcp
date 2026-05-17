import type { BrowserApiOperation } from "./browser-operations";

export const BROWSER_TRANSPORT_MODES = ["direct", "forwarding"] as const;

export interface BrowserTransport {
  mode: (typeof BROWSER_TRANSPORT_MODES)[number];
  dispatch(operation: BrowserApiOperation, args: unknown[]): Promise<unknown>;
  close(): Promise<void> | void;
}
