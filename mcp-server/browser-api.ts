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
import type { BrowserApiOperation } from "./browser-operations";
import {
  BROKER_PROTOCOL_VERSION,
  type BrokerIdentity,
  type BrokerInfo,
  clearBrokerInfo,
  createBrokerIdentity,
  createBrokerServer,
  createBrokerToken,
  forwardToBroker,
  getBrokerSocketPath,
  pingBroker,
  readBrokerInfo,
  writeBrokerInfo,
} from "./singleton-broker";

export { BROWSER_API_OPERATIONS, isBrowserApiOperation } from "./browser-operations";
export { BROWSER_TRANSPORT_MODES } from "./browser-transport";

const WS_DEFAULT_PORT = 8089;
const EXTENSION_RESPONSE_TIMEOUT_MS = 5000;
const WS_OPEN_WAIT_TIMEOUT_MS = 10_000;
const WS_OPEN_POLL_INTERVAL_MS = 100;
const BROKER_REQUEST_TIMEOUT_MS = 15_000;

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
    "No live broker responded for this EXTENSION_PORT and EXTENSION_SECRET, so forwarding could not start. " +
    "If this is a different browser, configure it with a different EXTENSION_PORT and EXTENSION_SECRET."
  );
}

interface ExtensionRequestResolver<T extends ExtensionMessage["resource"]> {
  resource: T;
  resolve: (value: Extract<ExtensionMessage, { resource: T }>) => void;
  reject: (reason?: string) => void;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private extensionSockets: Set<WebSocket> = new Set();
  private wsServers: WebSocket.Server[] = [];
  private sharedSecret: string | null = null;
  private unavailableReason: string | null = null;
  private brokerIdentity: BrokerIdentity | null = null;
  private brokerInfo: BrokerInfo | null = null;
  private brokerServer: ReturnType<typeof createBrokerServer> | null = null;
  private selectedPort: number | null = null;

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
    const identity = createBrokerIdentity({ port, extensionSecret: secret });
    this.brokerIdentity = identity;
    this.selectedPort = port;

    if (await isPortInUse(port)) {
      const brokerInfo = readBrokerInfo(identity);
      if (
        brokerInfo &&
        await pingBroker({
          socketPath: brokerInfo.socketPath,
          token: brokerInfo.token,
          timeoutMs: 1000,
        })
      ) {
        this.brokerInfo = brokerInfo;
        console.error(
          `browser-control: forwarding browser tools for ${identity.id} to broker process ${brokerInfo.pid}`
        );
        return;
      }

      this.unavailableReason = buildPortInUseMessage(port);
      console.error(this.unavailableReason);
      return;
    }

