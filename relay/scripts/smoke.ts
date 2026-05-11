/**
 * End-to-end smoke test for the relay.
 *
 * Spawns the relay on an ephemeral port, opens two WebSocket clients, walks
 * the v1 protocol (hello → room.create / room.join → peer.send (plain) →
 * peer.send (ask) → peer.send (reply) → disconnect), and asserts expected
 * frames at each step. Exits non-zero on any failure.
 *
 *   npm run smoke --workspace=@pi-relay/relay
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type {
  ClientMessage,
  PeerMessage,
  ServerMessage,
} from "@pi-relay/shared";
import { PROTOCOL_VERSION } from "@pi-relay/shared";

const require = createRequire(import.meta.url);

const HOST = "127.0.0.1";
const PORT = 18787;
const URL = `ws://${HOST}:${PORT}`;

class Client {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  private resolvers: Array<{
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(public readonly tag: string) {
    this.ws = new WebSocket(URL);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as ServerMessage;
      this.received.push(msg);
      const still: typeof this.resolvers = [];
      for (const r of this.resolvers) {
        if (r.predicate(msg)) {
          clearTimeout(r.timer);
          r.resolve(msg);
        } else {
          still.push(r);
        }
      }
      this.resolvers = still;
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor<T extends ServerMessage["type"]>(
    type: T,
    timeoutMs = 2000,
    extra?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    // Drain any already-buffered match first.
    for (let i = 0; i < this.received.length; i++) {
      const m = this.received[i]!;
      if (m.type === type && (!extra || extra(m as Extract<ServerMessage, { type: T }>))) {
        this.received.splice(i, 1);
        return Promise.resolve(m as Extract<ServerMessage, { type: T }>);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${this.tag}] timeout waiting for ${type}`)),
        timeoutMs,
      );
      this.resolvers.push({
        predicate: (m) => m.type === type && (!extra || extra(m as Extract<ServerMessage, { type: T }>)),
        resolve: (m) => resolve(m as Extract<ServerMessage, { type: T }>),
        reject,
        timer,
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function newMessage(text: string, opts: Partial<PeerMessage> = {}): PeerMessage {
  return {
    id: opts.id ?? randomUUID(),
    timestamp: Date.now(),
    content: { text, ...(opts.content?.attachments ? { attachments: opts.content.attachments } : {}) },
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.expectsReply ? { expectsReply: opts.expectsReply } : {}),
  };
}

async function spawnRelay(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), "src/server.ts"],
    {
      env: { ...process.env, PI_RELAY_HOST: HOST, PI_RELAY_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (b) => process.stdout.write(`[relay] ${b}`));
  child.stderr!.on("data", (b) => process.stderr.write(`[relay] ${b}`));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay startup timeout")), 5000);
    const onData = (b: Buffer) => {
      if (b.toString("utf8").includes("relay.listening")) {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`relay exited early: code=${code}`)));
  });
  return child;
}

async function main(): Promise<void> {
  const relay = await spawnRelay();
  let exitCode = 0;
  try {
    const a = new Client("A");
    const b = new Client("B");
    await Promise.all([a.open(), b.open()]);

    // Hello + welcome ---------------------------------------------------
    a.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, info: { name: "agent-A" } });
    b.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, info: { name: "agent-B" } });
    const aWelcome = await a.waitFor("welcome");
    const bWelcome = await b.waitFor("welcome");
    assert(aWelcome.sessionId && bWelcome.sessionId, "both clients got sessionIds");
    assert(aWelcome.sessionId !== bWelcome.sessionId, "sessionIds differ");
    console.log("✓ hello → welcome");

    // Room creation + join ---------------------------------------------
    a.send({ type: "room.create" });
    const created = await a.waitFor("room.created");
    assert(/^[A-Z]{3}-\d{3}$/.test(created.code), `room code shape: ${created.code}`);
    console.log(`✓ room.create → ${created.code}`);

    b.send({ type: "room.join", code: created.code });
    const bJoined = await b.waitFor("room.joined");
    assert(bJoined.peers.length === 2, "B sees 2 peers");
    await a.waitFor("room.peer-joined");
    console.log("✓ room.join → synced");

    // Plain peer.send (no expectsReply, no replyTo) --------------------
    const plain = newMessage("hello from A");
    a.send({ type: "peer.send", to: bWelcome.sessionId, message: plain });
    const aAck = await a.waitFor("peer.ack", 2000, (m) => m.messageId === plain.id);
    assert(aAck.delivered, "plain message acknowledged");
    const delivered = await b.waitFor("peer.message");
    assert(delivered.from === aWelcome.sessionId, "from = A");
    assert(delivered.message.content.text === "hello from A", "body intact");
    console.log("✓ peer.send (plain) routed");

    // Ask + reply (using expectsReply + replyTo) -----------------------
    const askMsg = newMessage("what is 2+2?", { expectsReply: true });
    b.send({ type: "peer.send", to: aWelcome.sessionId, message: askMsg });
    await b.waitFor("peer.ack", 2000, (m) => m.messageId === askMsg.id);
    const askDelivered = await a.waitFor("peer.message");
    assert(askDelivered.message.expectsReply === true, "ask carried expectsReply");
    assert(askDelivered.message.id === askMsg.id, "ask id preserved");

    const replyMsg = newMessage("4", { replyTo: askMsg.id });
    a.send({ type: "peer.send", to: bWelcome.sessionId, message: replyMsg });
    await a.waitFor("peer.ack", 2000, (m) => m.messageId === replyMsg.id);
    const replyDelivered = await b.waitFor("peer.message");
    assert(replyDelivered.message.replyTo === askMsg.id, "reply correlates to ask");
    assert(replyDelivered.message.content.text === "4", "reply body");
    console.log("✓ ask / reply round-trip via expectsReply + replyTo");

    // Attachments pass through unchanged --------------------------------
    const withAttachment = newMessage("see attached", {
      content: {
        text: "see attached",
        attachments: [{ type: "snippet", name: "demo.ts", content: "let x = 1;", language: "ts" }],
      },
    });
    a.send({ type: "peer.send", to: bWelcome.sessionId, message: withAttachment });
    await a.waitFor("peer.ack", 2000, (m) => m.messageId === withAttachment.id);
    const attached = await b.waitFor("peer.message");
    assert(attached.message.content.attachments?.length === 1, "attachment delivered");
    assert(attached.message.content.attachments![0].name === "demo.ts", "attachment name intact");
    console.log("✓ attachments pass through");

    // Presence update --------------------------------------------------
    a.send({ type: "presence.update", info: { status: "thinking" } });
    const presence = await b.waitFor("room.peer-presence");
    assert(presence.info.status === "thinking", "presence forwarded");
    console.log("✓ presence.update forwarded");

    // Disconnect handling ----------------------------------------------
    b.close();
    const peerLeft = await a.waitFor("room.peer-left");
    assert(peerLeft.sessionId === bWelcome.sessionId, "A sees B leave");
    assert(peerLeft.reason === "disconnected", "reason = disconnected");
    console.log("✓ disconnect → room.peer-left");

    a.close();
    console.log("\nALL SMOKE CHECKS PASSED");
  } catch (err) {
    console.error("SMOKE TEST FAILED:", err);
    exitCode = 1;
  } finally {
    relay.kill("SIGINT");
    await delay(200);
    process.exit(exitCode);
  }
}

void main();
