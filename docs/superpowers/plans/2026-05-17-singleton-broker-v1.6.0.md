# Singleton Broker v1.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow many local MCP client processes configured with the same browser port and pairing key to control that browser extension connection by routing browser operations through one local broker.

**Architecture:** One process becomes the broker/leader for a specific browser identity, where identity is derived from `EXTENSION_PORT` plus a hash of `EXTENSION_SECRET`. Other MCP processes with the same port and key become forwarders: they keep their stdio MCP server alive, authenticate to the broker over a local IPC socket with a broker token, forward browser operations, and return broker responses to their own clients. Different browsers are supported by configuring them with different ports and different pairing keys, which produces separate broker metadata and socket paths.

**Tech Stack:** Node.js 22, TypeScript strict mode, `net` Unix domain sockets on macOS/Linux, Windows named pipes, existing `BrowserAPI`, Node built-in test runner for `mcp-server`, Jest for extension regression checks.

---

## Design Decisions

- Use a local broker per browser identity, not many MCP processes bound to the same TCP port. Only one process can own a specific browser extension port.
- Derive broker identity from `EXTENSION_PORT` and a short SHA-256 hash of `EXTENSION_SECRET`. Never write the raw extension secret into broker metadata.
- Treat additional browsers as separate broker identities configured with different ports and pairing keys.
- Keep the Firefox extension unchanged. It still connects to one local WebSocket listener.
- Use a transport boundary so `BrowserAPI` does not own all responsibilities forever.
- Authenticate IPC with a random broker token written to a `0600` metadata file under a `0700` cache directory.
- Validate broker liveness by `ping` over IPC, not by PID alone.
- Add request timeouts so a hung broker does not hang forwarder tool calls.
- Use a strict operation whitelist. Do not dynamically invoke arbitrary method names from IPC strings.
- Do not implement automatic leader promotion in the first version. If the broker dies, forwarders fail fast with guidance; a new MCP process can become broker on restart.

## Files

- Create `mcp-server/browser-operations.ts`: shared operation names, argument/result dispatch types, runtime operation whitelist.
- Create `mcp-server/browser-transport.ts`: `BrowserTransport` interface, `DirectBrowserTransport`, `ForwardingBrowserTransport`.
- Create `mcp-server/singleton-broker.ts`: cache paths, metadata, token generation, socket path selection, broker IPC server/client, liveness ping.
- Broker metadata and sockets are keyed by `EXTENSION_PORT` plus a hash of `EXTENSION_SECRET`, so browsers configured with different ports and keys do not collide.
- Modify `mcp-server/browser-api.ts`: become a facade over a selected `BrowserTransport` while preserving public methods.
- Modify `mcp-server/__tests__/browser-api.test.mjs`: update/extend tests for broker guidance and operation whitelist.
- Create `mcp-server/__tests__/singleton-broker.test.mjs`: tests for metadata, token auth, IPC ping and forwarding.
- Modify release files to `1.6.0`: `CHANGELOG.md`, `package.json`, `package-lock.json`, `common/package.json`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/manifest.json`, `mcp-server/server.ts`, `firefox-extension/package.json`, `firefox-extension/package-lock.json`, `firefox-extension/manifest.json`.

---

## Task 1: Browser Operation Whitelist

**Files:**
- Create: `mcp-server/browser-operations.ts`
- Modify: `mcp-server/__tests__/browser-api.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `mcp-server/__tests__/browser-api.test.mjs`:

```js
test("browser operation whitelist is stable for broker forwarding", () => {
  assert.deepEqual(browserApi.BROWSER_API_OPERATIONS, [
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
  ]);
  assert.equal(browserApi.isBrowserApiOperation("getTabList"), true);
  assert.equal(browserApi.isBrowserApiOperation("constructor"), false);
});
```

- [ ] **Step 2: Verify red**

Run: `cd mcp-server && npm test -- __tests__/browser-api.test.mjs`

Expected: FAIL because `BROWSER_API_OPERATIONS` and `isBrowserApiOperation` are not exported.

- [ ] **Step 3: Implement operation whitelist**

Create `mcp-server/browser-operations.ts`:

```ts
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
```

Re-export from `mcp-server/browser-api.ts`:

```ts
export { BROWSER_API_OPERATIONS, isBrowserApiOperation } from "./browser-operations";
```

- [ ] **Step 4: Verify green**

Run: `cd mcp-server && npm test -- __tests__/browser-api.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/browser-operations.ts mcp-server/browser-api.ts mcp-server/__tests__/browser-api.test.mjs
git commit -m "feat: define broker browser operation whitelist"
```

