import type {
  ExtensionMessage,
  ExtensionError,
  ServerMessageRequest,
} from "@browser-control-mcp/common";
import { getMessageSignature } from "./auth";

const RECONNECT_INTERVAL = 2000; // 2 seconds

// Extension-side trace logging (always on -- visible in browser extension console)
function trace(...args: unknown[]) {
  console.log("[browser-mcp:trace]", new Date().toISOString(), ...args);
}

export class WebsocketClient {
  private socket: WebSocket | null = null;
  private readonly port: number;
  private readonly secret: string;
  private reconnectTimer: number | null = null;
  private connectionAttempts: number = 0;
  private messageCallback: ((data: ServerMessageRequest) => void) | null = null;

  constructor(port: number, secret: string) {
    this.port = port;
    this.secret = secret;
  }

  public connect(): void {
    console.log("Connecting to WebSocket server at port", this.port);
    trace("connect() called", { port: this.port, attempt: this.connectionAttempts });

    this.socket = new WebSocket(`ws://localhost:${this.port}`);

    this.socket.addEventListener("open", () => {
      console.log("Connected to WebSocket server at port", this.port);
      trace("WebSocket open", { port: this.port });
      this.connectionAttempts = 0;
    });

    this.socket.addEventListener("close", (event) => {
      console.log("WebSocket connection closed event at port", this.port);
      trace("WebSocket closed", {
        port: this.port,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.connectionAttempts = 0;
    });

    this.socket.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
      trace("WebSocket error event", { port: this.port, type: event.type });
    });

    this.socket.addEventListener("message", async (event) => {
      if (this.messageCallback === null) {
        trace("Message received but no callback registered, ignoring");
        return;
      }
      try {
        const signedMessage = JSON.parse(event.data);
        trace("Received server message", {
          correlationId: signedMessage.payload?.correlationId,
          cmd: signedMessage.payload?.cmd,
        });
        const messageSig = await getMessageSignature(
          JSON.stringify(signedMessage.payload),
          this.secret
        );
        if (messageSig.length === 0 || messageSig !== signedMessage.signature) {
          console.error("Invalid message signature");
          trace("Signature verification failed", {
            correlationId: signedMessage.payload?.correlationId,
            cmd: signedMessage.payload?.cmd,
          });
          await this.sendErrorToServer(
            signedMessage.payload.correlationId,
            "Invalid message signature - extension and server not in sync"
          );
          return;
        }
        trace("Signature verified, dispatching to handler", {
          correlationId: signedMessage.payload.correlationId,
          cmd: signedMessage.payload.cmd,
        });
        this.messageCallback(signedMessage.payload);
      } catch (error) {
        console.error("Failed to parse message:", error);
        trace("Message parse/process error", { error: String(error) });
      }
    });

    // Start reconnection timer if not already running
    if (this.reconnectTimer === null) {
      this.startReconnectTimer();
    }
  }

  public addMessageListener(
    callback: (data: ServerMessageRequest) => void
  ): void {
    this.messageCallback = callback;
  }

  private startReconnectTimer(): void {
    this.reconnectTimer = window.setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
        this.connectionAttempts++;
        trace("Reconnect tick: still CONNECTING", {
          port: this.port,
          attempt: this.connectionAttempts,
        });

        if (this.connectionAttempts > 2) {
          // Avoid long retry backoff periods by resetting the connection
          trace("Force-closing stuck CONNECTING socket", { port: this.port });
          this.socket.close();
        }
      }

      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        trace("Reconnect tick: socket closed, reconnecting", { port: this.port });
        this.connect();
      }
    }, RECONNECT_INTERVAL);
  }

  public async sendResourceToServer(resource: ExtensionMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open");
      trace("sendResourceToServer: socket not open", {
        correlationId: resource.correlationId,
        resource: resource.resource,
        socketState: this.socket?.readyState ?? "null",
      });
      return;
    }
    const signedMessage = {
      payload: resource,
      signature: await getMessageSignature(
        JSON.stringify(resource),
        this.secret
      ),
    };
    trace("Sending resource to server", {
      correlationId: resource.correlationId,
      resource: resource.resource,
    });
    this.socket.send(JSON.stringify(signedMessage));
  }

  public async sendErrorToServer(
    correlationId: string,
    errorMessage: string
  ): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error("Socket is not open", this.socket);
      trace("sendErrorToServer: socket not open", {
        correlationId,
        errorMessage,
        socketState: this.socket?.readyState ?? "null",
      });
      return;
    }
    const extensionError: ExtensionError = {
      correlationId,
      errorMessage: errorMessage,
    };
    trace("Sending error to server", { correlationId, errorMessage });
    this.socket.send(JSON.stringify(extensionError));
  }

  public disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
