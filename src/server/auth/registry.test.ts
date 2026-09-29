import { beforeEach, describe, expect, it } from "vitest";
import type { SessionRow, UserRow } from "../interfaces.js";
import { createAuthBoundaries, type AuthConfig } from "./index.js";
import { OidcAuthAdapter } from "./oidc.js";
import { DEFAULT_SESSION_TTL_SECONDS, type SessionStore } from "./sessions.js";

const USER: UserRow = { id: "0d5c7f7e-1c2b-4a5d-8e9f-0a1b2c3d4e5f", displayName: null, createdAt: "2026-09-01T00:00:00.000Z" };

class FakeRepository implements SessionStore {
  private readonly rows = new Map<string, SessionRow>();
  createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): void {
    this.rows.set(input.id, { ...input, revokedAt: null });
  }
  findSessionByTokenHash(tokenHash: string): SessionRow | undefined {
    return [...this.rows.values()].find((row) => row.tokenHash === tokenHash && row.revokedAt === null);
  }
  revokeSession(sessionId: string, userId: string): void {
    const row = this.rows.get(sessionId);
    if (row && row.userId === userId) row.revokedAt = new Date().toISOString();
  }
  getUser(userId: string): UserRow {
    if (userId !== USER.id) throw new Error("not found");
    return USER;
  }
}

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    adapter: "oidc",
    sessionTtlSeconds: undefined,
    desktopRedirectAllowlist: [],
    oidc: { issuer: "https://idp.example.test", clientId: "solaris-desktop", clientSecret: "s3cr3t", scopes: [] },
    ...overrides,
  };
}

describe("auth boundaries", () => {
  let repository: FakeRepository;

  beforeEach(() => {
    repository = new FakeRepository();
  });

  it("composes the OIDC adapter, bearer sessions, transaction store and loopback allowlist", async () => {
    const boundaries = createAuthBoundaries(repository, config({ desktopRedirectAllowlist: ["127.0.0.1", "[::1]", "127.0.0.1"] }));
    expect(boundaries.adapter).toBeInstanceOf(OidcAuthAdapter);
    expect(boundaries.adapter.id).toBe("oidc");
    expect(boundaries.redirectAllowlist).toEqual(["127.0.0.1", "::1"]);

    const session = await boundaries.sessions.issue(USER.id);
    await expect(boundaries.sessions.authenticate(session.token)).resolves.toMatchObject({ user: { id: USER.id } });
    expect(session.expiresAt > new Date().toISOString()).toBe(true);

    const login = boundaries.transactions.begin({ clientState: "s", clientChallenge: "c".repeat(43), redirectUri: "http://127.0.0.1:8765/callback" });
    expect(boundaries.transactions.consumeByUpstreamState(login.upstreamState)?.id).toBe(login.id);
  });

  it("defaults the loopback allowlist to 127.0.0.1 and the scopes to openid", () => {
    const boundaries = createAuthBoundaries(repository, config());
    expect(boundaries.redirectAllowlist).toEqual(["127.0.0.1"]);
  });

  it("uses SOLARIS_SESSION_TTL_SECONDS when set and 30 days otherwise", async () => {
    const session = await createAuthBoundaries(repository, config()).sessions.issue(USER.id);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan((DEFAULT_SESSION_TTL_SECONDS - 60) * 1_000);

    const short = await createAuthBoundaries(repository, config({ sessionTtlSeconds: 600 })).sessions.issue(USER.id);
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThan(601_000);
  });

  it("refuses an unset or unsupported adapter", () => {
    for (const adapter of [undefined, "", "saml", "OIDC"]) {
      expect(() => createAuthBoundaries(repository, config({ adapter })), String(adapter)).toThrow("SOLARIS_AUTH_ADAPTER must be one of oidc");
    }
  });

  it("requires the OIDC configuration only for the oidc adapter", () => {
    for (const [name, oidc] of [
      ["SOLARIS_OIDC_ISSUER", { issuer: undefined }],
      ["SOLARIS_OIDC_CLIENT_ID", { clientId: undefined }],
      ["SOLARIS_OIDC_CLIENT_SECRET", { clientSecret: undefined }],
      ["SOLARIS_OIDC_ISSUER", { issuer: "" }],
    ] as const) {
      const base = config().oidc;
      expect(() => createAuthBoundaries(repository, config({ oidc: { ...base, ...oidc } })), name).toThrow(`${name} is required when SOLARIS_AUTH_ADAPTER=oidc`);
    }
  });

  it("requires the openid scope when scopes are given", () => {
    expect(() => createAuthBoundaries(repository, config({ oidc: { ...config().oidc, scopes: ["profile", "email"] } }))).toThrow('SOLARIS_OIDC_SCOPES must include "openid"');
    expect(() => createAuthBoundaries(repository, config({ oidc: { ...config().oidc, scopes: ["profile"] } }))).toThrow("must include");
  });

  it("refuses a malformed session lifetime", () => {
    for (const sessionTtlSeconds of [0, -1, 1.5]) {
      expect(() => createAuthBoundaries(repository, config({ sessionTtlSeconds })), String(sessionTtlSeconds)).toThrow("SOLARIS_SESSION_TTL_SECONDS must be a positive integer");
    }
  });

  it("refuses a redirect allowlist entry that is not a loopback IP", () => {
    expect(() => createAuthBoundaries(repository, config({ desktopRedirectAllowlist: ["evil.example"] }))).toThrow("loopback IP literals only");
  });
});
