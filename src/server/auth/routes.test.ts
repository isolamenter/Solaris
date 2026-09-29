import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { SessionDto, UserDto } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import type { AuthAdapter, AuthTransaction, ExternalIdentity, SessionRow, UserRow } from "../interfaces.js";
import { parseRedirectAllowlist } from "./redirect.js";
import { registerAuthRoutes, type AuthRouteDependencies, type UserDirectory } from "./routes.js";
import { BearerSessionService, type SessionStore } from "./sessions.js";
import { InMemoryAuthTransactionStore } from "./transactions.js";
import { buildAuthorizationUrl } from "../../client/local/pkce.js";

const CALLBACK_URL = "https://solaris.example.test/api/auth/callback";
const REDIRECT_URI = "http://127.0.0.1:8765/callback";
const CLIENT_STATE = "client-state-abc";
const EXTERNAL = { issuer: "https://idp.example.test", subject: "subject-1" };

/** A verifier the desktop holds and never sends until the token exchange. */
const VERIFIER = "verifier-verifier-verifier-verifier-verifier-1";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

class FakeSessions implements SessionStore {
  readonly rows = new Map<string, SessionRow>();
  readonly users = new Map<string, UserRow>();
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
    const user = this.users.get(userId);
    if (!user) throw new Error(`No user ${userId}`);
    return user;
  }
}

class FakeUsers implements UserDirectory {
  readonly created: UserRow[] = [];
  /** Identity is (issuer, subject) only, exactly like the repository's lookup. */
  private readonly identities = new Map<string, UserRow>();
  constructor(existing: UserRow | null, private readonly onCreated: (user: UserRow) => void) {
    if (existing) this.identities.set(`${EXTERNAL.issuer}|${EXTERNAL.subject}`, existing);
  }
  findUserByExternalIdentity(issuer: string, subject: string): UserRow | undefined {
    return this.identities.get(`${issuer}|${subject}`);
  }
  createUserWithIdentity(input: { issuer: string; subject: string; displayName?: string }): UserRow {
    const user: UserRow = { id: randomUUID(), displayName: input.displayName ?? null, createdAt: new Date().toISOString() };
    this.identities.set(`${input.issuer}|${input.subject}`, user);
    this.created.push(user);
    this.onCreated(user);
    return user;
  }
}

/** Stands in for the OIDC boundary; the real adapter is covered in oidc.test.ts. */
class FakeAdapter implements AuthAdapter {
  readonly id = "oidc" as const;
  readonly transactions: AuthTransaction[] = [];
  identity: ExternalIdentity = EXTERNAL;
  failure: Error | null = null;
  async begin(input: { transaction: AuthTransaction }): Promise<{ authorizationUrl: string }> {
    this.transactions.push(input.transaction);
    return { authorizationUrl: `https://idp.example.test/authorize?state=${input.transaction.state}` };
  }
  async complete(): Promise<ExternalIdentity> {
    if (this.failure) throw this.failure;
    return this.identity;
  }
  discard(): void {}
}

function authError(message: string): AppError {
  return new AppError("AUTH_FLOW_INVALID", message, 400);
}

