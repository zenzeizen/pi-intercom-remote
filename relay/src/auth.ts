import type { HelloMessage, SessionInfo } from "@pi-intercom-remote/shared";

/**
 * Pluggable auth point. Runs once per connection, right after `hello`.
 *
 * The default v1 implementation (AllowAllAuthenticator) accepts every
 * well-formed hello — access control happens later at room.join via the
 * room code. Operators who need stronger guarantees can implement
 * Authenticator to validate a bearer token or other credential carried
 * in `hello.auth.credential`.
 */
export interface AuthResult {
  ok: boolean;
  /** When ok=true, the identity to attach to the session (often equal to info). */
  identity?: SessionInfo;
  /** When ok=false, a short reason for the error frame. */
  reason?: string;
}

export interface Authenticator {
  authenticate(hello: HelloMessage, sessionId: string): Promise<AuthResult> | AuthResult;
}

export class AllowAllAuthenticator implements Authenticator {
  authenticate(hello: HelloMessage, sessionId: string): AuthResult {
    return {
      ok: true,
      identity: { sessionId, ...hello.info },
    };
  }
}
