/**
 * Public types for the pi-relay client extension. These mirror pi-intercom's
 * shapes (`Message`, `Attachment`, `SessionInfo`) so any prior knowledge of
 * pi-intercom carries over to pi-relay. The wire protocol used between the
 * client and the relay is independent — translation happens in relay-client.ts.
 */

export interface SessionInfo {
  id: string;
  name?: string;
  cwd?: string;
  model?: string;
  status?: "idle" | "thinking" | "tool" | string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  /** ID of the message this one replies to (correlates ask → reply). */
  replyTo?: string;
  /** Sender wants a reply; relay does not enforce — the client tool layer waits. */
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}
