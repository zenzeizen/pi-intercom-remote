/**
 * End-to-end smoke test for the relay.
 *
 * Spawns the relay on an ephemeral port, opens two WebSocket clients, walks
 * the full v1 protocol (hello → room.create / room.join → peer.send →
 * peer.ask → peer.reply → disconnect), and asserts expected frames at each
 * step. Exits non-zero on any failure.
 *
 * Run from the repo root:
 *   npm run smoke --workspace=@pi-relay/relay
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
import type {
  ClientMessage,
  ServerMessage,
} from "@pi-relay/shared";
import { PROTOCOL_VERSION } from "@pi-relay/shared";

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
      // Dispatch to any matching waiter.
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
  ): Promise<Extract<ServerMessage, { type: T }>> {
    // Drain any already-buffered match first.
    for (let i = 0; i < this.received.length; i++) {
      const m = this.received[i]!;
      if (m.type === type) {
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
        predicate: (m) => m.type === type,
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

  // Wait for the relay.listening event on stdout.
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

    // Hello + welcome ----------------------------------------------------
    a.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, info: { name: "agent-A" } });
    b.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, info: { name: "agent-B" } });
    const aWelcome = await a.waitFor("welcome");
    const bWelcome = await b.waitFor("welcome");
    assert(aWelcome.sessionId && bWelcome.sessionId, "both clients got sessionIds");
    assert(aWelcome.sessionId !== bWelcome.sessionId, "sessionIds differ");
    console.log("✓ hello → welcome (both clients)");

    // Room creation + join ----------------------------------------------
    a.send({ type: "room.create" });
    const created = await a.waitFor("room.created");
    assert(/^[A-Z]{3}-\d{3}$/.test(created.code), `room code shape: ${created.code}`);
    assert(created.peers.length === 1, "creator is only peer");
    console.log(`✓ room.create → code ${created.code}`);

    b.send({ type: "room.join", code: created.code });
    const bJoined = await b.waitFor("room.joined");
    assert(bJoined.peers.length === 2, "B sees 2 peers in room.joined");
    const aPeerJoined = await a.waitFor("room.peer-joined");
    assert(aPeerJoined.peer.sessionId === bWelcome.sessionId, "A notified of B's join");
    console.log("✓ room.join → both sides synced");

    // peer.send ----------------------------------------------------------
    a.send({ type: "peer.send", to: bWelcome.sessionId, body: "hello from A" });
    const delivered = await b.waitFor("peer.send.delivered");
    assert(delivered.from === aWelcome.sessionId, "from = A");
    assert(delivered.body === "hello from A", "body intact");
    console.log("✓ peer.send routed A → B");

    // peer.ask / peer.reply ---------------------------------------------
    b.send({
      type: "peer.ask",
      to: aWelcome.sessionId,
      requestId: "req-1",
      body: "what is 2+2?",
    });
    const askedOnA = await a.waitFor("peer.ask.delivered");
    assert(askedOnA.requestId === "req-1" && askedOnA.body === "what is 2+2?", "ask intact");
    a.send({ type: "peer.reply", to: bWelcome.sessionId, requestId: "req-1", body: "4" });
    const replyOnB = await b.waitFor("peer.reply.delivered");
    assert(replyOnB.requestId === "req-1" && replyOnB.body === "4", "reply intact");
    console.log("✓ peer.ask / peer.reply round-trip");

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
    // Give it a moment to flush its shutdown log.
    await delay(200);
    process.exit(exitCode);
  }
}

void main();
