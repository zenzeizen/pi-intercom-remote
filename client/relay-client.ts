/**
 * RelayClient — the pi-relay client's connection to the relay server.
 *
 * Translates pi-intercom-shaped operations (`send`, `ask`, `reply`,
 * `listSessions`) into pi-relay wire frames and vice versa. Emits semantic
 * events the extension layer hooks into:
 *   - "connected" / "disconnected"
 *   - "peer_joined" (SessionInfo)
 *   - "peer_left" (sessionId, reason)
 *   - "message" (from, Message)             — fire-and-forget peer.send
 *   - "ask" (from, Message)                  — peer.ask, expecting our reply
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  ClientMessage as WireClientMessage,
  ServerMessage as WireServerMessage,
  SessionInfo as WireSessionInfo,
} from "@pi-relay/shared";
import { PROTOCOL_VERSION } from "@pi-relay/shared";
import type { Message, SendResult, SessionInfo } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (pi-intercom parity)

export interface RelayClientOptions {
  url: string;
  identity: Omit<WireSessionInfo, "sessionId">;
  authCredential?: string;
  /** Auto-rejoin this room after every (re)connect. */
  room?: string;
}

interface SendInternalOptions {
  text: string;
  messageId?: string;
  replyTo?: string;
  expectsReply?: boolean;
  /** Internal: timeout for ask (ignored if expectsReply is false). */
  askTimeoutMs?: number;
}

