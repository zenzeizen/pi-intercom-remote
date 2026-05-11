import type { SessionInfo, SessionId, RoomCode } from "@pi-intercom-remote/shared";
import { generateRoomCode } from "./codes.js";
import type { Connection } from "./connection.js";

/**
 * In-memory room registry. Two indexes:
 *  - code → Room (for room.join)
 *  - sessionId → Room (for routing peer.send/ask/reply without scanning)
 *
 * Stateless: when a connection drops, we remove it from the room and notify
 * remaining peers. We do not buffer messages for offline sessions — that's
 * a v2 store-and-forward concern.
 */

export interface Room {
  code: RoomCode;
  members: Map<SessionId, Connection>;
}

export class RoomRegistry {
  private readonly byCode = new Map<RoomCode, Room>();
  private readonly bySession = new Map<SessionId, Room>();

  /** Create a fresh room and put `conn` in it. Returns the new room. */
  createRoom(conn: Connection): Room {
    // Retry on the astronomically unlikely collision.
    let code: RoomCode;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
      if (attempts > 16) throw new Error("room code generation: exhausted retries");
    } while (this.byCode.has(code));

    const room: Room = { code, members: new Map([[conn.sessionId, conn]]) };
    this.byCode.set(code, room);
    this.bySession.set(conn.sessionId, room);
    return room;
  }

  /** Look up a room by code. */
  findByCode(code: RoomCode): Room | undefined {
    return this.byCode.get(code);
  }

  /** Look up the room a session is in, if any. */
  findBySession(sessionId: SessionId): Room | undefined {
    return this.bySession.get(sessionId);
  }

  /** Add a connection to an existing room. Caller must ensure not already in a room. */
  addToRoom(room: Room, conn: Connection): void {
    room.members.set(conn.sessionId, conn);
    this.bySession.set(conn.sessionId, room);
  }

  /**
   * Remove a session from its room. If the room is empty afterwards, the
   * room is deleted and its code released for re-use.
   */
  removeSession(sessionId: SessionId): Room | undefined {
    const room = this.bySession.get(sessionId);
    if (!room) return undefined;
    room.members.delete(sessionId);
    this.bySession.delete(sessionId);
    if (room.members.size === 0) {
      this.byCode.delete(room.code);
    }
    return room;
  }

  /** Snapshot of peers in a room as protocol-shaped SessionInfo. */
  peerInfos(room: Room): SessionInfo[] {
    return [...room.members.values()].map((c) => c.info);
  }

  /** For tests and diagnostics. */
  get size(): { rooms: number; sessions: number } {
    return { rooms: this.byCode.size, sessions: this.bySession.size };
  }
}