    await this.becomeLeader(identity, port);
  }

  async close(): Promise<void> {
    if (this.brokerInfo?.pid === process.pid) {
      clearBrokerInfo(this.brokerInfo);
    }

    await Promise.all([...this.extensionSockets].map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close(1001, "browser-control broker shutting down");
    })));
    this.extensionSockets.clear();
    this.ws = null;

    try {
      await this.brokerServer?.close();
    } catch (error) {
      console.error("Failed to close browser-control broker", error);
    }
    this.brokerServer = null;

    await Promise.all(this.wsServers.map((wsServer) => new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    })));
    this.wsServers = [];
  }

  getSelectedPort() {
    return this.wsServers[0]?.options.port ?? this.selectedPort ?? undefined;
  }

  async openTab(url: string): Promise<number | undefined> {
    if (this.isForwarding()) {
      return await this.forwardOperation("openTab", [url]) as number | undefined;
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "open-tab",
      url,
    });
    const message = await this.waitForResponse(correlationId, "opened-tab-id");
    return message.tabId;
  }

  async closeTabs(tabIds: number[]) {
    if (this.isForwarding()) {
      await this.forwardOperation("closeTabs", [tabIds]);
      return;
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "close-tabs",
      tabIds,
    });
    await this.waitForResponse(correlationId, "tabs-closed");
  }

  async getTabList(): Promise<BrowserTab[]> {
    if (this.isForwarding()) {
      return await this.forwardOperation("getTabList", []) as BrowserTab[];
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "get-tab-list",
    });
    const message = await this.waitForResponse(correlationId, "tabs");
    return message.tabs;
  }

  async getCurrentTab(): Promise<BrowserTab> {
    if (this.isForwarding()) {
      return await this.forwardOperation("getCurrentTab", []) as BrowserTab;
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "get-current-tab",
    });
    const message = await this.waitForResponse(correlationId, "current-tab");
    return message.tab;
  }

  async getTabMetadata(tabId: number): Promise<Record<string, unknown>> {
    if (this.isForwarding()) {
      return await this.forwardOperation("getTabMetadata", [tabId]) as Record<string, unknown>;
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "get-tab-metadata",
      tabId,
    });
    const message = await this.waitForResponse(correlationId, "tab-metadata");
    return message.metadata;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    if (this.isForwarding()) {
      return await this.forwardOperation("getBrowserRecentHistory", [searchQuery]) as BrowserHistoryItem[];
    }

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
    if (this.isForwarding()) {
      return await this.forwardOperation("getTabContent", [tabId, offset]) as TabContentExtensionMessage;
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "get-tab-content",
      tabId,
      offset,
    });
    return await this.waitForResponse(correlationId, "tab-content");
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    if (this.isForwarding()) {
      return await this.forwardOperation("reorderTabs", [tabOrder]) as number[];
    }

    const correlationId = await this.sendMessageToExtension({
      cmd: "reorder-tabs",
      tabOrder,
    });
    const message = await this.waitForResponse(correlationId, "tabs-reordered");
    return message.tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    if (this.isForwarding()) {
      return await this.forwardOperation("findHighlight", [tabId, queryPhrase]) as number;
    }

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
    if (this.isForwarding()) {
      return await this.forwardOperation("groupTabs", [tabIds, isCollapsed, groupColor, groupTitle]) as number;
    }

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

  private isForwarding(): boolean {
    return Boolean(this.brokerInfo && this.brokerInfo.pid !== process.pid);
  }

  private async forwardOperation(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    if (!this.brokerInfo) {
      throw new Error("Browser broker forwarding is not initialized");
    }

    try {
      return await this.forwardToCurrentBroker(operation, args);
    } catch (error) {
      trace("Cached broker request failed; attempting broker recovery", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.recoverBrokerConnection();
      if (this.isForwarding()) {
        return await this.forwardToCurrentBroker(operation, args);
      }
      return await this.dispatchOperation(operation, args);
    }
  }

  private async forwardToCurrentBroker(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    if (!this.brokerInfo) {
      throw new Error("Browser broker forwarding is not initialized");
    }

    return await forwardToBroker({
      socketPath: this.brokerInfo.socketPath,
      token: this.brokerInfo.token,
      operation,
      args,
      timeoutMs: BROKER_REQUEST_TIMEOUT_MS,
    });
  }

  private async recoverBrokerConnection(): Promise<void> {
    if (!this.brokerIdentity || !this.selectedPort) {
      throw new Error("Browser broker identity is not initialized");
    }

    const latestBrokerInfo = readBrokerInfo(this.brokerIdentity);
    if (
      latestBrokerInfo &&
      await pingBroker({
        socketPath: latestBrokerInfo.socketPath,
        token: latestBrokerInfo.token,
        timeoutMs: 1000,
      })
    ) {
      this.brokerInfo = latestBrokerInfo;
      return;
    }

    if (await isPortInUse(this.selectedPort)) {
      throw new Error(
        `Browser broker is unavailable and port ${this.selectedPort} is still in use. ` +
          "Restart this MCP server session after the current owner exits."
      );
    }

    await this.becomeLeader(this.brokerIdentity, this.selectedPort);
  }

  private async becomeLeader(identity: BrokerIdentity, port: number): Promise<void> {
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
        this.extensionSockets.add(connection);

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
          this.extensionSockets.delete(connection);
          if (this.ws === connection) {
            this.ws = null;
          }
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

    const token = createBrokerToken();
    const socketPath = getBrokerSocketPath(identity);
    const info: BrokerInfo = {
      pid: process.pid,
      identity,
      socketPath,
      token,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      startedAt: Date.now(),
    };

    this.brokerServer = createBrokerServer({
      socketPath,
      token,
      handleOperation: (operation, args) => this.dispatchOperation(operation, args),
    });
    await this.brokerServer.start();
    writeBrokerInfo(info);
    this.brokerInfo = info;
  }

  private async dispatchOperation(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    switch (operation) {
      case "openTab":
        return await this.openTab(args[0] as string);
      case "closeTabs":
        return await this.closeTabs(args[0] as number[]);
      case "getTabList":
        return await this.getTabList();
      case "getCurrentTab":
        return await this.getCurrentTab();
      case "getTabMetadata":
        return await this.getTabMetadata(args[0] as number);
      case "getBrowserRecentHistory":
        return await this.getBrowserRecentHistory(args[0] as string | undefined);
      case "getTabContent":
        return await this.getTabContent(args[0] as number, args[1] as number);
      case "reorderTabs":
        return await this.reorderTabs(args[0] as number[]);
      case "findHighlight":
        return await this.findHighlight(args[0] as number, args[1] as string);
      case "groupTabs":
        return await this.groupTabs(
          args[0] as number[],
          args[1] as boolean,
          args[2] as string,
          args[3] as string
        );
      default: {
        const exhaustiveCheck: never = operation;
        throw new Error(`Unsupported browser operation: ${exhaustiveCheck}`);
      }
    }
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
