/**
 * RelayClient — pi-relay's WebSocket client.
 *
 * API mirrors pi-intercom's IntercomClient (sessionId, isConnected,
 * listSessions, send, updatePresence, disconnect, EventEmitter events:
 * `message` / `session_joined` / `session_left` / `presence_update` /
 * `disconnected` / `error`) so the extension layer reads as a near-line
 * port of pi-intercom's index.ts.
 *
 * Adds pi-relay-only room operations (createRoom, joinRoom, leaveRoom,
 * `room_changed` event) since pi-relay groups sessions into rooms instead
 * of pi-intercom's single global pool.
 *
 * Translates between the wire protocol (@pi-relay/shared) and the
 * pi-intercom-shaped Message / SessionInfo types in ./types.ts.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  ClientMessage as WireClientMessage,
  PeerMessage as WirePeerMessage,
  ServerMessage as WireServerMessage,
  SessionInfo as WireSessionInfo,
} from "./wire-protocol.ts";
import { PROTOCOL_VERSION } from "./wire-protocol.ts";
import type { Attachment, Message, SessionInfo } from "./types.ts";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const SEND_ACK_TIMEOUT_MS = 10_000;

export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

export interface RelayClientOptions {
  url: string;
  authCredential?: string;
  /** Identity to advertise via hello. */
  identity: Omit<SessionInfo, "id" | "lastActivity">;
}

/**
 * Pluggable filter for inbound peer.message frames. Used at the index.ts
 * layer to absorb reply messages addressed to an outstanding ask before
 * they're emitted to the rest of the system.
 *
 * Return true to consume the message (suppress the `message` event), false
 * to let it through.
 */
export type InboundMessageFilter = (from: SessionInfo, message: Message) => boolean;

