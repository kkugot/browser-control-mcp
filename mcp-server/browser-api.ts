import WebSocket from "ws";
import type {
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  ServerMessage,
  TabContentExtensionMessage,
  ServerMessageRequest,
  ExtensionError,
} from "@browser-control-mcp/common";
import { isPortInUse } from "./util";
import * as crypto from "crypto";

const WS_DEFAULT_PORT = 8089;
const EXTENSION_RESPONSE_TIMEOUT_MS = 5000;
const WS_OPEN_WAIT_TIMEOUT_MS = 10_000;
const WS_OPEN_POLL_INTERVAL_MS = 100;

// Set BROWSER_MCP_DEBUG=1 (or =true) to enable verbose trace logging
const DEBUG = ["1", "true"].includes(
  (process.env.BROWSER_MCP_DEBUG ?? "").toLowerCase()
);

function trace(...args: unknown[]) {
  if (DEBUG) {
    console.error("[browser-mcp:trace]", new Date().toISOString(), ...args);
  }
}

export function getWebSocketHosts(isContainerized: boolean): string[] {
  return isContainerized ? ["0.0.0.0"] : ["127.0.0.1", "::1"];
}

export function buildPortInUseMessage(port: number): string {
  return (
    `browser-control: port ${port} is already in use, likely by another MCP client session. ` +
    "Browser tools are unavailable in this session. Close the other session or stop its browser-control process to use this one."
  );
}

interface ExtensionRequestResolver<T extends ExtensionMessage["resource"]> {
  resource: T;
  resolve: (value: Extract<ExtensionMessage, { resource: T }>) => void;
  reject: (reason?: string) => void;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private wsServers: WebSocket.Server[] = [];
  private sharedSecret: string | null = null;
  private unavailableReason: string | null = null;

  // Map to persist the request to the extension. It maps the request correlationId
  // to a resolver, fulfulling a promise created when sending a message to the extension.
  private extensionRequestMap: Map<
    string,
    ExtensionRequestResolver<ExtensionMessage["resource"]>
  > = new Map();

  async init() {
    const { secret, port } = readConfig();
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.sharedSecret = secret;

    if (await isPortInUse(port)) {
      this.unavailableReason = buildPortInUseMessage(port);
      console.error(this.unavailableReason);
      return;
    }

    for (const host of getWebSocketHosts(Boolean(process.env.CONTAINERIZED))) {
      const wsServer = new WebSocket.Server({
        host,
        port,
      });

      console.error(`Starting WebSocket server on ${host}:${port}`);
      trace("WebSocket server binding", { host, port, debug: true });

      wsServer.on("connection", async (connection, req) => {
        const prevState = this.ws ? this.ws.readyState : "none";
        this.ws = connection;

        console.error("WebSocket connection established on port", port);
        trace("Extension connected", {
          remoteAddress: req.socket.remoteAddress,
          previousSocketState: prevState,
          pendingRequests: this.extensionRequestMap.size,
        });

        this.ws.on("message", (message) => {
          let decoded: any;
          try {
            decoded = JSON.parse(message.toString());
          } catch (parseErr) {
            console.error("Failed to parse extension message:", parseErr);
            trace("Message parse failure", {
              rawLength: message.toString().length,
              error: String(parseErr),
            });
            return;
          }

          if (isErrorMessage(decoded)) {
            trace("Received extension error", {
              correlationId: decoded.correlationId,
              errorMessage: decoded.errorMessage,
            });
            this.handleExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            console.error("Invalid message signature");
            trace("Signature mismatch", {
              correlationId: decoded.payload?.correlationId,
              resource: decoded.payload?.resource,
            });
            return;
          }
          trace("Received valid extension message", {
            correlationId: decoded.payload.correlationId,
            resource: decoded.payload.resource,
          });
          this.handleDecodedExtensionMessage(decoded.payload);
        });

        this.ws.on("close", (code, reason) => {
          console.error("WebSocket connection closed", { code, reason: reason.toString() });
          trace("Extension socket closed", {
            code,
            reason: reason.toString(),
            pendingRequests: this.extensionRequestMap.size,
            pendingCorrelationIds: [...this.extensionRequestMap.keys()],
          });
        });

        this.ws.on("error", (error) => {
          console.error("WebSocket connection error:", error.message);
          trace("Extension socket error", { error: error.message, stack: error.stack });
        });
      });
      wsServer.on("error", (error) => {
        console.error(`WebSocket server error on ${host}:${port}:`, error);
        trace("Server-level WS error", { host, port, error: String(error) });
      });

      this.wsServers.push(wsServer);
    }
  }

  close() {
    for (const wsServer of this.wsServers) {
      wsServer.close();
    }
    this.wsServers = [];
  }

  getSelectedPort() {
    return this.wsServers[0]?.options.port;
  }