---

## Task 2: Broker Paths, Metadata, And Tokens

**Files:**
- Create: `mcp-server/singleton-broker.ts`
- Create: `mcp-server/__tests__/singleton-broker.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `mcp-server/__tests__/singleton-broker.test.mjs`:

```js
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import broker from "../dist/singleton-broker.js";

test("broker paths are scoped by port and extension secret hash", () => {
  const directory = broker.getBrokerDirectory();
  const identity = broker.createBrokerIdentity({ port: 8089, extensionSecret: "secret-a" });

  assert.equal(directory, path.join(os.homedir(), ".cache", "browser-control-mcp"));
  assert.match(identity.secretHash, /^[a-f0-9]{16}$/);
  assert.equal(identity.id, `8089-${identity.secretHash}`);
  assert.equal(broker.getBrokerInfoPath(identity), path.join(directory, `leader-${identity.id}.json`));

  if (process.platform === "win32") {
    assert.equal(broker.getBrokerSocketPath(identity), `\\\\.\\pipe\\browser-control-mcp-${identity.id}`);
  } else {
    assert.equal(broker.getBrokerSocketPath(identity), path.join(directory, `leader-${identity.id}.sock`));
  }
});

test("broker identity changes when browser port or key changes", () => {
  const first = broker.createBrokerIdentity({ port: 8089, extensionSecret: "secret-a" });
  const same = broker.createBrokerIdentity({ port: 8089, extensionSecret: "secret-a" });
  const differentPort = broker.createBrokerIdentity({ port: 8090, extensionSecret: "secret-a" });
  const differentSecret = broker.createBrokerIdentity({ port: 8089, extensionSecret: "secret-b" });

  assert.deepEqual(first, same);
  assert.notEqual(first.id, differentPort.id);
  assert.notEqual(first.id, differentSecret.id);
});

test("broker token generation returns a non-empty random string", () => {
  const first = broker.createBrokerToken();
  const second = broker.createBrokerToken();
  assert.equal(typeof first, "string");
  assert.ok(first.length >= 32);
  assert.notEqual(first, second);
});

test("broker metadata round trips through disk", () => {
  const identity = broker.createBrokerIdentity({ port: 8089, extensionSecret: "secret-a" });
  const info = {
    pid: process.pid,
    identity,
    socketPath: broker.getBrokerSocketPath(identity),
    token: broker.createBrokerToken(),
    protocolVersion: 1,
    startedAt: 123,
  };

  broker.writeBrokerInfo(info);
  assert.deepEqual(broker.readBrokerInfo(identity), info);
  broker.clearBrokerInfo(info);
  assert.equal(broker.readBrokerInfo(identity), null);
});
```

- [ ] **Step 2: Verify red**

Run: `cd mcp-server && npm test -- __tests__/singleton-broker.test.mjs`

Expected: FAIL because `singleton-broker.js` does not exist.

- [ ] **Step 3: Implement metadata helpers**

Create `mcp-server/singleton-broker.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BROKER_PROTOCOL_VERSION = 1;

export interface BrokerIdentity {
  id: string;
  port: number;
  secretHash: string;
}

export interface BrokerInfo {
  pid: number;
  identity: BrokerIdentity;
  socketPath: string;
  token: string;
  protocolVersion: number;
  startedAt: number;
}

export function getBrokerDirectory(): string {
  return path.join(os.homedir(), ".cache", "browser-control-mcp");
}

export function createBrokerIdentity(options: { port: number; extensionSecret: string }): BrokerIdentity {
  const secretHash = crypto
    .createHash("sha256")
    .update(options.extensionSecret)
    .digest("hex")
    .slice(0, 16);
  return {
    id: `${options.port}-${secretHash}`,
    port: options.port,
    secretHash,
  };
}

export function getBrokerInfoPath(identity: BrokerIdentity): string {
  return path.join(getBrokerDirectory(), `leader-${identity.id}.json`);
}

export function getBrokerSocketPath(identity: BrokerIdentity): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\browser-control-mcp-${identity.id}`;
  }
  return path.join(getBrokerDirectory(), `leader-${identity.id}.sock`);
}

export function ensureBrokerDirectory(): void {
  fs.mkdirSync(getBrokerDirectory(), { recursive: true, mode: 0o700 });
}

export function createBrokerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function writeBrokerInfo(info: BrokerInfo): void {
  ensureBrokerDirectory();
  fs.writeFileSync(getBrokerInfoPath(info.identity), JSON.stringify(info), { mode: 0o600 });
}

export function readBrokerInfo(identity: BrokerIdentity): BrokerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(getBrokerInfoPath(identity), "utf8")) as BrokerInfo;
  } catch {
    return null;
  }
}

export function clearBrokerInfo(expected?: BrokerInfo): void {
  if (!expected) {
    return;
  }
  const current = readBrokerInfo(expected.identity);
  if (expected && current && current.token !== expected.token) {
    return;
  }
  try {
    fs.unlinkSync(getBrokerInfoPath(expected.identity));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
```

