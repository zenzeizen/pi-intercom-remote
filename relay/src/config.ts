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