export class RelayClient extends EventEmitter {
  private ws?: WebSocket;
  private _sessionId?: string;
  private _room?: string;
  private peers = new Map<string, SessionInfo>();
  private readonly tracker = new ReplyTracker();
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private explicitlyClosed = false;
  /** Resolves when the welcome frame is received (per-connection). */
  private welcomePending?: { resolve: () => void; reject: (e: Error) => void };
  /** Resolves when a pending room.create / room.join completes. */
  private roomOpPending?: {
    kind: "create" | "join";
    code?: string;
    resolve: (code: string) => void;
    reject: (e: Error) => void;
  };

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this._room = opts.room;
  }

  // --- Lifecycle ---------------------------------------------------------

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.explicitlyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.tracker.rejectAllOutbound(new Error("client disconnecting"));
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "client disconnect");
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get room(): string | undefined {
    return this._room;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this._sessionId !== undefined;
  }

  listSessions(): SessionInfo[] {
    return [...this.peers.values()];
  }

  // --- Room operations ---------------------------------------------------

  /** Create a new room and join it. Returns the new room code. */
  async createRoom(): Promise<string> {
    if (!this.connected) throw new Error("not connected to relay");
    if (this.roomOpPending) throw new Error("another room operation is in flight");
    return new Promise<string>((resolve, reject) => {
      this.roomOpPending = { kind: "create", resolve, reject };
      this.sendWire({ type: "room.create" });
    });
  }

  /** Join an existing room by code. */
  async joinRoom(code: string): Promise<void> {
    if (!this.connected) throw new Error("not connected to relay");
    if (this.roomOpPending) throw new Error("another room operation is in flight");
    await new Promise<void>((resolve, reject) => {
      this.roomOpPending = {
        kind: "join",
        code,
        resolve: () => resolve(),
        reject,
      };
      this.sendWire({ type: "room.join", code });
    });
  }

  /** Leave the current room without disconnecting from the relay. */
  leaveRoom(): void {
    if (!this._room) return;
    this.sendWire({ type: "room.leave" });
    this._room = undefined;
    this.peers.clear();
  }

  // --- Messaging ---------------------------------------------------------

  /**
   * Fire-and-forget or blocking peer message. If `expectsReply` is true the
   * promise resolves with the peer's reply Message; otherwise it resolves
   * with `{ delivered: true }` (or rejects on routing error).
   */
  async send(to: string, opts: SendInternalOptions): Promise<SendResult | Message> {
    if (!this.connected) throw new Error("not connected to relay");
    if (!this._room) throw new Error("not in a room — call createRoom or joinRoom first");
    if (!this.peers.has(to)) throw new Error(`no peer ${to} in current room`);

    const messageId = opts.messageId ?? randomUUID();

    if (opts.expectsReply) {
      // Wire-level: peer.ask. Client-level: returns the reply Message.
      this.sendWire({
        type: "peer.ask",
        to,
        requestId: messageId,
        body: opts.text,
      });
      return new Promise<Message>((resolve, reject) => {
        const timeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
        const timer = setTimeout(() => {
          this.tracker.resolveOutbound(messageId, {
            id: randomUUID(),
            timestamp: Date.now(),
            replyTo: messageId,
            content: { text: "" },
          });
          reject(new Error(`ask timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.tracker.registerOutbound({
          requestId: messageId,
          to: this.peers.get(to)!,
          body: opts.text,
          startedAt: Date.now(),
          resolve,
          reject,
          timer,
        });
      });
    }

    if (opts.replyTo) {
      // peer.reply
      this.sendWire({
        type: "peer.reply",
        to,
        requestId: opts.replyTo,
        body: opts.text,
      });
      this.tracker.resolveInbound(opts.replyTo);
    } else {
      // Plain peer.send
      this.sendWire({ type: "peer.send", to, body: opts.text });
    }
    return { id: messageId, delivered: true };
  }

  /** Inbound asks awaiting our reply (for `intercom_pending` UX, deferred for v1). */
  listPendingAsks(): ReturnType<ReplyTracker["listInbound"]> {
    return this.tracker.listInbound();
  }

  // --- Internals ---------------------------------------------------------

  private sendWire(msg: WireClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      this.welcomePending = { resolve, reject };

      ws.on("open", () => {
        // Send hello immediately. Welcome will fulfill the connect promise.
        this.sendWire({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          info: this.opts.identity,
          ...(this.opts.authCredential
            ? { auth: { scheme: "token", credential: this.opts.authCredential } }
            : {}),
        });
      });

      ws.on("message", (data) => {
        let parsed: WireServerMessage;
        try {
          parsed = JSON.parse(data.toString("utf8")) as WireServerMessage;
        } catch {
          return;
        }
        this.handleServer(parsed);
      });

      ws.on("close", (code) => {
        const wasConnected = this._sessionId !== undefined;
        this._sessionId = undefined;
        this.peers.clear();
        this.tracker.rejectAllOutbound(new Error("relay connection closed"));
        if (this.welcomePending) {
          this.welcomePending.reject(new Error(`relay closed before welcome (code ${code})`));
          this.welcomePending = undefined;
        }
        if (wasConnected) this.emit("disconnected", { code });
        if (!this.explicitlyClosed) this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        // 'close' will fire next; let it handle reconnect.
        this.emit("ws_error", err);
      });
    });
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.openSocket()
        .then(() => {
          this.reconnectAttempt = 0;
          // Rejoin the configured room if we had one.
          if (this._room) {
            this.joinRoom(this._room).catch((err) => {
              this.emit("ws_error", err);
            });
          }
        })
        .catch(() => {
          this.scheduleReconnect();
        });
    }, delay);
  }

  private handleServer(msg: WireServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        this._sessionId = msg.sessionId;
        this.emit("connected", { sessionId: msg.sessionId });
        this.welcomePending?.resolve();
        this.welcomePending = undefined;
        return;
      }
      case "room.created": {
        this._room = msg.code;
        this.peers.clear();
        for (const peer of msg.peers) {
          this.peers.set(peer.sessionId, this.peerInfoFromWire(peer));
        }
        const pending = this.roomOpPending;
        this.roomOpPending = undefined;
        pending?.resolve(msg.code);
        return;
      }
      case "room.joined": {
        this._room = msg.code;
        this.peers.clear();
        for (const peer of msg.peers) {
          this.peers.set(peer.sessionId, this.peerInfoFromWire(peer));
        }
        const pending = this.roomOpPending;
        this.roomOpPending = undefined;
        pending?.resolve(msg.code);
        return;
      }
      case "room.peer-joined": {
        const info = this.peerInfoFromWire(msg.peer);
        this.peers.set(info.id, info);
        this.emit("peer_joined", info);
        return;
      }
      case "room.peer-left": {
        const info = this.peers.get(msg.sessionId);
        this.peers.delete(msg.sessionId);
        this.tracker.dropInboundFrom(msg.sessionId);
        this.emit("peer_left", { sessionId: msg.sessionId, reason: msg.reason, info });
        return;
      }
      case "peer.send.delivered": {
        const message: Message = {
          id: randomUUID(),
          timestamp: Date.now(),
          content: { text: msg.body },
        };
        const from = this.peers.get(msg.from);
        if (from) this.emit("message", from, message);
        return;
      }
      case "peer.ask.delivered": {
        const message: Message = {
          id: msg.requestId,
          timestamp: Date.now(),
          expectsReply: true,
          content: { text: msg.body },
        };
        const from = this.peers.get(msg.from);
        if (from) {
          this.tracker.recordInbound({ from, message, receivedAt: Date.now() });
          this.emit("ask", from, message);
        }
        return;
      }
      case "peer.reply.delivered": {
        const message: Message = {
          id: randomUUID(),
          timestamp: Date.now(),
          replyTo: msg.requestId,
          content: { text: msg.body },
        };
        this.tracker.resolveOutbound(msg.requestId, message);
        const from = this.peers.get(msg.from);
        if (from) this.emit("reply", from, message);
        return;
      }
      case "error": {
        // If it relates to a pending room op, reject that.
        if (this.roomOpPending && (msg.inResponseTo === "room.create" || msg.inResponseTo === "room.join")) {
          this.roomOpPending.reject(new Error(`${msg.code}: ${msg.message}`));
          this.roomOpPending = undefined;
        }
        this.emit("relay_error", msg);
        return;
      }
      case "pong":
        return;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
      }
    }
  }

  private peerInfoFromWire(p: WireSessionInfo): SessionInfo {
    return {
      id: p.sessionId,
      name: p.name,
      cwd: p.cwd,
      model: p.model,
      status: p.status,
    };
  }
}
