---
name: pi-intercom-remote
description: Coordinate with another pi agent in a shared pi-intercom-remote room. Use this skill when the user is running two pi sessions on different machines (or in two terminals) and wants them to exchange information.
---

# pi-intercom-remote coordination

pi-intercom-remote connects two pi sessions through a small WebSocket relay. Both sessions join a room (e.g. `ABC-234`) and exchange messages from then on.

There is one tool, `intercom`, with an `action` parameter:

- `intercom({ action: "list" })` — list peers in the current room.
- `intercom({ action: "send", to: "<session-id>", message: "..." })` — fire-and-forget message to a peer. Use for status updates, hand-offs, anything that doesn't need a structured response.
- `intercom({ action: "ask",  to: "<session-id>", message: "..." })` — send a question and **block** until the peer replies (10-minute timeout). Use when you need an answer before continuing.
- `intercom({ action: "reply", message: "..." })` — answer the active or single pending ask directed at you. Pass `to: "<sender>"` only to disambiguate when multiple are pending.
- `intercom({ action: "pending" })` — list asks from peers that you have not yet replied to.
- `intercom({ action: "status" })` — connection state, current room, your session id.

Room operations:

- `intercom({ action: "new" })` — create a fresh room; returns a code like `ABC-234`.
- `intercom({ action: "join", to: "ABC-234" })` — join an existing room by code.
- `intercom({ action: "leave" })` — leave the current room.

## When to use ask vs send

Use **ask** when you need the peer's answer to make progress:
- "Did the deploy on your end finish?"
- "What's the path to the migration file you mentioned?"
- "Can I drop the legacy column now?"

Use **send** when you're sharing information or status without needing a reply:
- "Done with the API changes — pushing now."
- "FYI: lockfile is stale, regenerating."
- "Heads up: I'm about to restart the dev server."

## Identifying peers

Always call `intercom({ action: "list" })` first to get session ids. Names may collide (two pi sessions on the same host often share a hostname-based default name), but session ids are always unique. Pass the full `id:` field from the listing as `to`. A unique 6+ character id prefix also works.

## Joining a room

If the user hasn't joined a room yet, suggest the slash commands:
- `/intercom new` — creates a room and prints the code. Share that code with the other side.
- `/intercom join <code>` — joins an existing room.

## Handling inbound asks

When `intercom({ action: "pending" })` returns asks directed at you, prioritize replying to the oldest first unless the user says otherwise. `intercom({ action: "reply", message: "..." })` targets the active turn's ask (or the single pending one) automatically — pass `to: "<sender id or name>"` only when multiple are pending and you need to disambiguate.

## Reading inbound messages

Incoming peer messages appear inline in the transcript with a bordered box (📨). They are already in your context — you don't need to call a tool to re-read them. Use `intercom({ action: "list" })` to refresh the peer list and `intercom({ action: "pending" })` to refresh unanswered asks on demand.

## Limits

- No end-to-end encryption in this version — assume the relay operator can read message bodies in memory.
- No store-and-forward — if a peer is offline, messages directed at them are dropped.
- One pi-intercom-remote room at a time per session.
