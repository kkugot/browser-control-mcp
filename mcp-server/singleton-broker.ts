import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { BrowserApiOperation } from "./browser-operations";
import { isBrowserApiOperation } from "./browser-operations";

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

interface BrokerRequest {
  id: string;
  protocolVersion: number;
  token: string;
  operation: BrowserApiOperation | "ping" | string;
  args: unknown[];
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
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

export function clearBrokerInfo(expected: BrokerInfo): void {
  const current = readBrokerInfo(expected.identity);
  if (current && current.token !== expected.token) {
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

export function socketPathExists(socketPath: string): boolean {
  return fs.existsSync(socketPath);
}

function respond(socket: net.Socket, response: BrokerResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(`Broker request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

export function createBrokerServer(options: {
  socketPath: string;
  token: string;
  handleOperation: (operation: BrowserApiOperation, args: unknown[]) => Promise<unknown>;
}) {
  let server: net.Server | null = null;

  return {
    async start(): Promise<void> {
      ensureBrokerDirectory();
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(options.socketPath);
        } catch {
          // Stale socket files are expected after unclean broker shutdowns.
        }
      }

      server = net.createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
          if (!data.endsWith("\n")) {
            return;
          }

          let request: BrokerRequest;
          try {
            request = JSON.parse(data) as BrokerRequest;
          } catch (error) {
            respond(socket, { id: "unknown", ok: false, error: `Invalid broker request: ${toErrorMessage(error)}` });
            return;
          }

          if (request.protocolVersion !== BROKER_PROTOCOL_VERSION) {
            respond(socket, { id: request.id, ok: false, error: "Unsupported broker protocol version" });
            return;
          }

          if (request.token !== options.token) {
            respond(socket, { id: request.id, ok: false, error: "Unauthorized broker request" });
            return;
          }

          if (request.operation === "ping") {
            respond(socket, { id: request.id, ok: true, result: "pong" });
            return;
          }

          if (!isBrowserApiOperation(request.operation)) {
            respond(socket, { id: request.id, ok: false, error: `Unsupported browser operation: ${request.operation}` });
            return;
          }

          options.handleOperation(request.operation, request.args)
            .then((result) => respond(socket, { id: request.id, ok: true, result }))
            .catch((error) => respond(socket, { id: request.id, ok: false, error: toErrorMessage(error) }));
        });
      });

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.socketPath, resolve);
      });
    },

    async close(): Promise<void> {
      if (!server) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(options.socketPath);
        } catch {
          // The socket may already be gone if close raced with cleanup.
        }
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
  let socket: net.Socket | null = null;
  const request: BrokerRequest = {
    id: crypto.randomUUID(),
    protocolVersion: BROKER_PROTOCOL_VERSION,
    token: options.token,
    operation: options.operation,
    args: options.args,
  };

  return withTimeout(new Promise((resolve, reject) => {
    socket = net.createConnection(options.socketPath);
    let data = "";

    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      try {
        const response = JSON.parse(data) as BrokerResponse;
        if (response.ok) {
          resolve(response.result);
          return;
        }
        reject(new Error(response.error ?? "Unknown broker error"));
      } catch (error) {
        reject(error);
      }
    });
    socket.write(`${JSON.stringify(request)}\n`);
  }), options.timeoutMs, () => socket?.destroy());
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
  operation: BrowserApiOperation | string;
  args: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  return sendBrokerRequest(options);
}
