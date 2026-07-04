# pi-intercom-remote

Cross-machine relay for [pi.dev](https://pi.dev) coding-agent sessions. Two pi sessions — on the same box or on opposite ends of the world — join a shared room and exchange messages using the same `send` / `ask` / `reply` tool surface as [pi-intercom](https://github.com/nicobailon/pi-intercom).

Where pi-intercom is a local broker (Unix socket / named pipe) for same-machine sessions, **pi-intercom-remote** is a small WebSocket server you run yourself plus a thin pi extension that talks to it. The wire protocol is JSON-over-WebSocket; the relay holds no state beyond an in-memory room registry.

```
┌──────────────┐         ┌─────────────────┐         ┌──────────────┐
│  pi agent A  │ ──ws──▶ │   relay server  │ ◀──ws── │  pi agent B  │
│  (machine 1) │ ◀─ws──  │ (room registry) │  ──ws─▶ │  (machine 2) │
└──────────────┘         └─────────────────┘         └──────────────┘
```

## Repo layout

- **`relay/`** — WebSocket server. Pluggable auth + logger.
- **`client/`** — pi extension. Single `intercom` tool with `action` parameter, `/intercom` slash command + `alt+m` shortcut, TUI overlay for picking a peer.
- **`shared/`** — wire protocol types reused by both ends.

The client is a separate workspace package, [`pi-intercom-remote`](./client/README.md). Load it from a local checkout (`pi -e ./client`) or, when published, install via `pi install npm:pi-intercom-remote`.

## Requirements

- Node.js 20+ on the relay host.
- A working pi install ([`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) ≥ 0.74) on every agent machine.
- The relay's WebSocket port reachable from every agent machine (loopback, LAN, or VPN).

## Quick start (same machine, two terminals)

```sh
# In repo root, once:
npm install

# Terminal 1 — start the relay:
npm run dev:relay
# → logs: {"event":"relay.listening","host":"127.0.0.1","port":8787}

# Terminals 2 & 3 — start two pi sessions with the extension:
pi -e ./client
```

In one pi session, run `/intercom new` — it prints a room code (e.g. `ABC-234`). In the other, run `/intercom join ABC-234`. Both sessions can now `send` / `ask` / `reply` from their tool surface, or use `alt+m` for the picker overlay.

### Standing rooms (fixed code, survives restarts)

By default `room.create` generates a random code, and the relay deletes a room the moment it empties out — every session restart means re-pairing with a fresh code. For a permanent 3+-machine room, pass an explicit code instead:

```js
intercom({ action: "new", to: "AMBER-HQ" })   // or: /intercom new AMBER-HQ
```

This is get-or-create: the first caller creates a room with exactly that code; every later caller (even after the room went empty and was garbage-collected) lands back in a room with the identical code. Every peer's `~/.pi/agent/pi-intercom-remote/config.json` should set `"room": "AMBER-HQ"` — on session start the client automatically retries `room.create` with that code if the plain rejoin (`room.join`) fails because the room was GC'd, so the room code never has to be re-shared by hand.

## Two machines on the same network

The relay binds to `127.0.0.1` by default. To accept connections from other machines, point it at a routable interface with `PI_RELAY_HOST`:

```sh
# On the relay host — bind to your LAN IP:
PI_RELAY_HOST=192.168.1.10 npm run dev:relay
```

On each agent machine, install the extension and point its config at the relay:

```sh
pi -e /path/to/pi-intercom-remote/client
```

```json
// ~/.pi/agent/pi-intercom-remote/config.json
{ "relayUrl": "ws://192.168.1.10:8787", "enabled": true }
```

Restart the pi session, then pair with `/intercom new` and `/intercom join <code>`.

The default loopback bind refuses LAN connections on purpose. Use `PI_RELAY_HOST=0.0.0.0` only when you really mean "every interface."

## Two machines over a VPN (e.g. Tailscale)

A VPN is the recommended way to reach a relay across machines you trust. The example uses [Tailscale](https://tailscale.com), but any VPN giving stable per-peer addresses (WireGuard, ZeroTier, Nebula, SSH tunnel) works — all the relay needs is one IP reachable only from machines you trust.

1. **Get both machines on the same tailnet.** Run `tailscale up` on every machine and sign in with the same identity. Find a machine's tailnet IP with `tailscale ip -4` (e.g. `100.64.10.5`).

2. **Bind the relay to the tailnet interface:**

   ```sh
   PI_RELAY_HOST=$(tailscale ip -4) npm run dev:relay
   ```

   Binding to the tailnet IP means the kernel only accepts connections arriving on the Tailscale interface — LAN, café Wi-Fi, and the public internet are refused at the socket layer. The relay detects Tailscale's CGNAT range (`100.64.0.0/10`) and stays quiet; binding to anything else (a LAN IP, a public IP, `0.0.0.0`) prints a warning so you can't accidentally ship an exposed relay.

3. **Point each agent at the relay** by setting `relayUrl` to `ws://100.64.10.5:8787` in `~/.pi/agent/pi-intercom-remote/config.json`, then restart the session. (With MagicDNS, the host's tailnet name works too: `ws://relay-host:8787`.)

4. **Pair the sessions** with `/intercom new` and `/intercom join <code>` — the VPN is just the transport.

To restrict a shared relay further, tighten the tailnet ACL so only tagged devices can reach the relay port:

```json
{ "acls": [{ "action": "accept", "src": ["tag:pi-agents"], "dst": ["tag:pi-intercom-remote:8787"] }] }
```

## Configuration

### Relay

Environment variables, all optional:

| Variable                     | Default     | Meaning                                            |
| ---------------------------- | ----------- | -------------------------------------------------- |
| `PI_RELAY_HOST`              | `127.0.0.1` | Interface to bind. Use a LAN/VPN IP, or `0.0.0.0`. |
| `PI_RELAY_PORT`              | `8787`      | TCP port.                                          |
| `PI_RELAY_MAX_MESSAGE_BYTES` | `65536`     | Max bytes per WebSocket frame.                     |
| `PI_RELAY_HEARTBEAT_MS`      | `30000`     | Idle interval for ping; `0` disables.              |

### Client

`~/.pi/agent/pi-intercom-remote/config.json`:

```json
{ "relayUrl": "ws://127.0.0.1:8787", "enabled": true }
```

- `relayUrl` — WebSocket URL of the relay.
- `room` — currently joined room code. Set automatically by `/intercom new` / `/intercom join`.
- `enabled` — set `false` to keep the extension installed but skip auto-connect.
- `displayName` — optional override for the name shown to peers.
- `authCredential` — optional bearer credential sent in the `hello` frame. Reserved for non-default authenticators.

## Trust model

v1. Wire protocol is versioned (`PROTOCOL_VERSION = 1`) and stable across patch releases.

- **Who can connect:** anyone reachable on the relay's bind address with a valid room code. There's no per-connection or per-room auth in v1 — gate it with a VPN, a private LAN, or by replacing `AllowAllAuthenticator` in `relay/src/auth.ts` with one that checks `hello.auth.credential`.
- **What the relay sees:** the relay reads every message body in plaintext to route it — code, prompts, replies, attachments. This is *not* fixed by auth. Run the relay on a host you trust with that content (typically your own machine); don't use a relay run by someone you don't trust.
- **What gets persisted:** nothing. The relay is fully in-memory — no message logs, no on-disk room registry, no replay queue.

## Development

```sh
npm install
npm run typecheck             # all workspaces
npm run dev:relay             # relay on 127.0.0.1:8787, hot-reload via tsx
npm run smoke --workspace=@pi-intercom-remote/relay   # end-to-end protocol smoke test
```

Load the client into a pi session for development with `pi -e ./client`.
