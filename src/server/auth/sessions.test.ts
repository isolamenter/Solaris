import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionRow, UserRow } from "../interfaces.js";
import { BearerSessionService, DEFAULT_SESSION_TTL_SECONDS, sessionTokenHash, type SessionStore } from "./sessions.js";

const USER: UserRow = { id: "6f1c3f7e-1c2b-4a5d-8e9f-0a1b2c3d4e5f", displayName: "Ada", createdAt: "2026-09-01T00:00:00.000Z" };

/** An in-memory stand-in for the frozen repository session methods. */
class FakeSessions implements SessionStore {
  readonly rows = new Map<string, SessionRow>();
  createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): void {
    this.rows.set(input.id, { ...input, revokedAt: null });
  }
  findSessionByTokenHash(tokenHash: string): SessionRow | undefined {
    return [...this.rows.values()].find((row) => row.tokenHash === tokenHash && row.revokedAt === null);
  }
  revokeSession(sessionId: string, userId: string): void {
    const row = this.rows.get(sessionId);
    if (row && row.userId === userId && row.revokedAt === null) row.revokedAt = new Date().toISOString();
  }
  getUser(userId: string): UserRow {
    if (userId !== USER.id) throw new Error("not found");
    return USER;
  }
}

describe("bearer sessions", () => {
  let repository: FakeSessions;
  let now: number;
  let sessions: BearerSessionService;

  beforeEach(() => {
    repository = new FakeSessions();
    now = Date.parse("2026-09-29T10:00:00.000Z");
    sessions = new BearerSessionService(repository, 3_600, () => now);
  });

  it("issues an opaque token and persists only its hash", async () => {
    const session = await sessions.issue(USER.id);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toBe(new Date(now + 3_600_000).toISOString());
    expect(session.user).toEqual({ id: USER.id, displayName: "Ada", createdAt: USER.createdAt });

    const stored = [...repository.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(createHash("sha256").update(session.token).digest("hex"));
    expect(stored[0]?.tokenHash).not.toBe(session.token);
    expect(JSON.stringify(stored)).not.toContain(session.token);
  });

  it("returns a SessionDto with no refresh token and no extra fields", async () => {
    const session = await sessions.issue(USER.id);
    expect(Object.keys(session).sort()).toEqual(["expiresAt", "token", "user"]);
  });

  it("issues a distinct token per session", async () => {
    const first = await sessions.issue(USER.id);
    const second = await sessions.issue(USER.id);
    expect(first.token).not.toBe(second.token);
    expect(repository.rows.size).toBe(2);
  });

  it("authenticates by hash and reports the session and user", async () => {
    const session = await sessions.issue(USER.id);
    const authenticated = await sessions.authenticate(session.token);
    expect(authenticated.user).toEqual(session.user);
    expect([...repository.rows.keys()]).toContain(authenticated.sessionId);
  });

  it("rejects an unknown, empty or tampered token with AUTH_REQUIRED", async () => {
    const session = await sessions.issue(USER.id);
    for (const token of ["", "not-a-token", `${session.token}x`, sessionTokenHash(session.token)]) {
      await expect(sessions.authenticate(token), token).rejects.toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });
    }
  });

  it("rejects an expired session with AUTH_REQUIRED", async () => {
    const session = await sessions.issue(USER.id);
    now += 3_600_000;
    await expect(sessions.authenticate(session.token)).rejects.toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });
  });

  it("revokes the current session and leaves other sessions alone", async () => {
    const session = await sessions.issue(USER.id);
    const other = await sessions.issue(USER.id);
    const authenticated = await sessions.authenticate(session.token);
    await sessions.revoke(authenticated.sessionId, USER.id);
    await expect(sessions.authenticate(session.token)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(sessions.authenticate(other.token)).resolves.toMatchObject({ user: { id: USER.id } });
  });

  it("cannot revoke another user's session", async () => {
    const session = await sessions.issue(USER.id);
    const authenticated = await sessions.authenticate(session.token);
    await sessions.revoke(authenticated.sessionId, randomUUID());
    await expect(sessions.authenticate(session.token)).resolves.toMatchObject({ user: { id: USER.id } });
  });

  it("defaults to a 30-day lifetime", () => {
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
