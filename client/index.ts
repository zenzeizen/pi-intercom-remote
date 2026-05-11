/**
 * pi-relay extension entry point.
 *
 * Wires a RelayClient (cross-machine WebSocket) to pi's extension surface:
 *   - 6 LLM tools (send, ask, reply, list, pending, status)
 *   - /intercom command with sub-actions (new, join, leave, status)
 *   - alt+m shortcut → session list overlay
 *   - Inline renderer for incoming peer messages
 *   - Auto-connect on session_start; clean disconnect on shutdown
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
import type { Message, SessionInfo } from "./types.ts";
import { openSessionListOverlay } from "./ui/session-list.ts";
import { InlineMessageComponent, type InlineMessageDetails } from "./ui/inline-message.ts";

const PRESENCE_NAME_FALLBACK = "pi-agent";

export default function piRelayExtension(pi: ExtensionAPI): void {
  let client: RelayClient | null = null;
  let config: RelayConfig | null = null;
  let runtimeCtx: ExtensionContext | null = null;
  /** Notify the user via banner if a UI is attached. No-op otherwise. */
  const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
    if (runtimeCtx?.hasUI) runtimeCtx.ui.notify(message, level);
  };

  // --------------------------------------------------------------------
  // Connection management
  // --------------------------------------------------------------------

  function resolveIdentityName(): string {
    const sessionName = pi.getSessionName();
    if (sessionName && sessionName.trim()) return sessionName.trim();
    if (config?.displayName?.trim()) return config.displayName.trim();
    try {
      return `${PRESENCE_NAME_FALLBACK}@${hostname()}`;
    } catch {
      return PRESENCE_NAME_FALLBACK;
    }
  }

  async function ensureConnected(): Promise<RelayClient> {
    if (client?.connected) return client;
    if (!config) config = await loadConfig();
    if (config.enabled === false) {
      throw new Error("pi-relay is disabled in config. Set `enabled: true` to use it.");
    }
    const fresh = new RelayClient({
      url: config.relayUrl,
      identity: {
        name: resolveIdentityName(),
        cwd: runtimeCtx?.cwd,
        model: runtimeCtx?.model?.id,
      },
      authCredential: config.authCredential,
      room: config.room,
    });
    wireClientEvents(fresh);
    await fresh.connect();
    if (config.room) {
      try {
        await fresh.joinRoom(config.room);
      } catch (err) {
        notify(`Could not rejoin room ${config.room}: ${(err as Error).message}`, "warning");
      }
    }
    client = fresh;
    return fresh;
  }

  function wireClientEvents(c: RelayClient): void {
    c.on("connected", ({ sessionId }: { sessionId: string }) => {
      notify(`pi-relay connected (session ${sessionId.slice(0, 8)})`, "info");
    });
    c.on("disconnected", () => {
      notify("pi-relay disconnected; will attempt to reconnect.", "warning");
    });
    c.on("peer_joined", (peer: SessionInfo) => {
      notify(`pi-relay: ${peer.name ?? peer.id.slice(0, 8)} joined the room`, "info");
    });
    c.on("peer_left", (
      ev: { sessionId: string; reason: "left" | "disconnected"; info?: SessionInfo },
    ) => {
      const label = ev.info?.name ?? ev.sessionId.slice(0, 8);
      notify(`pi-relay: ${label} left (${ev.reason})`, "info");
    });
    c.on("message", (from: SessionInfo, message: Message) => {
      surfaceInbound(from, message, false);
    });
    c.on("ask", (from: SessionInfo, message: Message) => {
      surfaceInbound(from, message, true);
    });
    c.on("relay_error", (err: { code: string; message: string }) => {
      notify(`pi-relay error: ${err.code} — ${err.message}`, "error");
    });
  }

  function surfaceInbound(from: SessionInfo, message: Message, expectsReply: boolean): void {
    const label = from.name ?? from.id.slice(0, 8);
    const preview = previewBody(message.content.text, 80);
    notify(
      `${expectsReply ? "Ask" : "Message"} from ${label}: ${preview}`,
      "info",
    );
    const details: InlineMessageDetails = {
      from,
      message,
      expectsReply,
      replyCommand: expectsReply
        ? `intercom_reply (to "${from.id}" requestId "${message.id}")`
        : undefined,
    };
    pi.sendMessage({
      customType: "pi_relay_message",
      content: `${expectsReply ? "ask" : "msg"} from ${label}: ${preview}`,
      display: true,
      details,
    });
  }

  function previewBody(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= max) return flat;
    return flat.slice(0, max - 1) + "…";
  }

  function requireConnected(): RelayClient {
    if (!client?.connected) {
      throw new Error("pi-relay not connected. Run `/intercom join <code>` or `/intercom new`.");
    }
    return client;
  }

  function findPeerByIdOrName(c: RelayClient, idOrName: string): SessionInfo | undefined {
    const peers = c.listSessions();
    const direct = peers.find((p) => p.id === idOrName);
    if (direct) return direct;
    const named = peers.filter((p) => p.name?.toLowerCase() === idOrName.toLowerCase());
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new Error(`Multiple peers named "${idOrName}". Use a session id instead.`);
    return undefined;
  }

  function textResult(text: string): AgentToolResult<unknown> {
    return { content: [{ type: "text", text }], details: undefined };
  }

  // --------------------------------------------------------------------
  // Lifecycle hooks
  // --------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    runtimeCtx = ctx;
    try {
      config = await loadConfig();
    } catch (err) {
      notify(`pi-relay config error: ${(err as Error).message}`, "error");
      return;
    }
    if (config.enabled === false) return;
    try {
      await ensureConnected();
    } catch (err) {
      notify(`pi-relay could not connect: ${(err as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore — process is exiting
      }
      client = null;
    }
  });

  // --------------------------------------------------------------------
  // Tools (LLM-callable)
  // --------------------------------------------------------------------

  pi.registerTool({
    name: "intercom_send",
    label: "Intercom Send",
    description: "Send a fire-and-forget message to another pi session in the current pi-relay room. Use this when you want to share information without expecting a structured reply.",
    promptSnippet: "Send a one-way message to another pi session via pi-relay.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient session id or name." }),
      message: Type.String({ description: "Plain-text body of the message." }),
    }),
    async execute(_id, params) {
      try {
        const c = requireConnected();
        const peer = findPeerByIdOrName(c, params.to);
        if (!peer) return textResult(`No peer "${params.to}" in current room.`);
        const result = await c.send(peer.id, { text: params.message });
        return textResult(`Sent to ${peer.name ?? peer.id}: ${"delivered" in result ? "delivered" : "queued"}`);
      } catch (err) {
        return textResult((err as Error).message);
      }
    },
  });

  pi.registerTool({
    name: "intercom_ask",
    label: "Intercom Ask",
    description: "Send a question to another pi session and block until they reply, with a 10-minute timeout. Use this when you need a structured answer to continue your work.",
    promptSnippet: "Ask another pi session a question and wait for their reply.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient session id or name." }),
      question: Type.String({ description: "The question to ask." }),
      timeoutMinutes: Type.Optional(Type.Number({
        description: "Timeout in minutes. Defaults to 10. Maximum 60.",
        minimum: 1,
        maximum: 60,
      })),
    }),
    async execute(_id, params, signal) {
      try {
        const c = requireConnected();
        const peer = findPeerByIdOrName(c, params.to);
        if (!peer) return textResult(`No peer "${params.to}" in current room.`);
        const askTimeoutMs = (params.timeoutMinutes ?? 10) * 60 * 1000;
        const onAbort = () => {
          // Reply timeout/abort handled inside RelayClient.send via promise rejection
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const reply = (await c.send(peer.id, {
            text: params.question,
            expectsReply: true,
            askTimeoutMs,
          })) as Message;
          return textResult(`${peer.name ?? peer.id}: ${reply.content.text}`);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      } catch (err) {
        return textResult((err as Error).message);
      }
    },
  });

  pi.registerTool({
    name: "intercom_reply",
    label: "Intercom Reply",
    description: "Reply to a pending ask from another pi session. Use this after intercom_pending shows an unanswered question directed at you.",
    promptSnippet: "Reply to a pending ask from another pi session.",
    parameters: Type.Object({
      to: Type.String({ description: "Original asker's session id." }),
      requestId: Type.String({ description: "Message id of the ask being answered (from intercom_pending)." }),
      message: Type.String({ description: "Reply body." }),
    }),
    async execute(_id, params) {
      try {
        const c = requireConnected();
        const peer = findPeerByIdOrName(c, params.to);
        if (!peer) return textResult(`No peer "${params.to}" in current room.`);
        await c.send(peer.id, { text: params.message, replyTo: params.requestId });
        return textResult(`Replied to ${peer.name ?? peer.id}`);
      } catch (err) {
        return textResult((err as Error).message);
      }
    },
  });

  pi.registerTool({
    name: "intercom_list",
    label: "Intercom List",
    description: "List all pi sessions in the current pi-relay room, including self.",
    promptSnippet: "List peers in the current pi-relay room.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const c = requireConnected();
        const peers = c.listSessions();
        if (peers.length === 0) return textResult("No peers in room (or not in a room yet).");
        const lines = peers.map((p) => {
          const tags: string[] = [];
          if (p.id === c.sessionId) tags.push("self");
          if (p.status) tags.push(p.status);
          const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
          return `- ${p.name ?? "(unnamed)"} (${p.id.slice(0, 8)})${suffix}`;
        });
        return textResult(`Room ${c.room}:\n${lines.join("\n")}`);
      } catch (err) {
        return textResult((err as Error).message);
      }
    },
  });

  pi.registerTool({
    name: "intercom_pending",
    label: "Intercom Pending",
    description: "List inbound asks from other pi sessions that have not yet been answered. Use this to find questions you need to reply to.",
    promptSnippet: "List unanswered asks from other pi sessions.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const c = requireConnected();
        const pending = c.listPendingAsks();
        if (pending.length === 0) return textResult("No pending asks.");
        const lines = pending.map((p) => {
          const elapsed = Math.round((Date.now() - p.receivedAt) / 1000);
          return `- from ${p.from.name ?? p.from.id} (id ${p.from.id.slice(0, 8)}) | requestId ${p.message.id} | ${elapsed}s ago\n    ${previewBody(p.message.content.text, 200)}`;
        });
        return textResult(lines.join("\n"));
      } catch (err) {
        return textResult((err as Error).message);
      }
    },
  });

  pi.registerTool({
    name: "intercom_status",
    label: "Intercom Status",
    description: "Report pi-relay connection state, current room code, and own session id.",
    promptSnippet: "Report pi-relay connection state and current room.",
    parameters: Type.Object({}),
    async execute() {
      const cfg = config ?? (await loadConfig());
      if (!client?.connected) {
        return textResult(`pi-relay: disconnected. Relay URL: ${cfg.relayUrl}`);
      }
      const room = client.room ?? "(no room)";
      const peers = client.listSessions().length;
      return textResult(
        `pi-relay: connected\n  session: ${client.sessionId}\n  room: ${room}\n  peers: ${peers}\n  relay: ${cfg.relayUrl}`,
      );
    },
  });

  // --------------------------------------------------------------------
  // /intercom slash command
  // --------------------------------------------------------------------

  pi.registerCommand("intercom", {
    description: "Manage pi-relay room: /intercom new | join <code> | leave | status | overlay",
    handler: async (args, ctx) => {
      const cmdCtx = ctx as ExtensionCommandContext;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase() ?? "overlay";

      try {
        if (sub === "new") {
          const c = await ensureConnected();
          const code = await c.createRoom();
          await updateConfig({ room: code });
          if (config) config.room = code;
          notify(`pi-relay room created: ${code}`, "info");
          return;
        }
        if (sub === "join") {
          const code = tokens[1];
          if (!code) {
            notify("Usage: /intercom join <code>", "warning");
            return;
          }
          const c = await ensureConnected();
          await c.joinRoom(code);
          await updateConfig({ room: code });
          if (config) config.room = code;
          notify(`pi-relay joined ${code}`, "info");
          return;
        }
        if (sub === "leave") {
          if (!client?.connected || !client.room) {
            notify("pi-relay: not in a room", "warning");
            return;
          }
          client.leaveRoom();
          await updateConfig({ room: undefined });
          if (config) config.room = undefined;
          notify("pi-relay: left room", "info");
          return;
        }
        if (sub === "status") {
          const cfg = config ?? (await loadConfig());
          if (!client?.connected) {
            notify(`pi-relay: disconnected (relay ${cfg.relayUrl})`, "warning");
            return;
          }
          notify(
            `pi-relay: connected to ${cfg.relayUrl} • room ${client.room ?? "(none)"} • ${client.listSessions().length} peer(s)`,
            "info",
          );
          return;
        }
        if (sub === "overlay" || sub === "") {
          await openIntercomOverlay(cmdCtx);
          return;
        }
        notify(`Unknown /intercom subcommand: ${sub}. Try: new, join, leave, status, overlay`, "warning");
      } catch (err) {
        notify(`/intercom ${sub} failed: ${(err as Error).message}`, "error");
      }
    },
  });

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    try {
      const c = await ensureConnected();
      await openSessionListOverlay(ctx, c);
    } catch (err) {
      notify(`pi-relay overlay: ${(err as Error).message}`, "error");
    }
  }

  pi.registerShortcut("alt+m", {
    description: "Open pi-relay session list",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });

  // --------------------------------------------------------------------
  // Inline renderer for incoming peer messages
  // --------------------------------------------------------------------

  pi.registerMessageRenderer<InlineMessageDetails>(
    "pi_relay_message",
    (message, _options, theme) => {
      if (!message.details) return undefined;
      return new InlineMessageComponent(message.details, theme);
    },
  );

  // Stable internal id helper so other modules can mint correlation ids.
  void randomUUID;
}
