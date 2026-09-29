import { createHash, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthTransaction } from "../interfaces.js";
import { OidcAuthAdapter } from "./oidc.js";

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "solaris-desktop";
const CLIENT_SECRET = "s3cr3t-client-value";
const CALLBACK = "https://solaris.example.test/api/auth/callback";
const SUBJECT = "external-subject-1";
const KID = "idp-key-1";

const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** The verifier the desktop generated; the adapter must never see or reuse it. */
const DESKTOP_VERIFIER = "desktop-verifier-desktop-verifier-desktop-verifier";

/** Claims a token carries unless the test overrides them; `undefined` drops one. */
type TokenClaims = { nonce?: string; name?: string; iss?: string; aud?: string; sub?: string; exp?: number };

/** A minimal IdP: discovery, a JWKS, and a token endpoint that records requests. */
class FakeIdp {
  readonly tokenRequests: URLSearchParams[] = [];
  readonly authorizationEndpoint = `${ISSUER}/authorize`;
  readonly jwks: { keys: JWK[] } = { keys: [] };
  private readonly jwksUri = `${ISSUER}/jwks.json`;
  private readonly tokenEndpoint = `${ISSUER}/token`;
  /** Test hooks for the token endpoint's answer. */
  tokenStatus = 200;
  tokenOverride: unknown = null;
  discoveryIssuer = ISSUER;

  constructor(private readonly publicKey: CryptoKey, private readonly privateKey: CryptoKey) {}

  async initialize(): Promise<void> {
    this.jwks.keys = [{ ...(await exportJWK(this.publicKey)), kid: KID, alg: "RS256", use: "sig" }];
  }

  /** The payload is written directly, so a test can drop or override any claim. */
  sign(claims: TokenClaims = {}, key?: CryptoKey): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: SUBJECT, iss: ISSUER, aud: CLIENT_ID, exp: now + 300, ...claims } as Record<string, unknown>)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .sign(key ?? this.privateKey);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: this.discoveryIssuer, authorization_endpoint: this.authorizationEndpoint, token_endpoint: this.tokenEndpoint, jwks_uri: this.jwksUri });
    }
    if (url === this.jwksUri) return Response.json(this.jwks);
    if (url === this.tokenEndpoint) {
      this.tokenRequests.push(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      if (this.tokenOverride !== null) {
        return typeof this.tokenOverride === "string" ? new Response(this.tokenOverride, { status: this.tokenStatus }) : Response.json(this.tokenOverride, { status: this.tokenStatus });
      }
      return Response.json({ access_token: "upstream-access", refresh_token: "upstream-refresh", id_token: await this.sign(), token_type: "Bearer" });
    }
    throw new Error(`FakeIdp received an unexpected request: ${url}`);
  };
}

