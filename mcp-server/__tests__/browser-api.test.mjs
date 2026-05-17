import assert from "node:assert/strict";
import test from "node:test";

import browserApi from "../dist/browser-api.js";

const { buildPortInUseMessage, getWebSocketHosts } = browserApi;

test("binds to both IPv4 and IPv6 loopback outside containers", () => {
  assert.deepEqual(getWebSocketHosts(false), ["127.0.0.1", "::1"]);
});

test("binds to all interfaces inside containers", () => {
  assert.deepEqual(getWebSocketHosts(true), ["0.0.0.0"]);
});

test("port-in-use guidance explains likely parallel session ownership", () => {
  const message = buildPortInUseMessage(8089);

  assert.match(message, /port 8089/i);
  assert.match(message, /another .*session/i);
  assert.match(message, /unavailable in this session/i);
  assert.doesNotMatch(message, /configure a different port/i);
});
