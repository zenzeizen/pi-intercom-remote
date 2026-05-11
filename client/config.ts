/**
 * Persistent client config: which relay to connect to, and which room (if any)
 * the user has joined. Stored at ~/.pi/agent/pi-relay/config.json — mirrors
 * pi-intercom's ~/.pi/agent/intercom/config.json convention.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface RelayConfig {
  /** WebSocket URL of the relay. */
  relayUrl: string;
  /** Currently joined room code, if any. */
  room?: string;
  /** Optional auth credential to send in `hello.auth.credential`. */
  authCredential?: string;
  /** Display name override (defaults to pi session name). */
  displayName?: string;
  /** Set to false to disable auto-connect on session start. */
  enabled?: boolean;
}

const DEFAULTS: RelayConfig = {
  relayUrl: "ws://127.0.0.1:8787",
  enabled: true,
};

export function configDir(): string {
  return path.join(homedir(), ".pi", "agent", "pi-relay");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<RelayConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULTS };
    }
    throw err;
  }
}

export async function saveConfig(config: RelayConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function updateConfig(patch: Partial<RelayConfig>): Promise<RelayConfig> {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await saveConfig(next);
  return next;
}