- [ ] **Step 4: Verify green**

Run: `cd mcp-server && npm test -- __tests__/singleton-broker.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/singleton-broker.ts mcp-server/__tests__/singleton-broker.test.mjs
git commit -m "feat: add broker metadata helpers"
```

---

## Task 3: Broker IPC With Auth, Ping, And Timeout

**Files:**
- Modify: `mcp-server/singleton-broker.ts`
- Modify: `mcp-server/__tests__/singleton-broker.test.mjs`

- [ ] **Step 1: Add failing IPC tests**

Append to `mcp-server/__tests__/singleton-broker.test.mjs`:

```js
test("broker IPC requires the broker token and forwards operations", async () => {
  const token = broker.createBrokerToken();
  const identity = broker.createBrokerIdentity({ port: 18089, extensionSecret: "secret-a" });
  const socketPath = broker.getBrokerSocketPath(identity);
  const server = broker.createBrokerServer({
    socketPath,
    token,
    handleOperation: async (operation, args) => {
      assert.equal(operation, "getTabList");
      assert.deepEqual(args, []);
      return [{ id: 123, url: "https://example.com" }];
    },
  });

  await server.start();
  try {
    assert.equal(await broker.pingBroker({ socketPath, token, timeoutMs: 1000 }), true);
    const result = await broker.forwardToBroker({
      socketPath,
      token,
      operation: "getTabList",
      args: [],
      timeoutMs: 1000,
    });
    assert.deepEqual(result, [{ id: 123, url: "https://example.com" }]);
    await assert.rejects(
      broker.forwardToBroker({ socketPath, token: "wrong", operation: "getTabList", args: [], timeoutMs: 1000 }),
      /unauthorized/i
    );
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Verify red**

Run: `cd mcp-server && npm test -- __tests__/singleton-broker.test.mjs`

Expected: FAIL because `createBrokerServer`, `pingBroker`, and `forwardToBroker` do not exist.

- [ ] **Step 3: Implement IPC**

Add to `mcp-server/singleton-broker.ts`:

```ts
import net from "node:net";
import type { BrowserApiOperation } from "./browser-operations";

interface BrokerRequest {
  id: string;
  protocolVersion: number;
  token: string;
  operation: BrowserApiOperation | "ping";
  args: unknown[];
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Broker request timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

export function createBrokerServer(options: {
  socketPath: string;
  token: string;
  handleOperation: (operation: BrowserApiOperation, args: unknown[]) => Promise<unknown>;
}) {
  let server: net.Server;
  return {
    async start(): Promise<void> {
      ensureBrokerDirectory();
      if (process.platform !== "win32") {
        try { fs.unlinkSync(options.socketPath); } catch {}
      }
      server = net.createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
          if (!data.endsWith("\n")) return;
          const request = JSON.parse(data) as BrokerRequest;
          const respond = (response: BrokerResponse) => socket.end(`${JSON.stringify(response)}\n`);
          if (request.protocolVersion !== BROKER_PROTOCOL_VERSION) {
            respond({ id: request.id, ok: false, error: "Unsupported broker protocol version" });
            return;
          }
          if (request.token !== options.token) {
            respond({ id: request.id, ok: false, error: "Unauthorized broker request" });
            return;
          }
          if (request.operation === "ping") {
            respond({ id: request.id, ok: true, result: "pong" });
            return;
          }
          options.handleOperation(request.operation, request.args)
            .then((result) => respond({ id: request.id, ok: true, result }))
            .catch((error) => respond({ id: request.id, ok: false, error: String(error?.message ?? error) }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socketPath, resolve);
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        try { fs.unlinkSync(options.socketPath); } catch {}
      }
    },
  };
}

async function sendBrokerRequest(options: {
  socketPath: string;
  token: string;
  operation: BrokerRequest["operation"];
  args: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  const request: BrokerRequest = {
    id: crypto.randomUUID(),
    protocolVersion: BROKER_PROTOCOL_VERSION,
    token: options.token,
    operation: options.operation,
    args: options.args,
  };
  return withTimeout(new Promise((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let data = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => {
      const response = JSON.parse(data) as BrokerResponse;
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error ?? "Unknown broker error"));
    });
    socket.write(`${JSON.stringify(request)}\n`);
  }), options.timeoutMs);
}