function transaction(overrides: Partial<AuthTransaction> = {}): AuthTransaction {
  return { id: randomUUID(), state: `upstream-state-${randomUUID()}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), ...overrides };
}

describe("OIDC auth adapter", () => {
  let idp: FakeIdp;
  let adapter: OidcAuthAdapter;
  let untrustedKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    idp = new FakeIdp(pair.publicKey, pair.privateKey);
    await idp.initialize();
    adapter = new OidcAuthAdapter({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: ["openid", "profile"], fetch: idp.fetch });
    untrustedKey = other.privateKey;
  });

  beforeEach(() => {
    idp.tokenRequests.length = 0;
    idp.tokenStatus = 200;
    idp.tokenOverride = null;
    idp.discoveryIssuer = ISSUER;
  });

  async function begin(): Promise<{ transaction: AuthTransaction; url: URL }> {
    const current = transaction();
    const { authorizationUrl } = await adapter.begin({ transaction: current, callbackUrl: CALLBACK });
    return { transaction: current, url: new URL(authorizationUrl) };
  }

  /** Starts an attempt and points the token endpoint at one specific id_token. */
  async function startedWithToken(sign: (claims: { nonce: string }) => Promise<string>) {
    const started = await begin();
    const nonce = started.url.searchParams.get("nonce") ?? "";
    idp.tokenOverride = { id_token: await sign({ nonce }) };
    return started;
  }

  function completeWith(started: { transaction: AuthTransaction }) {
    return adapter.complete({ transaction: started.transaction, callbackUrl: CALLBACK, parameters: { code: "authorization-code-1", state: started.transaction.state } });
  }

  describe("begin", () => {
    it("builds the authorization URL with the Server's upstream state, its own PKCE challenge and its own nonce", async () => {
      const { transaction: current, url } = await begin();
      expect(url.origin + url.pathname).toBe(idp.authorizationEndpoint);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
      expect(url.searchParams.get("scope")).toBe("openid profile");
      expect(url.searchParams.get("state")).toBe(current.state);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The Server's own PKCE challenge, never the desktop verifier's.
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("code_challenge")).not.toBe(s256(DESKTOP_VERIFIER));
      // The client secret is a back-channel credential and must never be in a URL.
      expect(url.toString()).not.toContain(CLIENT_SECRET);
    });

    it("uses a fresh PKCE verifier and nonce for every attempt", async () => {
      const first = await begin();
      const second = await begin();
      expect(first.url.searchParams.get("code_challenge")).not.toBe(second.url.searchParams.get("code_challenge"));
      expect(first.url.searchParams.get("nonce")).not.toBe(second.url.searchParams.get("nonce"));
    });

    it("refuses to begin when discovery reports a different issuer", async () => {
      // A fresh adapter, because a working discovery document is cached.
      const mismatched = new OidcAuthAdapter({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: ["openid"], fetch: idp.fetch });
      idp.discoveryIssuer = "https://other-issuer.example.test";
      await expect(mismatched.begin({ transaction: transaction(), callbackUrl: CALLBACK })).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID", statusCode: 400 });
    });

    it("refuses to begin when discovery is unreachable or incomplete", async () => {
      const failed = new OidcAuthAdapter({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: ["openid"], fetch: () => Promise.reject(new Error("ECONNREFUSED")) });
      await expect(failed.begin({ transaction: transaction(), callbackUrl: CALLBACK })).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      const incomplete = new OidcAuthAdapter({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scopes: ["openid"],
        fetch: () => Promise.resolve(Response.json({ issuer: ISSUER })),
      });
      await expect(incomplete.begin({ transaction: transaction(), callbackUrl: CALLBACK })).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });
  });

  describe("complete", () => {
    it("exchanges the code with its own verifier and verifies the id_token", async () => {
      const started = await startedWithToken((claims) => idp.sign(claims));
      const identity = await completeWith(started);
      expect(identity).toEqual({ issuer: ISSUER, subject: SUBJECT });
      expect("displayName" in identity).toBe(false);

      const request = idp.tokenRequests[0];
      expect(request?.get("grant_type")).toBe("authorization_code");
      expect(request?.get("code")).toBe("authorization-code-1");
      expect(request?.get("redirect_uri")).toBe(CALLBACK);
      // The verifier the adapter sends is the one it generated for THIS
      // transaction: it hashes back to the challenge it put in the URL, and it
      // is not the desktop's verifier.
      const verifier = request?.get("code_verifier") ?? "";
      expect(s256(verifier)).toBe(started.url.searchParams.get("code_challenge"));
      expect(verifier).not.toBe(DESKTOP_VERIFIER);
      expect(s256(DESKTOP_VERIFIER)).not.toBe(started.url.searchParams.get("code_challenge"));
    });

    it("carries the display name when the IdP asserts one", async () => {
      const started = await startedWithToken((claims) => idp.sign({ ...claims, name: "Ada Lovelace" }));
      await expect(completeWith(started)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT, displayName: "Ada Lovelace" });
    });

    it("rejects a token signed by a key the IdP does not publish", async () => {
      const started = await startedWithToken((claims) => idp.sign(claims, untrustedKey));
      await expect(completeWith(started)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID", statusCode: 400 });
    });

    it("rejects the wrong issuer and the wrong audience", async () => {
      const wrongIssuer = await startedWithToken((claims) => idp.sign({ ...claims, iss: "https://attacker.example.test" }));
      await expect(completeWith(wrongIssuer)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      const wrongAudience = await startedWithToken((claims) => idp.sign({ ...claims, aud: "another-client" }));
      await expect(completeWith(wrongAudience)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("rejects an expired id_token and one with no expiry at all", async () => {
      const expired = await startedWithToken((claims) => idp.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 120 }));
      await expect(completeWith(expired)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      const undated = await startedWithToken((claims) => idp.sign({ ...claims, exp: undefined }));
      await expect(completeWith(undated)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("rejects a missing or mismatched nonce", async () => {
      const missing = await startedWithToken(() => idp.sign({ nonce: undefined }));
      await expect(completeWith(missing)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      const mismatched = await startedWithToken((claims) => idp.sign({ ...claims, nonce: `${claims.nonce}-other` }));
      await expect(completeWith(mismatched)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("rejects a callback whose state is not the transaction's", async () => {
      const started = await startedWithToken((claims) => idp.sign(claims));
      await expect(
        adapter.complete({ transaction: started.transaction, callbackUrl: CALLBACK, parameters: { code: "authorization-code-1", state: "not-the-upstream-state" } }),
      ).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      // No code was ever exchanged.
      expect(idp.tokenRequests).toHaveLength(0);
    });

    it("rejects an unknown transaction, a replay and an expired transaction", async () => {
      const started = await startedWithToken((claims) => idp.sign(claims));
      await expect(completeWith(started)).resolves.toMatchObject({ subject: SUBJECT });
      // The same transaction can never be completed twice, even with a good token.
      await expect(completeWith(started)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });

      const unknown = transaction();
      await expect(
        adapter.complete({ transaction: unknown, callbackUrl: CALLBACK, parameters: { code: "authorization-code-1", state: unknown.state } }),
      ).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });

      const expired = transaction({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
      await expect(
        adapter.complete({ transaction: expired, callbackUrl: CALLBACK, parameters: { code: "authorization-code-1", state: expired.state } }),
      ).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("discards pending state without touching the IdP", async () => {
      const started = await startedWithToken((claims) => idp.sign(claims));
      adapter.discard(started.transaction.id);
      await expect(completeWith(started)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      expect(idp.tokenRequests).toHaveLength(0);
    });

    it("rejects every unusable token endpoint answer", async () => {
      const answers: unknown[] = [
        { error: "invalid_grant", error_description: "the code was wrong" },
        { id_token: "" },
        { access_token: "only-access" },
        "not-json",
      ];
      for (const answer of answers) {
        idp.tokenOverride = answer;
        const started = await begin();
        await expect(completeWith(started), JSON.stringify(answer)).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
      }
      // A non-200 token response is a failure too, even with a well-formed body.
      idp.tokenStatus = 400;
      idp.tokenOverride = { error: "invalid_grant" };
      await expect(completeWith(await begin())).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("rejects a callback with no code", async () => {
      const started = await begin();
      await expect(
        adapter.complete({ transaction: started.transaction, callbackUrl: CALLBACK, parameters: { state: started.transaction.state } }),
      ).rejects.toMatchObject({ code: "AUTH_FLOW_INVALID" });
    });

    it("never leaks a code, verifier, nonce, token or secret in its errors", async () => {
      const started = await begin();
      idp.tokenOverride = { error: "invalid_grant", error_description: "the code was wrong" };
      let error: Error | null = null;
      try {
        await completeWith(started);
      } catch (thrown) {
        error = thrown as Error;
      }
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("authorization-code-1");
      expect(message).not.toContain(CLIENT_SECRET);
      expect(message).not.toContain("invalid_grant");
      expect(message).not.toContain(started.url.searchParams.get("nonce") ?? "no-nonce");
      expect(message).not.toContain(started.url.searchParams.get("code_challenge") ?? "no-challenge");
    });
  });
});
