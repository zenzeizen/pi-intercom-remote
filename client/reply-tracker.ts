/**
 * Tracks outstanding `ask` operations. The client tool layer registers an
 * expected reply with a request id and a timeout, then awaits the promise.
 * When a matching reply arrives, the tracker resolves it.
 *
 * Also tracks inbound asks (peer-originated, expecting a reply from us) so
 * the user / agent can list and answer them.
 */

import type { Message, SessionInfo } from "./types.ts";

export interface OutboundAskHandle {
  requestId: string;
  to: SessionInfo;
  body: string;
  startedAt: number;
  resolve(message: Message): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface InboundAskEntry {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

export class ReplyTracker {
  private readonly outbound = new Map<string, OutboundAskHandle>();
  private readonly inbound = new Map<string, InboundAskEntry>();

  registerOutbound(handle: OutboundAskHandle): void {
    this.outbound.set(handle.requestId, handle);
  }

  /** Resolve an outbound ask. Returns true if a matching ask was waiting. */
  resolveOutbound(requestId: string, reply: Message): boolean {
    const handle = this.outbound.get(requestId);
    if (!handle) return false;
    clearTimeout(handle.timer);
    this.outbound.delete(requestId);
    handle.resolve(reply);
    return true;
  }

  /** Reject all outstanding outbound asks (e.g. on disconnect). */
  rejectAllOutbound(err: Error): void {
    for (const handle of this.outbound.values()) {
      clearTimeout(handle.timer);
      handle.reject(err);
    }
    this.outbound.clear();
  }

  /** Add an inbound ask the user / agent will need to reply to. */
  recordInbound(entry: InboundAskEntry): void {
    this.inbound.set(entry.message.id, entry);
  }

  /** Mark an inbound ask as answered and remove it. */
  resolveInbound(messageId: string): InboundAskEntry | undefined {
    const entry = this.inbound.get(messageId);
    if (entry) this.inbound.delete(messageId);
    return entry;
  }

  /** Drop inbound asks from a peer that left. */
  dropInboundFrom(sessionId: string): void {
    for (const [id, entry] of this.inbound) {
      if (entry.from.id === sessionId) this.inbound.delete(id);
    }
  }

  listInbound(): InboundAskEntry[] {
    return [...this.inbound.values()].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /** For status reporting. */
  counts(): { outbound: number; inbound: number } {
    return { outbound: this.outbound.size, inbound: this.inbound.size };
  }
}