export async function pingBroker(options: { socketPath: string; token: string; timeoutMs: number }): Promise<boolean> {
  try {
    const result = await sendBrokerRequest({ ...options, operation: "ping", args: [] });
    return result === "pong";
  } catch {
    return false;
  }
}

export async function forwardToBroker(options: {
  socketPath: string;
  token: string;
  operation: BrowserApiOperation;
  args: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  return sendBrokerRequest(options);
}
```

- [ ] **Step 4: Verify green**

Run: `cd mcp-server && npm test -- __tests__/singleton-broker.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/singleton-broker.ts mcp-server/__tests__/singleton-broker.test.mjs
git commit -m "feat: add authenticated broker IPC"
```

---

## Task 4: Transport Interface And Direct Transport

**Files:**
- Create: `mcp-server/browser-transport.ts`
- Modify: `mcp-server/browser-api.ts`

- [ ] **Step 1: Add failing compile-only test**

Append to `mcp-server/__tests__/browser-api.test.mjs`:

```js
test("BrowserAPI exports transport mode names", () => {
  assert.deepEqual(browserApi.BROWSER_TRANSPORT_MODES, ["direct", "forwarding"]);
});
```

- [ ] **Step 2: Verify red**

Run: `cd mcp-server && npm test -- __tests__/browser-api.test.mjs`

Expected: FAIL because `BROWSER_TRANSPORT_MODES` does not exist.

- [ ] **Step 3: Create transport interface and direct transport wrapper**

Create `mcp-server/browser-transport.ts`:

```ts
import type { BrowserApiOperation } from "./browser-operations";

export const BROWSER_TRANSPORT_MODES = ["direct", "forwarding"] as const;

export interface BrowserTransport {
  mode: (typeof BROWSER_TRANSPORT_MODES)[number];
  dispatch(operation: BrowserApiOperation, args: unknown[]): Promise<unknown>;
  close(): Promise<void> | void;
}
```

Re-export from `mcp-server/browser-api.ts`:

```ts
export { BROWSER_TRANSPORT_MODES } from "./browser-transport";
```

- [ ] **Step 4: Verify green**

Run: `cd mcp-server && npm test -- __tests__/browser-api.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/browser-transport.ts mcp-server/browser-api.ts mcp-server/__tests__/browser-api.test.mjs
git commit -m "feat: add browser transport boundary"
```

---

## Task 5: BrowserAPI Broker Selection And Forwarding

**Files:**
- Modify: `mcp-server/browser-api.ts`
- Modify: `mcp-server/__tests__/browser-api.test.mjs`

- [ ] **Step 1: Update port collision guidance test**

Replace the existing unavailable guidance assertions with:

```js
test("port-in-use guidance points to broker forwarding", () => {
  const message = buildPortInUseMessage(8089);
  assert.match(message, /port 8089/i);
  assert.match(message, /broker/i);
  assert.match(message, /forward/i);
  assert.match(message, /EXTENSION_PORT/i);
  assert.match(message, /EXTENSION_SECRET/i);
  assert.doesNotMatch(message, /unavailable in this session/i);
});
```

- [ ] **Step 2: Verify red**

Run: `cd mcp-server && npm test -- __tests__/browser-api.test.mjs`

Expected: FAIL because current guidance says tools are unavailable.

- [ ] **Step 3: Implement forwarding mode in `BrowserAPI`**

Modify `mcp-server/browser-api.ts`:

```ts
const BROKER_REQUEST_TIMEOUT_MS = 15_000;
```

Update `buildPortInUseMessage()`:

```ts
export function buildPortInUseMessage(port: number): string {
  return (
    `browser-control: port ${port} is already in use, likely by another MCP client session. ` +
    "No live broker responded for this EXTENSION_PORT and EXTENSION_SECRET, so forwarding could not start. " +
    "If this is a different browser, configure it with a different EXTENSION_PORT and EXTENSION_SECRET."
  );
}
```

Add fields:

```ts
private brokerInfo: BrokerInfo | null = null;
private brokerServer: ReturnType<typeof createBrokerServer> | null = null;
```

Replace the port-in-use branch in `init()`:

```ts
const identity = createBrokerIdentity({ port, extensionSecret: secret });

if (await isPortInUse(port)) {
  const brokerInfo = readBrokerInfo(identity);
  if (brokerInfo && await pingBroker({ socketPath: brokerInfo.socketPath, token: brokerInfo.token, timeoutMs: 1000 })) {
    this.brokerInfo = brokerInfo;
    console.error(`browser-control: forwarding browser tools for ${identity.id} to broker process ${brokerInfo.pid}`);
    return;
  }
  this.unavailableReason = buildPortInUseMessage(port);
  console.error(this.unavailableReason);
  return;
}
```

After direct WebSocket servers start:

```ts
const token = createBrokerToken();
const socketPath = getBrokerSocketPath(identity);
const info = { pid: process.pid, identity, socketPath, token, protocolVersion: BROKER_PROTOCOL_VERSION, startedAt: Date.now() };
this.brokerServer = createBrokerServer({
  socketPath,
  token,
  handleOperation: (operation, args) => this.dispatchOperation(operation, args),
});
await this.brokerServer.start();
writeBrokerInfo(info);
this.brokerInfo = info;
```

Add helper:

```ts
private async forwardIfNeeded(operation: BrowserApiOperation, args: unknown[]): Promise<unknown | null> {
  if (!this.brokerInfo || this.brokerInfo.pid === process.pid) {
    return null;
  }
  return forwardToBroker({
    socketPath: this.brokerInfo.socketPath,
    token: this.brokerInfo.token,
    operation,
    args,
    timeoutMs: BROKER_REQUEST_TIMEOUT_MS,
  });
}
```

At the top of each public method:

```ts
const forwarded = await this.forwardIfNeeded("getTabList", []);
if (forwarded !== null) return forwarded as BrowserTab[];
```

Apply equivalent forwarding to all public operations.

Add `dispatchOperation()` with a strict switch using `BrowserApiOperation`.

Update `close()`:

```ts
if (this.brokerInfo?.pid === process.pid) {
  clearBrokerInfo(this.brokerInfo);
}
this.brokerServer?.close().catch((error) => console.error("Failed to close browser-control broker", error));
```

- [ ] **Step 4: Verify green**

Run: `cd mcp-server && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/browser-api.ts mcp-server/__tests__/browser-api.test.mjs
git commit -m "feat: forward browser operations to singleton broker"
```

---

## Task 6: Release 1.6.0 And Verify

**Files:**
- Modify release files listed above.
- Modify `CHANGELOG.md`.

- [ ] **Step 1: Bump versions to `1.6.0`**

Update all version holders to `1.6.0`, including `mcp-server/server.ts` runtime version.

- [ ] **Step 2: Add changelog entry**

Insert at top of `CHANGELOG.md`:

```md
## 1.6.0 - 2026-05-17

### Added

- Add singleton broker/forwarder mode so many local MCP client sessions configured with the same browser port and pairing key can share one browser extension WebSocket connection. Different browsers can use different ports and keys to get separate brokers. ([eyalzh/browser-control-mcp#53](https://github.com/eyalzh/browser-control-mcp/issues/53))
```

- [ ] **Step 3: Full verification**

Run:

```bash
cd mcp-server && npm test
cd ../firefox-extension && npm test
cd .. && npm run build
docker build --build-arg HTTP_PROXY=http://host.docker.internal:8118 --build-arg HTTPS_PROXY=http://host.docker.internal:8118 --build-arg NO_PROXY=localhost,127.0.0.1 --build-arg NPM_REGISTRY=https://nexus.iad-dev.opower.it/repository/npm-all/ --build-arg NPM_STRICT_SSL=false -t browser-control-mcp:test .
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit release**

```bash
git add CHANGELOG.md package.json package-lock.json common/package.json mcp-server/package.json mcp-server/package-lock.json mcp-server/manifest.json mcp-server/server.ts firefox-extension/package.json firefox-extension/package-lock.json firefox-extension/manifest.json
git commit -m "chore: release singleton broker v1.6.0"
```

- [ ] **Step 5: Push and PR**

Create PR title:

```text
feat: add singleton browser broker (v1.6.0)
```

PR body must include:

```md
### Upstream References
- Primary upstream issue: eyalzh/browser-control-mcp#53

### Summary
Adds a singleton local broker so many MCP client processes configured with the same browser port and pairing key can share one browser extension WebSocket connection. Browsers configured with different ports and keys use separate broker identities.
```

---

## Self-Review

- Spec coverage: The plan covers many clients sharing one browser identity, separate browser identities by port plus extension-secret hash, private broker token, broker/forwarder split, operation whitelist, IPC auth, timeout behavior, and release to `1.6.0`.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: `BrowserApiOperation`, broker request operation names, and public `BrowserAPI` methods use the same names.
