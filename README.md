# pi-relay

Cross-machine relay for [pi.dev](https://pi.dev) coding agent sessions. Lets two pi agents on different computers join a shared room and exchange messages using the same `send` / `ask` / `reply` tool surface as [pi-intercom](https://github.com/nicobailon/pi-intercom).

Where pi-intercom is a local broker (Unix socket / named pipe) for same-machine sessions, pi-relay is a small WebSocket server you run on any machine reachable by both agents.

## Status

Early — v1 in progress.

## Architecture

```
┌──────────────┐         ┌─────────────────┐         ┌──────────────┐
│  pi agent A  │ ──ws──▶ │   relay server  │ ◀──ws── │  pi agent B  │
│  (machine 1) │ ◀─ws──  │ (room registry) │  ──ws─▶ │  (machine 2) │
└──────────────┘         └─────────────────┘         └──────────────┘
```

- **`relay/`** — WebSocket server, in-memory `roomId → Set<connection>` map, stateless routing. Pluggable auth and logger.
- **`client/`** — pi-intercom's intercom tool surface (`send` / `ask` / `reply` / `list` / `pending` / `status`) over a WebSocket transport. Adds `/intercom new` and `/intercom join <code>` commands.
- **`shared/`** — wire protocol types reused by both ends.

## v1 scope

- Room-code pairing (`/intercom new` → `ABC-123`, `/intercom join ABC-123`)
- Stateless routing — messages dropped if the peer is offline, same semantics as local pi-intercom
- Pluggable auth (default: room code only)
- Pluggable logger
- Binds to `127.0.0.1` by default; set `PI_RELAY_HOST` to expose on a specific interface (e.g. a Tailscale IP)

Deferred to later versions: end-to-end encryption, bearer-token auth, store-and-forward queue, hosted deploys.

## Relation to pi-intercom

pi-relay re-implements the intercom tool surface and protocol design for a WebSocket transport. It does not vendor pi-intercom source. License attribution lives in `NOTICE.md`.

## License

MIT — see `LICENSE`.
