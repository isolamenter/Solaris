import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SessionDto, UserDto } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import type { Repository, SessionService, UserRow } from "../interfaces.js";

/**
 * CONTRACTS §13: `SOLARIS_SESSION_TTL_SECONDS` is B03's key and may be absent.
 * This is B03's candidate value for a desktop app with no refresh token: it is
 * what B08 validates and writes back into the public configuration.
 */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The repository methods session handling needs; the token hash is the lookup key. */
export type SessionStore = Pick<Repository, "createSession" | "findSessionByTokenHash" | "revokeSession" | "getUser">;

/**
 * Only the hash is stored. The bearer token is returned to the client exactly
 * once, at issue time, and never persisted or logged — `SessionRow.tokenHash` is
 * the only trace of it on the server.
 */
export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function authRequired(): AppError {
  return new AppError("AUTH_REQUIRED", "A valid session is required", 401);
}

/**
 * Opaque bearer sessions (CONTRACTS §2.1/§2.2).
 *
 * No refresh tokens: an expired or revoked session is `401 AUTH_REQUIRED` and
 * the client signs in again. Upstream IdP tokens never reach this class — they
 * are consumed by the auth adapter during login verification and dropped.
 */
export class BearerSessionService implements SessionService {
  constructor(
    private readonly repository: SessionStore,
    private readonly ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
    private readonly clock: () => number = Date.now,
  ) {}

  async issue(userId: string): Promise<SessionDto> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock() + this.ttlSeconds * 1_000).toISOString();
    this.repository.createSession({ id: randomUUID(), userId, tokenHash: sessionTokenHash(token), expiresAt });
    return { token, expiresAt, user: toUserDto(this.repository.getUser(userId)) };
  }

  async authenticate(token: string): Promise<{ sessionId: string; user: UserDto }> {
    const row = this.repository.findSessionByTokenHash(sessionTokenHash(token));
    // Unknown, revoked, expired and empty tokens are indistinguishable to the
    // caller: all of them are simply "no session".
    if (!row) throw authRequired();
    if (!(Date.parse(row.expiresAt) > this.clock())) throw authRequired();
    return { sessionId: row.id, user: toUserDto(this.repository.getUser(row.userId)) };
  }

  async revoke(sessionId: string, userId: string): Promise<void> {
    // The repository scopes the update by user, so a session id from another
    // account cannot be revoked by this caller.
    this.repository.revokeSession(sessionId, userId);
  }
}

/** Explicit field picking: a Row is never spread into a public DTO. */
function toUserDto(row: UserRow): UserDto {
  return { id: row.id, displayName: row.displayName, createdAt: row.createdAt };
}
