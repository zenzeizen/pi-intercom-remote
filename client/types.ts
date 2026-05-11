/**
 * Client-side types. These mirror pi-intercom's `types.ts` shape so all the
 * UI components and reply tracker can be ported as near-verbatim copies.
 *
 * The wire protocol (which is independent) is defined in @pi-intercom-remote/shared.
 * Translation between wire SessionInfo and this SessionInfo happens at the
 * RelayClient boundary.
 */

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}
