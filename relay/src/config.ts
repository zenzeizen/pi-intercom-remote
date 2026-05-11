/**
 * Runtime config, read from the environment.
 *
 * Bind address defaults to 127.0.0.1 (loopback only) so a misconfigured
 * deployment doesn't accidentally expose the relay on every interface.
 * Set PI_RELAY_HOST to a specific interface (e.g. a Tailscale IP, a private
 * LAN IP, or 0.0.0.0 if you really mean it) to make the relay reachable
 * from other machines.
 */

export interface RelayConfig {
  host: string;
  port: number;
  /** Max bytes in a single inbound WebSocket message. */
  maxMessageBytes: number;
  /** Idle interval after which the relay sends a ping; 0 disables. */
  heartbeatIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    host: env.PI_RELAY_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.PI_RELAY_PORT ?? "8787", 10),
    maxMessageBytes: Number.parseInt(env.PI_RELAY_MAX_MESSAGE_BYTES ?? "65536", 10),
    heartbeatIntervalMs: Number.parseInt(env.PI_RELAY_HEARTBEAT_MS ?? "30000", 10),
  };
}

/**
 * Coarse classification of the bind address for the startup warning.
 *
 *  - `loopback` — 127.0.0.1 / ::1 / localhost. Safe: only this host can reach it.
 *  - `wildcard` — 0.0.0.0 / ::. Listens on every interface, including any public IP.
 *  - `tailscale` — 100.64.0.0/10 (CGNAT). Tailscale's assigned range; safe by
 *    construction since only tailnet peers can reach it.
 *  - `other` — any other specific address (LAN IP, WireGuard tunnel, ZeroTier,
 *    a public IP, etc). We can't tell the difference between a private LAN
 *    address and a less-common VPN tunnel from the IP alone, so this is the
 *    "you tell me" bucket.
 */
export type HostExposure = "loopback" | "wildcard" | "tailscale" | "other";

export function classifyHost(host: string): HostExposure {
  const h = host.toLowerCase();
  if (h === "127.0.0.1" || h === "::1" || h === "localhost") return "loopback";
  if (h === "0.0.0.0" || h === "::") return "wildcard";
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Tailscale CGNAT range: 100.64.0.0 – 100.127.255.255
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
  }
  return "other";
}
