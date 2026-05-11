/**
 * pi-relay wire protocol (v1).
 *
 * Frames travel over a WebSocket. Each frame is a single JSON object in one
 * text frame. Discriminated on `type`. The transport handles framing — no
 * length prefix needed at the JSON layer.
 *
 * The peer-payload shape (`PeerMessage`) mirrors pi-intercom's `Message`
 * type so the broker-equivalent semantics (ask/reply, threading,
 * attachments) live on the message itself rather than in separate frames.
 */

export const PROTOCOL_VERSION = 1 as const;

// --- Identifiers --------------------------------------------------------

export type SessionId = string;
export type RoomCode = string;

/**
 * Metadata a session advertises about itself to peers. Mirrors pi-intercom's
 * `SessionInfo` shape (minus the `id`, which lives in `sessionId`) so the
 * client's UI overlays can consume it directly after a small adapter.
 */
export interface SessionInfo {
  sessionId: SessionId;
  name: string;
  cwd?: string;
  model?: string;
  pid?: number;
  startedAt?: number;
  lastActivity?: number;
  status?: string;
}

// --- Peer message payload (mirrors pi-intercom Message) -----------------

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface PeerMessage {
  /** Client-generated id. Used as the correlation id when expectsReply=true. */
  id: string;
  /** Sender's wall-clock at send time. Not authoritative. */
  timestamp: number;
  /** Id of the message this one replies to, for threading + ask/reply correlation. */
  replyTo?: string;
  /** Sender wants a reply — receiver should treat this as a blocking ask. */
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

// --- Client → Relay -----------------------------------------------------

export interface HelloMessage {
  type: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  info: Omit<SessionInfo, "sessionId">;
  /** Reserved for future auth schemes; ignored by the default v1 authenticator. */
  auth?: { scheme: string; credential: string };
}

export interface RoomCreateMessage {
  type: "room.create";
}

export interface RoomJoinMessage {
  type: "room.join";
  code: RoomCode;
}

export interface RoomLeaveMessage {
  type: "room.leave";
}

export interface PeerSendFrame {
  type: "peer.send";
  to: SessionId;
  message: PeerMessage;
}

export interface PresenceUpdateMessage {
  type: "presence.update";
  info: Partial<Omit<SessionInfo, "sessionId">>;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export type ClientMessage =
  | HelloMessage
  | RoomCreateMessage
  | RoomJoinMessage
  | RoomLeaveMessage
  | PeerSendFrame
  | PresenceUpdateMessage
  | PingMessage;

// --- Relay → Client -----------------------------------------------------

export interface WelcomeMessage {
  type: "welcome";
  sessionId: SessionId;
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface RoomCreatedMessage {
  type: "room.created";
  code: RoomCode;
  peers: SessionInfo[];
}

export interface RoomJoinedMessage {
  type: "room.joined";
  code: RoomCode;
  peers: SessionInfo[];
}

export interface RoomPeerJoinedMessage {
  type: "room.peer-joined";
  peer: SessionInfo;
}

export interface RoomPeerLeftMessage {
  type: "room.peer-left";
  sessionId: SessionId;
  reason: "left" | "disconnected";
}

export interface PeerPresenceUpdateMessage {
  type: "room.peer-presence";
  sessionId: SessionId;
  info: Partial<Omit<SessionInfo, "sessionId">>;
}

export interface PeerMessageDeliveredMessage {
  type: "peer.message";
  from: SessionId;
  message: PeerMessage;
}

/** Confirms delivery of a peer.send back to the sender. */
export interface PeerMessageAckMessage {
  type: "peer.ack";
  messageId: string;
  delivered: boolean;
  reason?: string;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
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
  | PeerPresenceUpdateMessage
  | PeerMessageDeliveredMessage
  | PeerMessageAckMessage
  | PongMessage
  | ErrorMessage;

// --- Helpers ------------------------------------------------------------

export type AnyMessage = ClientMessage | ServerMessage;
