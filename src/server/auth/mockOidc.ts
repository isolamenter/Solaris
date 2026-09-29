import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { AppError } from "../errors.js";
import { isLoopbackAddress } from "./redirect.js";

export const MOCK_SUBJECT = "local-developer";
export const MOCK_CLIENT_ID = "solaris-local";
export const MOCK_CLIENT_SECRET = "solaris-local-mock-secret";

/** An explicit local IdP, used by the real OIDC adapter; never an auth bypass. */
export function assertMockDeployment(publicOrigin: string, bindHost: string, trustProxy: number): void {
  if (!isLoopbackAddress(new URL(publicOrigin).hostname.replace(/^\[|\]$/g, "")) || !isLoopbackAddress(bindHost) || trustProxy !== 0) {
    throw new Error("SOLARIS_MOCK_OIDC requires a loopback public origin, loopback bind and no trusted proxy");
  }
}

export async function registerMockOidc(app: FastifyInstance, publicOrigin: string): Promise<void> {
  const issuer = `${publicOrigin}/mock-oidc`;
  const redirectUri = `${publicOrigin}/api/auth/callback`;
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "local-mock", alg: "RS256", use: "sig" };
  const pending = new Map<string, { nonce: string; challenge: string; expiresAt: number }>();
  const invalid = () => new AppError("AUTH_FLOW_INVALID", "The mock sign-in attempt is invalid", 400);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/mock-oidc/")) reply.header("cache-control", "no-store");
  });
  app.get("/mock-oidc/.well-known/openid-configuration", async () => ({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
  }));
  app.get("/mock-oidc/jwks", async () => ({ keys: [jwk] }));
  app.get("/mock-oidc/authorize", async (request, reply) => {
    const query = z.strictObject({
      response_type: z.literal("code"), client_id: z.literal(MOCK_CLIENT_ID), redirect_uri: z.literal(redirectUri),
      scope: z.string().refine((value) => value.split(" ").includes("openid")),
      code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256"),
      nonce: z.string().min(1).max(200), state: z.string().min(1).max(200),
    }).parse(request.query);
    for (const [code, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(code);
    if (pending.size >= 1000) throw invalid();
    const code = randomBytes(32).toString("base64url");
    pending.set(code, { nonce: query.nonce, challenge: query.code_challenge, expiresAt: Date.now() + 60_000 });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", query.state);
    return reply.redirect(target.toString());
  });
  // The OIDC adapter sends form data. Register its parser only in this scope.
  await app.register(async (tokenApp) => {
    tokenApp.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      const params = new URLSearchParams(String(body));
      const entries = [...params.entries()];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) return done(invalid());
      done(null, Object.fromEntries(entries));
    });
    tokenApp.post("/mock-oidc/token", async (request) => {
      const body = z.strictObject({
        grant_type: z.literal("authorization_code"), code: z.string().min(1).max(200),
        redirect_uri: z.literal(redirectUri), code_verifier: z.string().min(43).max(128),
      }).parse(request.body);
      const item = pending.get(body.code);
      pending.delete(body.code);
      const expected = `Basic ${Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString("base64")}`;
      if (request.headers.authorization !== expected || !item || item.expiresAt <= Date.now() ||
          createHash("sha256").update(body.code_verifier).digest("base64url") !== item.challenge) throw invalid();
      const idToken = await new SignJWT({ nonce: item.nonce, name: "Local developer" })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(MOCK_CLIENT_ID)
        .setSubject(MOCK_SUBJECT).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
      return { id_token: idToken, token_type: "Bearer" };
    });
  });
}
