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
  const identity = broker.createBrokerIdentity({ port: 18091, extensionSecret: "secret-a" });
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

test("broker IPC requires the broker token and forwards operations", async () => {
  const token = broker.createBrokerToken();
  const identity = broker.createBrokerIdentity({ port: 18092, extensionSecret: "secret-a" });
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

test("broker IPC rejects unsupported operations", async () => {
  const token = broker.createBrokerToken();
  const identity = broker.createBrokerIdentity({ port: 18093, extensionSecret: "secret-a" });
  const socketPath = broker.getBrokerSocketPath(identity);
  const server = broker.createBrokerServer({
    socketPath,
    token,
    handleOperation: async () => {
      throw new Error("should not dispatch unsupported operations");
    },
  });

  await server.start();
  try {
    await assert.rejects(
      broker.forwardToBroker({ socketPath, token, operation: "constructor", args: [], timeoutMs: 1000 }),
      /unsupported browser operation/i
    );
  } finally {
    await server.close();
  }
});

test("broker server close removes the socket file before resolving", async () => {
  if (process.platform === "win32") {
    return;
  }

  const identity = broker.createBrokerIdentity({ port: 18094, extensionSecret: "secret-a" });
  const socketPath = broker.getBrokerSocketPath(identity);
  const server = broker.createBrokerServer({
    socketPath,
    token: broker.createBrokerToken(),
    handleOperation: async () => "ok",
  });

  await server.start();
  assert.equal(await broker.socketPathExists(socketPath), true);
  await server.close();
  assert.equal(await broker.socketPathExists(socketPath), false);
});
