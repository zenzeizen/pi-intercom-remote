import { WebSocketServer } from "ws";
import { classifyHost, loadConfig, type RelayConfig } from "./config.js";
import { ConsoleLogger } from "./logger.js";
import { AllowAllAuthenticator } from "./auth.js";
import { RoomRegistry } from "./rooms.js";
import { Connection } from "./connection.js";

/**
 * Relay entrypoint. Wires the WebSocket server to the room registry and the
 * pluggable auth + logger. Each extension point is a single small interface
 * so embedders can override one behavior without diverging the whole file.
 */

function printExposureWarning(config: RelayConfig): void {
  const exposure = classifyHost(config.host);
  if (exposure === "loopback" || exposure === "tailscale") return;

  const lines: string[] = ["", "=".repeat(72)];
  if (exposure === "wildcard") {
    lines.push(
      `⚠  pi-intercom-remote binding to ${config.host}:${config.port} — every network interface.`,
      "",
      "   v1 has no per-room authentication and no end-to-end encryption.",
      "   Anyone who can reach this socket can join any room whose code they",
      "   know. Do NOT run this on a machine reachable from the public internet.",
      "",
      "   Recommended: bind to a VPN interface instead (Tailscale, WireGuard,",
      "   ZeroTier) by setting PI_RELAY_HOST to that interface's IP.",
    );
  } else {
    lines.push(
      `⚠  pi-intercom-remote binding to ${config.host}:${config.port} — not loopback or a Tailscale-range IP.`,
      "",
      "   v1 has no per-room authentication. Anyone who can reach this address",
      `   on port ${config.port} can join any room whose code they know.`,
      "",
      "   Make sure this interface is only reachable from machines you trust:",
      "   a VPN tunnel (Tailscale, WireGuard, ZeroTier), a private LAN you",
      "   control, or behind a tunnel with bearer-token auth in front.",
    );
  }
  lines.push("=".repeat(72), "");
  process.stderr.write(lines.join("\n") + "\n");
}

function main(): void {
  const config = loadConfig();
  printExposureWarning(config);
  const log = new ConsoleLogger();
  const rooms = new RoomRegistry();
  const auth = new AllowAllAuthenticator();

  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    maxPayload: config.maxMessageBytes,
  });

  wss.on("listening", () => {
    log.log("info", "relay.listening", { host: config.host, port: config.port });
  });

  wss.on("connection", (ws, req) => {
    const conn = new Connection(ws, rooms, auth, log);
    log.log("debug", "session.opened", {
      sessionId: conn.sessionId,
      remote: req.socket.remoteAddress,
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      void conn.handle(text);
    });

    ws.on("close", () => conn.onClose());
    ws.on("error", (err) => {
      log.log("warn", "session.ws_error", {
        sessionId: conn.sessionId,
        error: err.message,
      });
    });
  });

  wss.on("error", (err) => {
    log.log("error", "relay.server_error", { error: err.message });
  });

  const shutdown = (signal: string) => {
    log.log("info", "relay.shutdown", { signal });
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
