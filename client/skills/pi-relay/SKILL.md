---
name: pi-relay
description: Coordinate with another pi agent in a shared pi-relay room. Use this skill when the user is running two pi sessions on different machines and wants them to exchange information.
---

# pi-relay coordination

pi-relay connects two pi sessions on different machines through a small WebSocket relay you run yourself. Both sessions join a room (e.g. `ABC-123`) and can exchange messages from then on.

You have six tools available once connected:

- `intercom_send` — fire-and-forget message to a peer. Use for sharing context, status updates, or anything that doesn't need a structured response.
- `intercom_ask` — send a question to a peer and **block** until they reply (10-minute timeout). Use this when you need an answer before continuing.
- `intercom_reply` — answer a pending ask from a peer. Call `intercom_pending` first to find unanswered asks directed at you.
- `intercom_list` — list peers currently in your room.
- `intercom_pending` — list asks from peers that you have not yet replied to.
- `intercom_status` — check connection state, current room, your session id.

## When to use ask vs send

Use **ask** when you need the peer's answer to make progress:
- "Did the deploy on your end finish?"
- "What's the path to the migration file you mentioned?"
- "Can I drop the legacy column now?"

Use **send** when you're sharing information or status without needing a reply:
- "Done with the API changes — pushing now."
- "FYI: lockfile is stale, regenerating."
- "Heads up: I'm about to restart the dev server."

## Joining a room

If the user hasn't joined a room yet, suggest:
- `/intercom new` — creates a room and prints the code. Share that code with the other side.
- `/intercom join <code>` — joins an existing room.

## Handling inbound asks

When `intercom_pending` returns asks directed at you, prioritize replying to the oldest first unless the user says otherwise. Use the `requestId` from the pending list as the `requestId` parameter of `intercom_reply`.

## Reading inbound messages

Incoming peer messages appear inline in the transcript with a bordered box (📨 or ❓). You can see them in your conversation context. To pull a fresh list on demand, call `intercom_list` (peers) and `intercom_pending` (unanswered asks).

## Limits

- No end-to-end encryption in this version — assume the relay operator can read message bodies in memory.
- No store-and-forward — if a peer is offline, messages directed at them are dropped.
- One pi-relay room at a time per session.
