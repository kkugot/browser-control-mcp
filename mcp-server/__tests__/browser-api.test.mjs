import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import browserApi from "../dist/browser-api.js";
import broker from "../dist/singleton-broker.js";

const { BrowserAPI, buildPortInUseMessage, getWebSocketHosts } = browserApi;

test("binds to both IPv4 and IPv6 loopback outside containers", () => {
  assert.deepEqual(getWebSocketHosts(false), ["127.0.0.1", "::1"]);
});

test("binds to all interfaces inside containers", () => {
  assert.deepEqual(getWebSocketHosts(true), ["0.0.0.0"]);
});

test("port-in-use guidance points to broker forwarding", () => {
  const message = buildPortInUseMessage(8089);

  assert.match(message, /port 8089/i);
  assert.match(message, /broker/i);
  assert.match(message, /forward/i);
  assert.match(message, /EXTENSION_PORT/i);
  assert.match(message, /EXTENSION_SECRET/i);
  assert.doesNotMatch(message, /unavailable in this session/i);
});

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

test("BrowserAPI exports transport mode names", () => {
  assert.deepEqual(browserApi.BROWSER_TRANSPORT_MODES, ["direct", "forwarding"]);
});

test("BrowserAPI forwards operations to a live broker for the same port and key", async () => {
  const previousSecret = process.env.EXTENSION_SECRET;
  const previousPort = process.env.EXTENSION_PORT;
  const previousContainerized = process.env.CONTAINERIZED;
  const tcpServer = net.createServer();

  await new Promise((resolve, reject) => {
    tcpServer.once("error", reject);
    tcpServer.listen(0, "localhost", resolve);
  });

  const address = tcpServer.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  const extensionSecret = `secret-${port}`;
  const identity = broker.createBrokerIdentity({ port, extensionSecret });
  const token = broker.createBrokerToken();
  const brokerServer = broker.createBrokerServer({
    socketPath: broker.getBrokerSocketPath(identity),
    token,
    handleOperation: async (operation, args) => {
      assert.equal(operation, "getTabList");
      assert.deepEqual(args, []);
      return [{ id: 123, url: "https://example.com" }];
    },
  });
  const info = {
    pid: process.pid + 1,
    identity,
    socketPath: broker.getBrokerSocketPath(identity),
    token,
    protocolVersion: 1,
    startedAt: Date.now(),
  };

  await brokerServer.start();
  broker.writeBrokerInfo(info);

  process.env.EXTENSION_SECRET = extensionSecret;
  process.env.EXTENSION_PORT = String(port);
  delete process.env.CONTAINERIZED;

  const api = new BrowserAPI();
  try {
    await api.init();
    assert.deepEqual(await api.getTabList(), [{ id: 123, url: "https://example.com" }]);
  } finally {
    api.close();
    broker.clearBrokerInfo(info);
    await brokerServer.close();
    await new Promise((resolve) => tcpServer.close(resolve));
    if (previousSecret === undefined) delete process.env.EXTENSION_SECRET;
    else process.env.EXTENSION_SECRET = previousSecret;
    if (previousPort === undefined) delete process.env.EXTENSION_PORT;
    else process.env.EXTENSION_PORT = previousPort;
    if (previousContainerized === undefined) delete process.env.CONTAINERIZED;
    else process.env.CONTAINERIZED = previousContainerized;
  }
});
