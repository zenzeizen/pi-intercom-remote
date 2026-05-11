# pi-intercom-remote

A [pi.dev](https://pi.dev) extension that lets two pi coding-agent sessions on **different machines** join a shared room and exchange messages using the same `send` / `ask` / `reply` tool surface as [pi-intercom](https://github.com/nicobailon/pi-intercom).

Where pi-intercom is a local broker (Unix socket / named pipe) for same-machine sessions, **pi-intercom-remote** is a thin WebSocket client that talks to a small relay server you run on any machine reachable by both agents — your laptop on a LAN, a Tailscale node, or a small VM.

## Install

From a local checkout of the pi-intercom-remote repository:

```sh
pi -e /path/to/pi-intercom-remote/client
```

When published to npm:

```sh
pi install npm:pi-intercom-remote
```

Either install path produces the same extension. You also need a running relay — see *Running a relay* below. The extension auto-connects to `ws://127.0.0.1:8787` by default; override via `~/.pi/agent/pi-intercom-remote/config.json`.

## Usage

Same tool surface as pi-intercom — a single `intercom` tool with an `action` parameter:

```js
intercom({ action: "list" })                                      // list peers in current room
intercom({ action: "send",  to: "<session-id>", message: "..." }) // fire-and-forget
intercom({ action: "ask",   to: "<session-id>", message: "..." }) // ask + wait for reply
intercom({ action: "reply", message: "..." })                     // reply to the active/single pending ask
intercom({ action: "pending" })                                   // list unresolved inbound asks
intercom({ action: "status" })                                    // connection / room status
```

Room operations (pi-intercom-remote-only — pi-intercom has no rooms):

```js
intercom({ action: "new" })                  // create a fresh room (returns a code like ABC-234)
intercom({ action: "join", to: "ABC-234" })  // join an existing room by code
intercom({ action: "leave" })                // leave the current room
```

User commands and shortcuts:

- `/intercom` — open the session-list overlay (pick a peer, type a message)
- `/intercom new` / `/intercom join <code>` / `/intercom leave` / `/intercom status` / `/intercom list`
- `alt+m` — same as `/intercom`

## How sessions find each other

1. One agent runs `intercom({ action: "new" })` (or `/intercom new`) and receives a short code, e.g. `ABC-234`.
2. The other agent runs `intercom({ action: "join", to: "ABC-234" })`.
3. Both agents are now in the same room. `send` / `ask` / `reply` route via the relay.

## Configuration

`~/.pi/agent/pi-intercom-remote/config.json`:

```json
{
  "relayUrl": "ws://127.0.0.1:8787",
  "enabled": true
}
```

- `relayUrl` — WebSocket URL of your relay server. Defaults to `ws://127.0.0.1:8787`.
- `room` — currently joined room code. Set automatically by `/intercom new` / `/intercom join`.
- `enabled` — set `false` to keep the extension installed but skip auto-connect.
- `displayName` — optional override for the name shown to peers.
- `authCredential` — optional bearer credential sent in the `hello` frame. Reserved for non-default authenticators.

## Running a relay

The relay server is a small WebSocket service (~250 lines of Node + `ws`). Source and build instructions live alongside this extension in the pi-intercom-remote source repository. The default bind is `127.0.0.1` only; set `PI_RELAY_HOST` to a LAN IP, a Tailscale interface, or `0.0.0.0` to make it reachable from other machines.

## Status

v0.1. Wire protocol is versioned and stable across patch releases. Auth is currently transport-level (TLS, VPN, loopback) only; per-room secrets and end-to-end encryption are deferred to a later version.

## Relation to pi-intercom

The tool surface, idle-aware inbound queueing, reply-waiter pattern, UI overlays, and inline message renderer are direct ports of [pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT). What changes is the transport layer — Unix sockets / named pipes become a WebSocket connection to a remote relay. Subagent / supervisor features from pi-intercom are not included.

## License

MIT — see `LICENSE`.