export class RelayClient extends EventEmitter {
  private ws?: WebSocket;
  private _sessionId: string | null = null;
  private _room: string | null = null;
  private peers = new Map<string, SessionInfo>();
  private pendingSends = new Map<
    string,
    { resolve: (r: SendResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private explicitlyClosed = false;
  private welcomePending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private roomOpPending: {
    kind: "create" | "join";
    resolve: (code: string) => void;
    reject: (e: Error) => void;
  } | null = null;
  private inboundFilter: InboundMessageFilter | null = null;

  constructor(private readonly opts: RelayClientOptions) {
    super();
  }

  // --- pi-intercom-compatible API ---------------------------------------

  get sessionId(): string | null {
    return this._sessionId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this._sessionId !== null;
  }

  /** Returns the locally cached peer list. (RelayClient maintains it from room.* frames.) */
  listSessions(): Promise<SessionInfo[]> {
    if (!this.isConnected()) return Promise.reject(new Error("Not connected"));
    return Promise.resolve([...this.peers.values()]);
  }

  send(to: string, options: SendOptions): Promise<SendResult> {
    if (!this.isConnected()) {
      return Promise.reject(new Error("Not connected"));
    }
    if (!this.peers.has(to) && to !== this._sessionId) {
      return Promise.reject(new Error(`No peer ${to} in current room`));
    }
    const messageId = options.messageId ?? randomUUID();
    const message: WirePeerMessage = {
      id: messageId,
      timestamp: Date.now(),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.expectsReply ? { expectsReply: options.expectsReply } : {}),
      content: {
        text: options.text,
        ...(options.attachments ? { attachments: options.attachments } : {}),
      },
    };

    return new Promise<SendResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          reject(new Error("Send timeout"));
        }
      }, SEND_ACK_TIMEOUT_MS);
      this.pendingSends.set(messageId, { resolve, reject, timer });
      try {
        this.sendWire({ type: "peer.send", to, message });
      } catch (err) {
        clearTimeout(timer);
        this.pendingSends.delete(messageId);
        reject(err as Error);
      }
    });
  }

  updatePresence(updates: { name?: string; status?: string; model?: string; cwd?: string }): void {
    if (!this.isConnected()) return;
    try {
      this.sendWire({ type: "presence.update", info: updates });
    } catch {
      // best-effort
    }
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failPendingSends(new Error("Client disconnecting"));
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "client disconnect");
    }
  }

  // --- pi-relay-only room operations ------------------------------------

  get room(): string | null {
    return this._room;
  }

  async createRoom(): Promise<string> {
    if (!this.isConnected()) throw new Error("Not connected");
    if (this.roomOpPending) throw new Error("Another room operation is in flight");
    return new Promise<string>((resolve, reject) => {
      this.roomOpPending = { kind: "create", resolve, reject };
      this.sendWire({ type: "room.create" });
    });
  }

  async joinRoom(code: string): Promise<void> {
    if (!this.isConnected()) throw new Error("Not connected");
    if (this.roomOpPending) throw new Error("Another room operation is in flight");
    await new Promise<void>((resolve, reject) => {
      this.roomOpPending = {
        kind: "join",
        resolve: () => resolve(),
        reject,
      };
      this.sendWire({ type: "room.join", code });
    });
  }

  leaveRoom(): void {
    if (!this._room) return;
    try {
      this.sendWire({ type: "room.leave" });
    } catch {
      // best-effort
    }
    const prevRoom = this._room;
    this._room = null;
    this.peers.clear();
    this.emit("room_changed", { room: null, previous: prevRoom });
  }

  /** Install or clear a filter that can suppress inbound `message` events. */
  setInboundMessageFilter(filter: InboundMessageFilter | null): void {
    this.inboundFilter = filter;
  }

  // --- Internals --------------------------------------------------------

  private sendWire(msg: WireClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private failPendingSends(err: Error): void {
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingSends.clear();
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      this.welcomePending = { resolve, reject };

      ws.on("open", () => {
        const identity: Omit<WireSessionInfo, "sessionId"> = {
          name: this.opts.identity.name ?? "pi-agent",
          ...(this.opts.identity.cwd ? { cwd: this.opts.identity.cwd } : {}),
          ...(this.opts.identity.model ? { model: this.opts.identity.model } : {}),
          ...(this.opts.identity.pid !== undefined ? { pid: this.opts.identity.pid } : {}),
          ...(this.opts.identity.startedAt !== undefined ? { startedAt: this.opts.identity.startedAt } : {}),
          ...(this.opts.identity.status ? { status: this.opts.identity.status } : {}),
        };
        this.sendWire({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          info: identity,
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
        const wasConnected = this._sessionId !== null;
        this._sessionId = null;
        this._room = null;
        this.peers.clear();
        this.failPendingSends(new Error("Relay connection closed"));
        if (this.welcomePending) {
          this.welcomePending.reject(new Error(`Relay closed before welcome (code ${code})`));
          this.welcomePending = null;
        }
        if (wasConnected) this.emit("disconnected", new Error(`code ${code}`));
        if (!this.explicitlyClosed) this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        // 'close' will fire next; let it handle reconnect.
        this.emit("error", err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.openSocket()
        .then(() => {
          this.reconnectAttempt = 0;
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
        this.welcomePending?.resolve();
        this.welcomePending = null;
        return;
      }
      case "room.created": {
        this._room = msg.code;
        this.peers.clear();
        for (const peer of msg.peers) {
          this.peers.set(peer.sessionId, this.adaptPeer(peer));
        }
        const pending = this.roomOpPending;
        this.roomOpPending = null;
        pending?.resolve(msg.code);
        this.emit("room_changed", { room: msg.code, previous: null });
        return;
      }
      case "room.joined": {
        const previous = this._room;
        this._room = msg.code;
        this.peers.clear();
        for (const peer of msg.peers) {
          this.peers.set(peer.sessionId, this.adaptPeer(peer));
        }
        const pending = this.roomOpPending;
        this.roomOpPending = null;
        pending?.resolve(msg.code);
        this.emit("room_changed", { room: msg.code, previous });
        return;
      }
      case "room.peer-joined": {
        const peer = this.adaptPeer(msg.peer);
        this.peers.set(peer.id, peer);
        this.emit("session_joined", peer);
        return;
      }
      case "room.peer-left": {
        this.peers.delete(msg.sessionId);
        this.emit("session_left", msg.sessionId);
        return;
      }
      case "room.peer-presence": {
        const existing = this.peers.get(msg.sessionId);
        if (!existing) return;
        const merged: SessionInfo = {
          ...existing,
          ...(msg.info.name !== undefined ? { name: msg.info.name } : {}),
          ...(msg.info.cwd !== undefined ? { cwd: msg.info.cwd } : {}),
          ...(msg.info.model !== undefined ? { model: msg.info.model } : {}),
          ...(msg.info.status !== undefined ? { status: msg.info.status } : {}),
          ...(msg.info.pid !== undefined ? { pid: msg.info.pid } : {}),
          lastActivity: Date.now(),
        };
        this.peers.set(msg.sessionId, merged);
        this.emit("presence_update", merged);
        return;
      }
      case "peer.message": {
        const fromInfo = this.peers.get(msg.from);
        if (!fromInfo) return; // unknown peer (likely already left); drop
        const message = this.adaptMessage(msg.message);
        // Bump local last-activity so UI reflects when each peer was last heard from.
        this.peers.set(msg.from, { ...fromInfo, lastActivity: Date.now() });
        if (this.inboundFilter && this.inboundFilter(fromInfo, message)) return;
        this.emit("message", fromInfo, message);
        return;
      }
      case "peer.ack": {
        const pending = this.pendingSends.get(msg.messageId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingSends.delete(msg.messageId);
        pending.resolve({
          id: msg.messageId,
          delivered: msg.delivered,
          ...(msg.reason ? { reason: msg.reason } : {}),
        });
        return;
      }
      case "error": {
        if (this.roomOpPending && (msg.inResponseTo === "room.create" || msg.inResponseTo === "room.join")) {
          this.roomOpPending.reject(new Error(`${msg.code}: ${msg.message}`));
          this.roomOpPending = null;
        }
        this.emit("error", new Error(`${msg.code}: ${msg.message}`));
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

  private adaptPeer(wire: WireSessionInfo): SessionInfo {
    return {
      id: wire.sessionId,
      name: wire.name,
      cwd: wire.cwd ?? "",
      model: wire.model ?? "unknown",
      pid: wire.pid ?? 0,
      startedAt: wire.startedAt ?? 0,
      lastActivity: wire.lastActivity ?? Date.now(),
      ...(wire.status ? { status: wire.status } : {}),
    };
  }

  private adaptMessage(wire: WirePeerMessage): Message {
    return {
      id: wire.id,
      timestamp: wire.timestamp,
      ...(wire.replyTo ? { replyTo: wire.replyTo } : {}),
      ...(wire.expectsReply ? { expectsReply: wire.expectsReply } : {}),
      content: {
        text: wire.content.text,
        ...(wire.content.attachments ? { attachments: wire.content.attachments } : {}),
      },
    };
  }
}
