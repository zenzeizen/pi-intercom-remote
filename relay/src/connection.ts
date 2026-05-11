import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  ErrorCode,
  ServerMessage,
  SessionId,
  SessionInfo,
} from "@pi-relay/shared";
import { PROTOCOL_VERSION } from "@pi-relay/shared";
import type { Authenticator } from "./auth.js";
import type { Logger } from "./logger.js";
import type { RoomRegistry } from "./rooms.js";
import { normalizeRoomCode } from "./codes.js";

/**
 * Per-connection state and message handler. One Connection wraps one
 * WebSocket. State machine is trivial: AWAITING_HELLO → READY → CLOSED.
 */
type ConnState = "awaiting_hello" | "ready" | "closed";

export class Connection {
  readonly sessionId: SessionId = randomUUID();
  info: SessionInfo = { sessionId: this.sessionId, name: "pi-agent" };
  private state: ConnState = "awaiting_hello";

  constructor(
    private readonly ws: WebSocket,
    private readonly rooms: RoomRegistry,
    private readonly auth: Authenticator,
    private readonly log: Logger,
  ) {}

  send(msg: ServerMessage): void {
    if (this.state === "closed") return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendError(code: ErrorCode, message: string, inResponseTo?: ClientMessage["type"]): void {
    this.send({ type: "error", code, message, inResponseTo });
  }

  private fatal(code: ErrorCode, message: string, inResponseTo?: ClientMessage["type"]): void {
    this.sendError(code, message, inResponseTo);
    this.ws.close(1008, code);
  }

  async handle(raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.fatal("protocol_invalid_message", "malformed JSON");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      this.fatal("protocol_invalid_message", "missing type field");
      return;
    }

    if (this.state === "awaiting_hello" && msg.type !== "hello") {
      this.fatal("protocol_expected_hello", "hello must be the first frame", msg.type);
      return;
    }

    switch (msg.type) {
      case "hello":
        await this.handleHello(msg);
        return;
      case "room.create":
        this.handleRoomCreate();
        return;
      case "room.join":
        this.handleRoomJoin(msg.code);
        return;
      case "room.leave":
        this.handleRoomLeave();
        return;
      case "peer.send":
        this.handlePeerSend(msg.to, msg.body);
        return;
      case "peer.ask":
        this.handlePeerAsk(msg.to, msg.requestId, msg.body);
        return;
      case "peer.reply":
        this.handlePeerReply(msg.to, msg.requestId, msg.body);
        return;
      case "ping":
        this.send({ type: "pong", ts: msg.ts });
        return;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
        this.sendError("protocol_invalid_message", "unknown message type");
      }
    }
  }

  private async handleHello(msg: import("@pi-relay/shared").HelloMessage): Promise<void> {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.fatal(
        "protocol_unsupported_version",
        `relay speaks v${PROTOCOL_VERSION}, client sent v${msg.protocolVersion}`,
        "hello",
      );
      return;
    }
    const result = await this.auth.authenticate(msg, this.sessionId);
    if (!result.ok || !result.identity) {
      this.fatal("auth_failed", result.reason ?? "authentication failed", "hello");
      return;
    }
    this.info = result.identity;
    this.state = "ready";
    this.send({ type: "welcome", sessionId: this.sessionId, protocolVersion: PROTOCOL_VERSION });
    this.log.log("info", "session.ready", { sessionId: this.sessionId, name: this.info.name });
  }

  private handleRoomCreate(): void {
    if (this.rooms.findBySession(this.sessionId)) {
      this.sendError("room_already_in", "session already in a room", "room.create");
      return;
    }
    const room = this.rooms.createRoom(this);
    this.send({ type: "room.created", code: room.code, peers: this.rooms.peerInfos(room) });
    this.log.log("info", "room.created", { sessionId: this.sessionId, code: room.code });
  }

  private handleRoomJoin(rawCode: string): void {
    if (this.rooms.findBySession(this.sessionId)) {
      this.sendError("room_already_in", "session already in a room; leave first", "room.join");
      return;
    }
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.findByCode(code);
    if (!room) {
      this.sendError("room_not_found", `no room with code ${code}`, "room.join");
      return;
    }
    this.rooms.addToRoom(room, this);
    const peers = this.rooms.peerInfos(room);
    this.send({ type: "room.joined", code: room.code, peers });
    // Notify everyone else in the room.
    for (const member of room.members.values()) {
      if (member.sessionId === this.sessionId) continue;
      member.send({ type: "room.peer-joined", peer: this.info });
    }
    this.log.log("info", "room.joined", {
      sessionId: this.sessionId,
      code: room.code,
      peerCount: room.members.size,
    });
  }

  private handleRoomLeave(): void {
    const room = this.rooms.findBySession(this.sessionId);
    if (!room) {
      this.sendError("room_not_in", "session is not in a room", "room.leave");
      return;
    }
    this.rooms.removeSession(this.sessionId);
    for (const member of room.members.values()) {
      member.send({ type: "room.peer-left", sessionId: this.sessionId, reason: "left" });
    }
  }

  private handlePeerSend(to: string | undefined, body: string): void {
    const room = this.rooms.findBySession(this.sessionId);
    if (!room) {
      this.sendError("room_not_in", "join a room before sending", "peer.send");
      return;
    }
    if (to === undefined) {
      // Broadcast to all other peers.
      for (const member of room.members.values()) {
        if (member.sessionId === this.sessionId) continue;
        member.send({ type: "peer.send.delivered", from: this.sessionId, body });
      }
      return;
    }
    const target = room.members.get(to);
    if (!target) {
      this.sendError("peer_not_found", `no peer ${to} in this room`, "peer.send");
      return;
    }
    target.send({ type: "peer.send.delivered", from: this.sessionId, body });
  }

  private handlePeerAsk(to: string, requestId: string, body: string): void {
    const room = this.rooms.findBySession(this.sessionId);
    if (!room) {
      this.sendError("room_not_in", "join a room before asking", "peer.ask");
      return;
    }
    const target = room.members.get(to);
    if (!target) {
      this.sendError("peer_not_found", `no peer ${to} in this room`, "peer.ask");
      return;
    }
    target.send({ type: "peer.ask.delivered", from: this.sessionId, requestId, body });
  }

  private handlePeerReply(to: string, requestId: string, body: string): void {
    const room = this.rooms.findBySession(this.sessionId);
    if (!room) {
      this.sendError("room_not_in", "join a room before replying", "peer.reply");
      return;
    }
    const target = room.members.get(to);
    if (!target) {
      this.sendError("peer_not_found", `no peer ${to} in this room`, "peer.reply");
      return;
    }
    target.send({ type: "peer.reply.delivered", from: this.sessionId, requestId, body });
  }

  /** Called by the server on socket close. */
  onClose(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    const room = this.rooms.removeSession(this.sessionId);
    if (room) {
      for (const member of room.members.values()) {
        member.send({
          type: "room.peer-left",
          sessionId: this.sessionId,
          reason: "disconnected",
        });
      }
    }
    this.log.log("info", "session.closed", { sessionId: this.sessionId });
  }
}
