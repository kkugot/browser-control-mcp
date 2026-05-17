import assert from "node:assert/strict";
import test from "node:test";

import browserApi from "../dist/browser-api.js";

const { getWebSocketHosts } = browserApi;

test("binds to both IPv4 and IPv6 loopback outside containers", () => {
  assert.deepEqual(getWebSocketHosts(false), ["127.0.0.1", "::1"]);
});

test("binds to all interfaces inside containers", () => {
  assert.deepEqual(getWebSocketHosts(true), ["0.0.0.0"]);
});
