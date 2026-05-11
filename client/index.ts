/**
 * pi-intercom-remote extension entry.
 *
 * Ported from pi-intercom's index.ts: the same `intercom` tool surface
 * (actions list / send / ask / reply / pending / status), the same
 * idle-aware inbound queueing, the same reply-waiter pattern, the same
 * /intercom overlay command and alt+m shortcut, the same inline message
 * renderer. pi-intercom-remote adds room operations as extra tool actions
 * (`new`, `join`, `leave`) and companion /intercom shortcuts.
 *
 * Subagent/supervisor features from pi-intercom are dropped — they are
 * orthogonal to cross-machine relaying.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, updateConfig, type RelayConfig } from "./config.ts";
import { RelayClient } from "./relay-client.ts";
import type { Attachment, Message, SessionInfo } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";

const INBOUND_FLUSH_DELAY_MS = 200;
const INBOUND_IDLE_RETRY_MS = 500;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRESENCE_NAME = "pi-agent";
const NON_INTERACTIVE_BUSY_REPLY =
  "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.";

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}

function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map((s) => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index),
  );
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) return session.id;
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}

function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}

function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

function errorToolResult(text: string): AgentToolResult<{ error: true }> {
  return { content: [{ type: "text", text }], details: { error: true } };
}

function resolveSessionByQuery(
  sessions: SessionInfo[],
  query: string,
  options: { excludeSelf?: string } = {},
): { ok: true; session: SessionInfo } | { ok: false; error: string } {
  const lower = query.toLowerCase();
  const filterSelf = (s: SessionInfo) =>
    options.excludeSelf ? s.id !== options.excludeSelf : true;

  // 1. Exact id match.
  const exact = sessions.find((s) => s.id === query && filterSelf(s));
  if (exact) return { ok: true, session: exact };

  // 2. Prefix match on id (6+ chars to avoid accidental collision).
  if (query.length >= 6) {
    const prefixed = sessions.filter((s) => s.id.startsWith(query) && filterSelf(s));
    if (prefixed.length === 1) return { ok: true, session: prefixed[0]! };
    if (prefixed.length > 1) {
      return { ok: false, error: `Ambiguous id prefix "${query}". Use the full session id.` };
    }
  }

  // 3. Name match (case-insensitive, unique).
  const named = sessions.filter((s) => s.name?.toLowerCase() === lower && filterSelf(s));
  if (named.length === 1) return { ok: true, session: named[0]! };
  if (named.length > 1) {
    return {
      ok: false,
      error: `Multiple sessions named "${query}". Use a session id from intercom_list.`,
    };
  }

  return { ok: false, error: `No session "${query}" found in current room.` };
}

export default function piRelayExtension(pi: ExtensionAPI): void {
  // --- State ---------------------------------------------------------
  let client: RelayClient | null = null;
  let config: RelayConfig | null = null;
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let shuttingDown = false;
  let runtimeStarted = false;

  const replyTracker = new ReplyTracker(ASK_TIMEOUT_MS);
  const pendingIdleMessages: InboundMessageEntry[] = [];
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  let replyWaiter:
    | { from: string; replyTo: string; resolve: (m: Message) => void; reject: (e: Error) => void }
    | null = null;
  let agentRunning = false;
  const activeTools = new Map<string, string>();

  // --- Helpers -------------------------------------------------------

  function ensureConfig(): RelayConfig {
    if (!config) throw new Error("pi-intercom-remote config not loaded yet");
    return config;
  }

  function buildPresenceIdentity(): {
    name: string;
    cwd: string;
    model: string;
    pid: number;
    startedAt: number;
    status?: string;
  } {
    const piName = pi.getSessionName();
    const fallback = `${DEFAULT_PRESENCE_NAME}@${(() => {
      try {
        return hostname();
      } catch {
        return "host";
      }
    })()}-${process.pid.toString(36).slice(-3)}`;
    return {
      name: piName?.trim() || config?.displayName?.trim() || fallback,
      cwd: runtimeContext?.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt ?? Date.now(),
      status: currentStatus(),
    };
  }

  function currentStatus(): string {
    if (activeTools.size > 0) return "tool";
    if (agentRunning) return "thinking";
    return "idle";
  }

  function getLiveContext(ctx: ExtensionContext | null = runtimeContext): ExtensionContext | null {
    if (shuttingDown || !ctx) return null;
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) return null;
      void ctx.hasUI;
      return ctx;
    } catch {
      return null;
    }
  }

  function notifyIfLive(message: string, level: "info" | "warning" | "error" = "info"): void {
    const ctx = getLiveContext();
    process.stderr.write(`[pi-intercom-remote ${level}] ${message}\n`);
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Stale UI; nothing to do.
    }
  }

  function syncPresenceIdentity(): void {
    if (!client?.isConnected()) return;
    const identity = buildPresenceIdentity();
    client.updatePresence(identity);
  }

  async function ensureConnected(reason: "startup" | "tool" | "command"): Promise<RelayClient> {
    if (!config) config = await loadConfig();
    if (config.enabled === false) {
      throw new Error("pi-intercom-remote is disabled in config (set `enabled: true` to use).");
    }
    if (client?.isConnected()) return client;

    if (client) {
      // Clean up any half-dead instance before creating a new one.
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      client = null;
    }

    const identity = buildPresenceIdentity();
    const fresh = new RelayClient({
      url: config.relayUrl,
      authCredential: config.authCredential,
      identity,
    });
    attachClientHandlers(fresh);
    await fresh.connect();
    client = fresh;

    if (config.room) {
      try {
        await fresh.joinRoom(config.room);
      } catch (err) {
        notifyIfLive(
          `pi-intercom-remote: could not rejoin room ${config.room}: ${getErrorMessage(err)}`,
          "warning",
        );
      }
    }
    if (reason === "startup") {
      notifyIfLive(
        `pi-intercom-remote connected to ${config.relayUrl}${fresh.room ? ` (room ${fresh.room})` : ""}`,
      );
    }
    syncPresenceIdentity();
    return fresh;
  }

  function attachClientHandlers(c: RelayClient): void {
    c.setInboundMessageFilter((from, message) => {
      if (!replyWaiter) return false;
      const senderTarget = from.name || from.id;
      const fromMatches =
        senderTarget.toLowerCase() === replyWaiter.from.toLowerCase() || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return true; // consume — don't surface to transcript
      }
      return false;
    });

    c.on("message", (from: SessionInfo, message: Message) => {
      handleIncomingMessage(from, message);
    });
    c.on("session_joined", (peer: SessionInfo) => {
      notifyIfLive(`pi-intercom-remote: ${peer.name ?? shortSessionId(peer.id)} joined the room`);
    });
    c.on("session_left", (sessionId: string) => {
      notifyIfLive(`pi-intercom-remote: ${shortSessionId(sessionId)} left the room`);
    });
    c.on("presence_update", () => {
      // Silent — overlay/list reads fresh state on demand.
    });
    c.on("disconnected", () => {
      notifyIfLive("pi-intercom-remote disconnected; reconnecting…", "warning");
    });
    c.on("error", (err: Error) => {
      notifyIfLive(`pi-intercom-remote error: ${err.message}`, "warning");
    });
    c.on("room_changed", (ev: { room: string | null; previous: string | null }) => {
      if (ev.room) {
        notifyIfLive(`pi-intercom-remote: room ${ev.room} active`);
      } else if (ev.previous) {
        notifyIfLive(`pi-intercom-remote: left room ${ev.previous}`);
      }
    });
  }

  // --- Reply waiter for ask blocking ---------------------------------

  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) return Promise.reject(new Error("Already waiting for a reply"));
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within ${ASK_TIMEOUT_MS / 60_000} minutes`));
      }, ASK_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) replyWaiter = null;
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }

  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }

  // --- Inbound flush queue (idle-aware) ------------------------------

  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) return;
    clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }

  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp"): void {
    if (runtimeStarted && !getLiveContext()) return;
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || shortSessionId(entry.from.id);
    const replyInstruction = entry.replyCommand
      ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}`
      : "";
    pi.sendMessage(
      {
        customType: "pi_relay_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger" ? { triggerTurn: true } : { deliverAs: "followUp" },
    );
  }

  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) return;
    clearInboundFlushTimer();
    inboundFlushTimer = setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages();
    }, delayMs);
  }

  function flushIdleMessages(): void {
    if (pendingIdleMessages.length === 0) return;
    const ctx = getLiveContext();
    if (!ctx) return;
    let isIdle: boolean;
    try {
      isIdle = ctx.isIdle();
    } catch {
      return;
    }
    if (!isIdle) {
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }
    const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }

  function queueIdleMessage(entry: InboundMessageEntry): void {
    pendingIdleMessages.push(entry);
    scheduleInboundFlush();
  }

  function handleIncomingMessage(from: SessionInfo, message: Message): void {
    const ctx = getLiveContext();
    if (!ctx) return;
    // Reply-waiter already handled in setInboundMessageFilter — those messages
    // never reach us here.
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry: InboundMessageEntry = { from, message, bodyText, ...(replyCommand ? { replyCommand } : {}) };

    void (async () => {
      const activeContext = getLiveContext();
      if (!activeContext) return;
      let isIdle: boolean;
      try {
        isIdle = activeContext.isIdle();
      } catch {
        return;
      }
      if (!isIdle) {
        if (!activeContext.hasUI) {
          // Print/RPC mode + busy → auto-reply with the canned "I'm non-interactive" note.
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: NON_INTERACTIVE_BUSY_REPLY,
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext()) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort — keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry);
        return;
      }
      if (getLiveContext()) sendIncomingMessage(entry, "trigger");
    })();
  }

  // --- Overlay --------------------------------------------------------

  async function openIntercomOverlay(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      notifyIfLive("pi-intercom-remote overlay only available in interactive mode", "warning");
      return;
    }
    let c: RelayClient;
    try {
      c = await ensureConnected("command");
    } catch (err) {
      notifyIfLive(`pi-intercom-remote unavailable: ${getErrorMessage(err)}`, "error");
      return;
    }
    syncPresenceIdentity();
    if (!c.room) {
      notifyIfLive(
        "pi-intercom-remote: not in a room. Use `/intercom new` to create one or `/intercom join <code>` to join.",
        "warning",
      );
      return;
    }

    const sessions = await c.listSessions();
    const selfId = c.sessionId;
    const selfSession =
      sessions.find((s) => s.id === selfId) ??
      ({
        id: selfId ?? "",
        cwd: ctx.cwd,
        model: currentModel,
        pid: process.pid,
        startedAt: sessionStartedAt ?? Date.now(),
        lastActivity: Date.now(),
        name: buildPresenceIdentity().name,
      } as SessionInfo);

    const others = sessions.filter((s) => s.id !== selfId);
    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, selfSession, others, done),
      { overlay: true },
    );
    if (!selectedSession) return;

    const duplicates = duplicateSessionNames(sessions);
    const targetLabel = formatSessionLabel(selectedSession, duplicates);
    const composeResult = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) =>
        new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, c, done),
      { overlay: true },
    );
    if (composeResult.sent) {
      notifyIfLive(`pi-intercom-remote: message sent to ${targetLabel}`);
    }
  }

  // --- The single `intercom` tool ------------------------------------

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Communicate with another pi session in the current pi-intercom-remote room.

Usage:
  intercom({ action: "list" })                                    → List peers in current room
  intercom({ action: "send", to: "session-id", message: "..." })  → Fire-and-forget message
  intercom({ action: "ask",  to: "session-id", message: "..." })  → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                    → Reply to the active/single pending ask
  intercom({ action: "pending" })                                   → List unresolved inbound asks
  intercom({ action: "status" })                                    → Show connection / room status
  intercom({ action: "new" })                                       → Create a new room (returns code)
  intercom({ action: "join", to: "ABC-234" })                       → Join an existing room by code
  intercom({ action: "leave" })                                     → Leave the current room`,
    promptSnippet:
      "Use to coordinate with another pi session across machines via pi-intercom-remote: list peers, send updates, ask for help, or check connectivity.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "'list' | 'send' | 'ask' | 'reply' | 'pending' | 'status' | 'new' | 'join' | 'leave'",
      }),
      to: Type.Optional(
        Type.String({
          description:
            "Target session id/name (send, ask, disambiguating reply) OR room code (join). Full uuid or 6+ char prefix.",
        }),
      ),
      message: Type.Optional(Type.String({ description: "Message body (for send / ask / reply)." })),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
            name: Type.String(),
            content: Type.String(),
            language: Type.Optional(Type.String()),
          }),
        ),
      ),
      replyTo: Type.Optional(
        Type.String({ description: "Message ID to reply to (threading)." }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      runtimeContext = ctx;
      currentSessionId = ctx.sessionManager.getSessionId();

      let activeClient: RelayClient;
      try {
        activeClient = await ensureConnected("tool");
      } catch (err) {
        return errorToolResult(`pi-intercom-remote not connected: ${getErrorMessage(err)}`);
      }
      syncPresenceIdentity();

      const action = String(params.action).toLowerCase();

      try {
        switch (action) {
          case "list":
            return handleList(activeClient);
          case "pending":
            return handlePending();
          case "status":
            return handleStatus(activeClient);
          case "new":
            return await handleNew(activeClient);
          case "join":
            return await handleJoin(activeClient, params.to);
          case "leave":
            return handleLeave(activeClient);
          case "send":
            return await handleSend(activeClient, params, signal);
          case "ask":
            return await handleAsk(activeClient, params, signal);
          case "reply":
            return await handleReply(activeClient, params);
          default:
            return errorToolResult(
              `Unknown action "${params.action}". Use one of: list, send, ask, reply, pending, status, new, join, leave.`,
            );
        }
      } catch (err) {
        return errorToolResult(`intercom ${action} failed: ${getErrorMessage(err)}`);
      }
    },
  });

  function handleList(c: RelayClient): AgentToolResult<unknown> {
    const sessions = [...listSessionsFromClient(c)];
    if (sessions.length === 0) {
      return textResult(c.room ? `Room ${c.room}: no peers yet.` : "Not in a room.");
    }
    const lines = sessions.map((s) =>
      formatSessionListRow(s, runtimeContext?.cwd ?? process.cwd(), s.id === c.sessionId),
    );
    return textResult(
      `Room ${c.room ?? "(none)"} (${sessions.length} session${sessions.length === 1 ? "" : "s"}):\n${lines.join("\n")}\n\nUse the long id (uuid) — or a unique 6+ char prefix — as the \`to\` parameter for send / ask.`,
    );
  }

  function handlePending(): AgentToolResult<unknown> {
    const pending = replyTracker.listPending();
    if (pending.length === 0) return textResult("No pending asks.");
    const lines = pending.map((p) => {
      const elapsed = Math.round((Date.now() - p.receivedAt) / 1000);
      const preview = previewText(p.message.content.text, 200) ?? "(no body)";
      return `- from ${p.from.name ?? p.from.id} (id ${shortSessionId(p.from.id)}) | requestId ${p.message.id} | ${elapsed}s ago\n    ${preview}`;
    });
    return textResult(lines.join("\n"));
  }

  function handleStatus(c: RelayClient): AgentToolResult<unknown> {
    const cfg = ensureConfig();
    const peerCount = c.isConnected() ? [...listSessionsFromClient(c)].length : 0;
    return textResult(
      [
        c.isConnected() ? "pi-intercom-remote: connected" : "pi-intercom-remote: disconnected",
        `  relay: ${cfg.relayUrl}`,
        `  session: ${c.sessionId ?? "(none)"}`,
        `  room: ${c.room ?? "(none)"}`,
        `  peers: ${peerCount}`,
      ].join("\n"),
    );
  }

  async function handleNew(c: RelayClient): Promise<AgentToolResult<unknown>> {
    if (c.room) {
      return errorToolResult(`Already in room ${c.room}. Leave first with intercom({ action: "leave" }).`);
    }
    const code = await c.createRoom();
    await updateConfig({ room: code });
    if (config) config.room = code;
    return textResult(`pi-intercom-remote room created: ${code}. Share this code with the other pi session.`);
  }

  async function handleJoin(c: RelayClient, to: unknown): Promise<AgentToolResult<unknown>> {
    if (typeof to !== "string" || !to.trim()) {
      return errorToolResult('Missing room code. Use intercom({ action: "join", to: "ABC-234" }).');
    }
    if (c.room) {
      c.leaveRoom();
    }
    await c.joinRoom(to.trim());
    await updateConfig({ room: c.room ?? undefined });
    if (config) config.room = c.room ?? undefined;
    return textResult(`Joined pi-intercom-remote room ${c.room}.`);
  }

  function handleLeave(c: RelayClient): AgentToolResult<unknown> {
    if (!c.room) return textResult("pi-intercom-remote: not in a room.");
    const prev = c.room;
    c.leaveRoom();
    void updateConfig({ room: undefined });
    if (config) config.room = undefined;
    return textResult(`Left pi-intercom-remote room ${prev}.`);
  }

  async function handleSend(
    c: RelayClient,
    params: { to?: string; message?: string; attachments?: Attachment[]; replyTo?: string },
    _signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> {
    if (!params.to) return errorToolResult("Missing `to` for send.");
    if (!params.message || !params.message.trim()) return errorToolResult("Missing `message` for send.");
    const resolved = resolveSessionByQuery([...listSessionsFromClient(c)], params.to, {
      excludeSelf: c.sessionId ?? undefined,
    });
    if (!resolved.ok) return errorToolResult(resolved.error);
    const result = await c.send(resolved.session.id, {
      text: params.message,
      attachments: params.attachments,
      replyTo: params.replyTo,
    });
    if (!result.delivered) {
      return errorToolResult(`Message not delivered: ${result.reason ?? "unknown reason"}`);
    }
    return textResult(`Sent to ${resolved.session.name ?? resolved.session.id} (message id ${result.id}).`);
  }

  async function handleAsk(
    c: RelayClient,
    params: { to?: string; message?: string; attachments?: Attachment[] },
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> {
    if (!params.to) return errorToolResult("Missing `to` for ask.");
    if (!params.message || !params.message.trim()) return errorToolResult("Missing `message` for ask.");
    if (replyWaiter) return errorToolResult("Already waiting for a reply to a previous ask.");
    const resolved = resolveSessionByQuery([...listSessionsFromClient(c)], params.to, {
      excludeSelf: c.sessionId ?? undefined,
    });
    if (!resolved.ok) return errorToolResult(resolved.error);
    const messageId = randomUUID();
    const sendResult = await c.send(resolved.session.id, {
      text: params.message,
      attachments: params.attachments,
      expectsReply: true,
      messageId,
    });
    if (!sendResult.delivered) {
      return errorToolResult(`Ask not delivered: ${sendResult.reason ?? "unknown reason"}`);
    }
    try {
      const reply = await waitForReply(resolved.session.id, messageId, signal);
      const replyText =
        reply.content.text +
        (reply.content.attachments?.length ? formatAttachments(reply.content.attachments) : "");
      return textResult(`${resolved.session.name ?? resolved.session.id} replied:\n\n${replyText}`);
    } catch (err) {
      return errorToolResult(getErrorMessage(err));
    }
  }

  async function handleReply(
    c: RelayClient,
    params: { to?: string; message?: string; attachments?: Attachment[] },
  ): Promise<AgentToolResult<unknown>> {
    if (!params.message || !params.message.trim()) return errorToolResult("Missing `message` for reply.");
    let context;
    try {
      context = replyTracker.resolveReplyTarget({ to: params.to });
    } catch (err) {
      return errorToolResult(getErrorMessage(err));
    }
    const result = await c.send(context.from.id, {
      text: params.message,
      attachments: params.attachments,
      replyTo: context.message.id,
    });
    if (!result.delivered) {
      return errorToolResult(`Reply not delivered: ${result.reason ?? "unknown reason"}`);
    }
    replyTracker.markReplied(context.message.id);
    return textResult(`Replied to ${context.from.name ?? context.from.id}.`);
  }

  function* listSessionsFromClient(c: RelayClient): IterableIterator<SessionInfo> {
    // Synchronous read from the local cache that the client maintains.
    // Using the same indirection so we don't need to await Promise in tool handlers.
    for (const s of (c as unknown as { peers: Map<string, SessionInfo> }).peers.values()) {
      yield s;
    }
  }

  // --- Slash command & shortcut -------------------------------------

  pi.registerCommand("intercom", {
    description: "Open pi-intercom-remote session intercom",
    handler: async (args, ctx) => {
      runtimeContext = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase();

      // Bare `/intercom` mirrors pi-intercom: open the overlay.
      if (!sub) {
        await openIntercomOverlay(ctx);
        return;
      }

      // Convenience aliases for room operations — call the tool actions directly.
      try {
        const c = await ensureConnected("command");
        if (sub === "new") {
          const result = await handleNew(c);
          notifyIfLive(textOf(result));
          return;
        }
        if (sub === "join") {
          const code = tokens[1];
          if (!code) {
            notifyIfLive("Usage: /intercom join <room-code>", "warning");
            return;
          }
          const result = await handleJoin(c, code);
          notifyIfLive(textOf(result));
          return;
        }
        if (sub === "leave") {
          const result = handleLeave(c);
          notifyIfLive(textOf(result));
          return;
        }
        if (sub === "status") {
          const result = handleStatus(c);
          notifyIfLive(textOf(result));
          return;
        }
        if (sub === "list") {
          const result = handleList(c);
          notifyIfLive(textOf(result));
          return;
        }
        if (sub === "overlay") {
          await openIntercomOverlay(ctx);
          return;
        }
        notifyIfLive(
          `Unknown /intercom subcommand: ${sub}. Try: new, join, leave, status, list, overlay (or bare /intercom).`,
          "warning",
        );
      } catch (err) {
        notifyIfLive(`/intercom ${sub} failed: ${getErrorMessage(err)}`, "error");
      }
    },
  });

  function textOf(result: AgentToolResult<unknown>): string {
    const first = result.content[0];
    return first && first.type === "text" ? first.text : "(no text)";
  }

  pi.registerShortcut("alt+m", {
    description: "Open pi-intercom-remote session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx as ExtensionCommandContext),
  });

  // --- Inline message renderer --------------------------------------

  pi.registerMessageRenderer<InboundMessageEntry>("pi_relay_message", (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;
    return new InlineMessageComponent(
      details.from,
      details.message,
      theme,
      details.replyCommand,
      details.bodyText,
    );
  });

  // --- Lifecycle hooks ----------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    sessionStartedAt = Date.now();
    runtimeStarted = true;
    shuttingDown = false;
    if (ctx.model) currentModel = ctx.model.id;
    try {
      config = await loadConfig();
    } catch (err) {
      notifyIfLive(`pi-intercom-remote config error: ${getErrorMessage(err)}`, "error");
      return;
    }
    if (config.enabled === false) return;
    try {
      await ensureConnected("startup");
    } catch (err) {
      notifyIfLive(`pi-intercom-remote could not connect: ${getErrorMessage(err)}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearInboundFlushTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      client = null;
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    runtimeContext = ctx;
    replyTracker.beginTurn();
  });

  pi.on("turn_end", () => {
    replyTracker.endTurn();
    // If anything queued while busy, give it a nudge — flushIdleMessages will
    // bail if we're still streaming.
    scheduleInboundFlush(0);
  });

  pi.on("agent_start", () => {
    agentRunning = true;
    syncPresenceIdentity();
  });

  pi.on("agent_end", () => {
    agentRunning = false;
    syncPresenceIdentity();
    scheduleInboundFlush(0);
  });

  pi.on("tool_execution_start", (event) => {
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceIdentity();
  });

  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
    syncPresenceIdentity();
  });

  pi.on("model_select", (event) => {
    currentModel = event.model.id;
    syncPresenceIdentity();
  });
}