describe("desktop login routes", () => {
  let app: FastifyInstance;
  let adapter: FakeAdapter;
  let sessions: FakeSessions;
  let transactions: InMemoryAuthTransactionStore;
  let users: FakeUsers;
  const existingUser: UserRow = { id: randomUUID(), displayName: "Ada", createdAt: "2026-09-01T00:00:00.000Z" };

  async function build(existing: UserRow | null = existingUser) {
    adapter = new FakeAdapter();
    sessions = new FakeSessions();
    if (existing) sessions.users.set(existing.id, existing);
    users = new FakeUsers(existing, (user) => sessions.users.set(user.id, user));
    transactions = new InMemoryAuthTransactionStore();
    app = Fastify({ logger: false });
    // The canonical envelope of CONTRACTS §9, as `http/app.ts` produces it.
    // This module only ever throws `AppError`, and the test asserts the code and
    // status of what it throws rather than a 500 from an unhandled error.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: { code: "VALIDATION", message: "Request validation failed" } });
      const safe = error instanceof AppError ? error : new AppError("INTERNAL", "Unexpected server error", 500);
      reply.status(safe.statusCode).send({ error: { code: safe.code, message: safe.message } });
    });
    const dependencies: AuthRouteDependencies = {
      adapter,
      transactions,
      sessions: new BearerSessionService(sessions, 3_600),
      users,
      redirectAllowlist: parseRedirectAllowlist(["127.0.0.1"]),
      callbackUrl: CALLBACK_URL,
    };
    registerAuthRoutes(app, dependencies);
    await app.ready();
  }

  beforeEach(() => build());
  afterEach(async () => app.close());

  const authorize = (redirectUri = REDIRECT_URI) =>
    app.inject({ method: "GET", url: buildAuthorizationUrl({
      authorizationEndpoint: "https://solaris.example.test/api/auth/desktop/authorize",
      state: CLIENT_STATE,
      redirectUri,
      codeChallenge: CHALLENGE,
    }) });

  const callback = (state: string, code = "idp-code-1") =>
    app.inject({ method: "GET", url: `/api/auth/callback?code=${code}&state=${encodeURIComponent(state)}` });

  const token = (code: string, verifier = VERIFIER) => app.inject({ method: "POST", url: "/api/auth/desktop/token", payload: { code, code_verifier: verifier } });

  describe("GET /api/auth/desktop/authorize", () => {
    it("requires code response type and refuses other flows", async () => {
      for (const responseType of [null, "token"]) {
        const url = new URL(buildAuthorizationUrl({
          authorizationEndpoint: "https://solaris.example.test/api/auth/desktop/authorize",
          state: CLIENT_STATE, redirectUri: REDIRECT_URI, codeChallenge: CHALLENGE,
        }));
        if (responseType === null) url.searchParams.delete("response_type");
        else url.searchParams.set("response_type", responseType);
        const response = await app.inject({ method: "GET", url: url.toString() });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("VALIDATION");
      }
      expect(adapter.transactions).toHaveLength(0);
    });

    it("redirects to the IdP and opens a login transaction bound to the client state, challenge and redirect URI", async () => {
      const response = await authorize();
      expect(response.statusCode).toBe(302);
      expect(response.headers["cache-control"]).toBe("no-store");
      const transaction = adapter.transactions[0];
      expect(response.headers.location).toBe(`https://idp.example.test/authorize?state=${transaction?.state}`);
      expect(transaction?.id).toBeTruthy();
      // The transaction consumed by the store is the one the adapter was given.
      expect(transactions.consumeByUpstreamState(transaction?.state ?? "")?.clientState).toBe(CLIENT_STATE);
    });

    it("rejects a redirect that is not the exact registered loopback callback", async () => {
      for (const candidate of ["http://localhost:8765/callback", "https://127.0.0.1:8765/callback", "http://127.0.0.1:8765/callback?x=1", "http://evil.example:8765/callback"]) {
        const response = await authorize(candidate);
        expect(response.statusCode, candidate).toBe(400);
        expect(response.json().error.code, candidate).toBe("AUTH_FLOW_INVALID");
      }
      expect(adapter.transactions).toHaveLength(0);
    });

    it("rejects a request that is not S256 or lacks a parameter", async () => {
      const plain = await app.inject({ method: "GET", url: `/api/auth/desktop/authorize?response_type=code&state=${CLIENT_STATE}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${CHALLENGE}&code_challenge_method=plain` });
      expect(plain.statusCode).toBe(400);
      expect(plain.json().error.code).toBe("VALIDATION");
      const missing = await app.inject({ method: "GET", url: "/api/auth/desktop/authorize?response_type=code&state=x" });
      expect(missing.statusCode).toBe(400);
      const extra = await app.inject({ method: "GET", url: `/api/auth/desktop/authorize?response_type=code&state=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&prompt=consent` });
      // A strict schema: an unknown parameter is a format failure, not an instruction.
      expect(extra.statusCode).toBe(400);
      expect(adapter.transactions).toHaveLength(0);
    });

    it("discards the transaction when the adapter cannot start", async () => {
      adapter.begin = () => Promise.reject(authError("The sign-in attempt could not be verified"));
      const response = await authorize();
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
      expect(adapter.transactions).toHaveLength(0);
    });
  });

  describe("GET /api/auth/callback", () => {
    async function startLogin(): Promise<string> {
      await authorize();
      return adapter.transactions.at(-1)?.state ?? "";
    }

    it("redirects to the stored loopback URI with a one-time code and the client state, and never a session token", async () => {
      const upstreamState = await startLogin();
      const response = await callback(upstreamState);
      expect(response.statusCode).toBe(302);
      expect(response.headers["cache-control"]).toBe("no-store");
      const location = new URL(response.headers.location ?? "");
      expect(location.origin).toBe("http://127.0.0.1:8765");
      expect(location.pathname).toBe("/callback");
      expect(location.searchParams.get("state")).toBe(CLIENT_STATE);
      expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // No session was issued and nothing session-shaped is in the URL.
      expect(sessions.rows.size).toBe(0);
      expect(location.searchParams.get("token")).toBeNull();
      expect(location.searchParams.get("access_token")).toBeNull();
    });

    it("maps an existing (issuer, subject) to the same user and creates an unknown one", async () => {
      let upstreamState = await startLogin();
      const first = await callback(upstreamState);
      const code = new URL(first.headers.location ?? "").searchParams.get("code") ?? "";
      const session = (await token(code)).json() as SessionDto;
      expect(session.user).toEqual({ id: existingUser.id, displayName: "Ada", createdAt: existingUser.createdAt });
      expect(users.created).toHaveLength(0);

      // A different subject is a different Solaris user.
      upstreamState = await startLogin();
      adapter.identity = { ...EXTERNAL, subject: "subject-2" };
      await callback(upstreamState);
      expect(users.created).toHaveLength(1);
      expect(users.created[0]?.displayName).toBeNull();
    });

    it("rejects an unknown, replayed or spent state without issuing a code", async () => {
      const upstreamState = await startLogin();
      expect((await callback("never-issued")).json().error.code).toBe("AUTH_FLOW_INVALID");
      expect((await callback(upstreamState)).statusCode).toBe(302);
      // Replay: the transaction is gone, so no second code is handed out.
      const replay = await callback(upstreamState);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error.code).toBe("AUTH_FLOW_INVALID");
    });

    it("issues no code when the adapter cannot verify the callback", async () => {
      const upstreamState = await startLogin();
      adapter.failure = authError("The sign-in attempt could not be verified");
      const response = await callback(upstreamState);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
      expect(sessions.rows.size).toBe(0);
    });

    it("rejects a malformed callback", async () => {
      const missingCode = await app.inject({ method: "GET", url: "/api/auth/callback?state=x" });
      expect(missingCode.statusCode).toBe(400);
      const extra = await app.inject({ method: "GET", url: "/api/auth/callback?code=c&state=x&error=access_denied" });
      expect(extra.statusCode).toBe(400);
      expect(extra.json().error.code).toBe("VALIDATION");
      expect(sessions.rows.size).toBe(0);
    });
  });

  describe("POST /api/auth/desktop/token", () => {
    async function issueCode(): Promise<string> {
      await authorize();
      const response = await callback(adapter.transactions.at(-1)?.state ?? "");
      return new URL(response.headers.location ?? "").searchParams.get("code") ?? "";
    }

    it("exchanges code + verifier for a session that authenticates", async () => {
      const code = await issueCode();
      const response = await token(code);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const session = response.json() as SessionDto;
      expect(Object.keys(session).sort()).toEqual(["expiresAt", "token", "user"]);
      expect(session.user.id).toBe(existingUser.id);
      // Only the hash reached storage.
      expect(JSON.stringify([...sessions.rows.values()])).not.toContain(session.token);
      await expect(new BearerSessionService(sessions).authenticate(session.token)).resolves.toMatchObject({ user: { id: existingUser.id } });
    });

    it("rejects a verifier that does not match the challenge, and burns the code", async () => {
      const code = await issueCode();
      const wrong = await token(code, "another-verifier-another-verifier-another-verifier");
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe("AUTH_FLOW_INVALID");
      // Single use: the failed attempt consumed it.
      expect((await token(code)).statusCode).toBe(400);
      expect(sessions.rows.size).toBe(0);
    });

    it("rejects an unknown or already exchanged code", async () => {
      expect((await token("never-issued")).json().error.code).toBe("AUTH_FLOW_INVALID");
      const code = await issueCode();
      expect((await token(code)).statusCode).toBe(200);
      expect((await token(code)).statusCode).toBe(400);
      expect(sessions.rows.size).toBe(1);
    });

    it("rejects a body that is not exactly code + code_verifier", async () => {
      const code = await issueCode();
      for (const payload of [{ code, code_verifier: VERIFIER, redirect_uri: REDIRECT_URI }, { code, code_verifier: "short" }, { code_verifier: VERIFIER }]) {
        const response = await app.inject({ method: "POST", url: "/api/auth/desktop/token", payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(sessions.rows.size).toBe(0);
    });
  });

  it("issues a session for a user whose stored display name is absent", async () => {
    const code = await (async () => {
      await authorize();
      const response = await callback(adapter.transactions.at(-1)?.state ?? "");
      return new URL(response.headers.location ?? "").searchParams.get("code") ?? "";
    })();
    const session = (await token(code)).json() as SessionDto;
    const user: UserDto = session.user;
    expect(user.id).toBe(existingUser.id);
    expect(user.createdAt).toBe(existingUser.createdAt);
  });
});