  async openTab(url: string): Promise<number | undefined> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "open-tab",
      url,
    });
    const message = await this.waitForResponse(correlationId, "opened-tab-id");
    return message.tabId;
  }

  async closeTabs(tabIds: number[]) {
    const correlationId = await this.sendMessageToExtension({
      cmd: "close-tabs",
      tabIds,
    });
    await this.waitForResponse(correlationId, "tabs-closed");
  }

  async getTabList(): Promise<BrowserTab[]> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "get-tab-list",
    });
    const message = await this.waitForResponse(correlationId, "tabs");
    return message.tabs;
  }

  async getCurrentTab(): Promise<BrowserTab> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "get-current-tab",
    });
    const message = await this.waitForResponse(correlationId, "current-tab");
    return message.tab;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    const message = await this.waitForResponse(correlationId, "history");
    return message.historyItems;
  }

  async getTabContent(
    tabId: number,
    offset: number
  ): Promise<TabContentExtensionMessage> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "get-tab-content",
      tabId,
      offset,
    });
    return await this.waitForResponse(correlationId, "tab-content");
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "reorder-tabs",
      tabOrder,
    });
    const message = await this.waitForResponse(correlationId, "tabs-reordered");
    return message.tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "find-highlight",
      tabId,
      queryPhrase,
    });
    const message = await this.waitForResponse(
      correlationId,
      "find-highlight-result"
    );
    return message.noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const correlationId = await this.sendMessageToExtension({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    const message = await this.waitForResponse(correlationId, "new-tab-group");
    return message.groupId;
  }

  private createSignature(payload: string): string {
    if (!this.sharedSecret) {
      throw new Error("Shared secret not initialized");
    }
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  private async sendMessageToExtension(message: ServerMessage): Promise<string> {
    trace("Preparing to send message to extension", {
      cmd: message.cmd,
      wsState: this.ws?.readyState ?? "null",
    });

    await this.waitForWebSocketOpen();

    const correlationId = Math.random().toString(36).substring(2);
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    const signedMessage = {
      payload: req,
      signature: signature,
    };

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      trace("WebSocket closed before send", {
        cmd: message.cmd,
        correlationId,
        wsState: ws?.readyState ?? "null",
      });
      throw new Error("WebSocket was closed before sending the message");
    }

    // Send the signed message to the extension
    ws.send(JSON.stringify(signedMessage));
    trace("Sent message to extension", { cmd: message.cmd, correlationId });

    return correlationId;
  }

  private async waitForWebSocketOpen(): Promise<void> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    trace("Waiting for WebSocket to open", {
      wsExists: !!this.ws,
      wsState: this.ws?.readyState ?? "null",
      timeoutMs: WS_OPEN_WAIT_TIMEOUT_MS,
    });

    const deadline = Date.now() + WS_OPEN_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        trace("WebSocket became open after waiting");
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WS_OPEN_POLL_INTERVAL_MS);
      });
    }

    const port = this.getSelectedPort() ?? process.env.EXTENSION_PORT ?? WS_DEFAULT_PORT;
    trace("WebSocket open timeout reached", {
      wsExists: !!this.ws,
      wsState: this.ws?.readyState ?? "null",
      port,
    });
    throw new Error(
      `WebSocket is not open after ${WS_OPEN_WAIT_TIMEOUT_MS}ms. ` +
        `Make sure the Firefox extension is installed, running, and configured to use port ${port}.`
    );
  }

  private handleDecodedExtensionMessage(decoded: ExtensionMessage) {
    const { correlationId } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      // Response arrived after timeout or for an unknown correlationId -- safe to ignore
      console.error("Received response for unknown/expired correlationId:", correlationId);
      trace("Orphaned extension response (likely timed out)", {
        correlationId,
        resource: decoded.resource,
        pendingKeys: [...this.extensionRequestMap.keys()],
      });
      return;
    }
    const { resolve, resource } = entry;
    if (resource !== decoded.resource) {
      console.error("Resource mismatch:", resource, decoded.resource);
      trace("Resource mismatch detail", { correlationId, expected: resource, actual: decoded.resource });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    trace("Resolved extension response", { correlationId, resource });
    resolve(decoded);
  }

  private handleExtensionError(decoded: ExtensionError) {
    const { correlationId, errorMessage } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      console.error("Received error for unknown/expired correlationId:", correlationId, errorMessage);
      trace("Orphaned extension error (likely timed out)", {
        correlationId,
        errorMessage,
        pendingKeys: [...this.extensionRequestMap.keys()],
      });
      return;
    }
    const { reject } = entry;
    this.extensionRequestMap.delete(correlationId);
    trace("Rejecting with extension error", { correlationId, errorMessage });
    reject(errorMessage);
  }

  private async waitForResponse<T extends ExtensionMessage["resource"]>(
    correlationId: string,
    resource: T
  ): Promise<Extract<ExtensionMessage, { resource: T }>> {
    return new Promise<Extract<ExtensionMessage, { resource: T }>>(
      (resolve, reject) => {
        this.extensionRequestMap.set(correlationId, {
          resolve: resolve as (value: ExtensionMessage) => void,
          resource,
          reject,
        });
        setTimeout(() => {
          if (this.extensionRequestMap.has(correlationId)) {
            this.extensionRequestMap.delete(correlationId);
            trace("Response timeout", {
              correlationId,
              resource,
              timeoutMs: EXTENSION_RESPONSE_TIMEOUT_MS,
              wsState: this.ws?.readyState ?? "null",
            });
            reject(
              `Timed out waiting for response (resource=${resource}, ` +
                `timeout=${EXTENSION_RESPONSE_TIMEOUT_MS}ms, correlationId=${correlationId})`
            );
          }
        }, EXTENSION_RESPONSE_TIMEOUT_MS);
      }
    );
  }
}

function readConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message.errorMessage !== undefined && message.correlationId !== undefined
  );
}
