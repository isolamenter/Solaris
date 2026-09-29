import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { OidcAuthAdapter } from "./oidc.js";
import { assertMockDeployment, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_SUBJECT, registerMockOidc } from "./mockOidc.js";

const origin = "http://127.0.0.1:3210";
const callbackUrl = `${origin}/api/auth/callback`;

describe("local mock OIDC", () => {
  it("refuses public origins, public binds and trusted proxies", () => {
    expect(() => assertMockDeployment(origin, "127.0.0.1", 0)).not.toThrow();
    for (const [publicOrigin, bind, proxy] of [["https://solaris.example.com", "127.0.0.1", 0], [origin, "0.0.0.0", 0], [origin, "127.0.0.1", 1]] as const) {
      expect(() => assertMockDeployment(publicOrigin, bind, proxy)).toThrow("loopback");
    }
  });

  it("completes the real OIDC exchange and signature verification, with one-use codes", async () => {
    const app = Fastify();
    await registerMockOidc(app, origin);
    let exchangeBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : String(init.body);
      if (url.pathname.endsWith("/token")) exchangeBody = body ?? "";
      const response = await app.inject({ method: init?.method === "POST" ? "POST" : "GET", url: url.pathname + url.search, headers: Object.fromEntries(new Headers(init?.headers)), payload: body });
      return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
    };
    try {
      const adapter = new OidcAuthAdapter({ issuer: `${origin}/mock-oidc`, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, scopes: ["openid", "profile"], fetch: fetchImpl });
      const transaction = { id: "login-1", state: "upstream-state", expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const start = await adapter.begin({ transaction, callbackUrl });
      const authorization = new URL(start.authorizationUrl);
      const redirect = await app.inject({ url: authorization.pathname + authorization.search });
      expect(redirect.statusCode).toBe(302);
      const callback = new URL(String(redirect.headers.location));
      expect(callback.origin + callback.pathname).toBe(callbackUrl);
      const identity = await adapter.complete({ transaction, callbackUrl, parameters: Object.fromEntries(callback.searchParams) });
      expect(identity).toEqual({ issuer: `${origin}/mock-oidc`, subject: MOCK_SUBJECT, displayName: "Local developer" });
      const replay = await app.inject({ method: "POST", url: "/mock-oidc/token", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString("base64")}` }, payload: exchangeBody });
      expect(replay.statusCode).toBe(400);
      const badRedirect = await app.inject({ url: start.authorizationUrl.replace(encodeURIComponent(callbackUrl), encodeURIComponent("https://evil.example/callback")) });
      expect(badRedirect.statusCode).toBeGreaterThanOrEqual(400);
      expect(badRedirect.headers.location).toBeUndefined();
    } finally { await app.close(); }
  });

  it("burns a code when the PKCE verifier is wrong", async () => {
    const app = Fastify();
    await registerMockOidc(app, origin);
    try {
      const verifier = "v".repeat(43);
      const query = new URLSearchParams({ response_type: "code", client_id: MOCK_CLIENT_ID, redirect_uri: callbackUrl, scope: "openid", nonce: "nonce", state: "state", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
      const start = await app.inject({ url: `/mock-oidc/authorize?${query}` });
      const code = new URL(String(start.headers.location)).searchParams.get("code") ?? "";
      for (const codeVerifier of ["x".repeat(43), verifier]) {
        const response = await app.inject({ method: "POST", url: "/mock-oidc/token", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString("base64")}` }, payload: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl, code_verifier: codeVerifier }).toString() });
        expect(response.statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });
});
