/**
 * pi-relay wire protocol (v1).
 *
 * Frames travel over a WebSocket. The transport handles framing — every
 * message is a single JSON object serialized into one WebSocket text frame.
 * Discriminated on `type`; payloads are flat objects.
 *
 * Direction is informational only — TypeScript enforces it via the union
 * names `ClientMessage` and `ServerMessage`.
 */

export const PROTOCOL_VERSION = 1 as const;

// --- Identifiers ---------------------------------------------------------

/** Opaque session id assigned by the relay on `hello`. */
export type SessionId = string;

/** Short, human-typeable room code (e.g. "ABC-123"). */
export type RoomCode = string;

/** Correlation id for matching `peer.ask` to `peer.reply`. */
export type RequestId = string;

/** Metadata a session advertises about itself to peers. */
export interface SessionInfo {
  sessionId: SessionId;
  /** Display name (defaults to hostname or "pi-agent"). */
  name: string;
  /** Working directory of the pi agent, for context in peer lists. */
  cwd?: string;
  /** Model the agent is running (e.g. "claude-opus-4-7"). */
  model?: string;
  /** Status reported by the agent (idle / thinking / tool). */
  status?: "idle" | "thinking" | "tool";
}

// --- Client → Relay ------------------------------------------------------

/**
 * First frame the client sends after the WebSocket opens. The relay replies
 * with `welcome` and a session id, or `error` and closes.
 */
export interface HelloMessage {
  type: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  info: Omit<SessionInfo, "sessionId">;
  /**
   * Reserved for future auth schemes. v1 ignores this — the room code is
   * the access control gate, scoped to room.create / room.join.
   */
  auth?: { scheme: string; credential: string };
}

/** Ask the relay to mint a new room and put this session in it. */
export interface RoomCreateMessage {
  type: "room.create";
}

/** Join an existing room by its code. */
export interface RoomJoinMessage {
  type: "room.join";
  code: RoomCode;
}

/** Leave the current room (without disconnecting the session). */
export interface RoomLeaveMessage {
  type: "room.leave";
}

/**
 * Fire-and-forget message to one peer (or all peers if `to` is omitted).
 */
export interface PeerSendMessage {
  type: "peer.send";
  /** Target session id. If omitted, broadcast to all other peers in the room. */
  to?: SessionId;
  body: string;
}

/**
 * Question that expects a `peer.reply` with the same `requestId`. The relay
 * just routes — the asking client is responsible for the reply timeout
 * (pi-intercom uses 10 minutes).
 */
export interface PeerAskMessage {
  type: "peer.ask";
  to: SessionId;
  requestId: RequestId;
  body: string;
}

/** Reply to a `peer.ask`. */
export interface PeerReplyMessage {
  type: "peer.reply";
  to: SessionId;
  requestId: RequestId;
  body: string;
}

/** Heartbeat from client; relay answers with `pong`. */
export interface PingMessage {
  type: "ping";
  ts: number;
}

export type ClientMessage =
  | HelloMessage
  | RoomCreateMessage
  | RoomJoinMessage
  | RoomLeaveMessage
  | PeerSendMessage
  | PeerAskMessage
  | PeerReplyMessage
  | PingMessage;

// --- Relay → Client ------------------------------------------------------

/** Sent in response to `hello`. */
export interface WelcomeMessage {
  type: "welcome";
  sessionId: SessionId;
  protocolVersion: typeof PROTOCOL_VERSION;
}

/** Sent in response to `room.create`. */
export interface RoomCreatedMessage {
  type: "room.created";
  code: RoomCode;
  /** Always just this session at room-creation time. Included for symmetry with room.joined. */
  peers: SessionInfo[];
}

/** Sent in response to a successful `room.join`. */
export interface RoomJoinedMessage {
  type: "room.joined";
  code: RoomCode;
  /** All sessions currently in the room, including this one. */
  peers: SessionInfo[];
}

/** A new peer joined the room this session is in. */
export interface RoomPeerJoinedMessage {
  type: "room.peer-joined";
  peer: SessionInfo;
}

/** A peer left the room (cleanly via room.leave, or by disconnecting). */
export interface RoomPeerLeftMessage {
  type: "room.peer-left";
  sessionId: SessionId;
  reason: "left" | "disconnected";
}

/** A `peer.send` routed from another session in the room. */
export interface PeerSendDeliveredMessage {
  type: "peer.send.delivered";
  from: SessionId;
  body: string;
}

/** A `peer.ask` routed from another session in the room. */
export interface PeerAskDeliveredMessage {
  type: "peer.ask.delivered";
  from: SessionId;
  requestId: RequestId;
  body: string;
}

/** A `peer.reply` routed from another session in the room. */
export interface PeerReplyDeliveredMessage {
  type: "peer.reply.delivered";
  from: SessionId;
  requestId: RequestId;
  body: string;
}

/** Heartbeat response. */
export interface PongMessage {
  type: "pong";
  ts: number;
}

/**
 * Sent when a client message can't be processed. The relay closes the
 * connection only for protocol/auth-level errors (codes `protocol_*`,
 * `auth_*`); routing/operational errors are reported and the session
 * continues.
 */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
  /** Echoes the offending message type when applicable. */
  inResponseTo?: ClientMessage["type"];
}

export type ErrorCode =
  | "protocol_unsupported_version"
  | "protocol_invalid_message"
  | "protocol_expected_hello"
  | "auth_failed"
  | "room_not_found"
  | "room_already_in"
  | "room_not_in"
  | "peer_not_found"
  | "rate_limited"
  | "internal";

export type ServerMessage =
  | WelcomeMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomPeerJoinedMessage
  | RoomPeerLeftMessage
  | PeerSendDeliveredMessage
  | PeerAskDeliveredMessage
  | PeerReplyDeliveredMessage
  | PongMessage
  | ErrorMessage;

// --- Helpers -------------------------------------------------------------

export type AnyMessage = ClientMessage | ServerMessage;

/** Narrowing helper — useful in switch statements. */
export function isClientMessage(m: AnyMessage): m is ClientMessage {
  switch (m.type) {
    case "hello":
    case "room.create":
    case "room.join":
    case "room.leave":
    case "peer.send":
    case "peer.ask":
    case "peer.reply":
    case "ping":
      return true;
    default:
      return false;
  }
}
