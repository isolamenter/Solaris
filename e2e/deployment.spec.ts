import { expect, test } from "@playwright/test";

/** The same origin `playwright.config.ts` starts the server with. */
const origin = `http://127.0.0.1:${process.env.SOLARIS_E2E_PORT ?? "3210"}`;

/**
 * The deployment boundary against a really running server (CONTRACTS §1, §9).
 *
 * The harness starts the production server through `npm run dev` with a
 * configured `SOLARIS_PUBLIC_ORIGIN` of `http://127.0.0.1:<port>`, and an
 * unroutable OIDC issuer, so nothing here leaves the machine. A full signed-in
 * workflow cannot run in this harness — it needs a real IdP, which is B08's
 * unverified item — so what is proven here is the boundary and the unauthenticated
 * surface.
 */

test("serves the deployment descriptor to the configured host", async ({ request }) => {
  const response = await request.get("/api/deployment");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    name: "Solaris",
    auth: {
      flow: "desktop-code",
      authorizationEndpoint: "/api/auth/desktop/authorize",
      tokenEndpoint: "/api/auth/desktop/token",
    },
  });
});

test("rejects a forged Host with a transport status, not an internal error", async ({ request }) => {
  const response = await request.get("/api/deployment", { headers: { host: "attacker.example" } });
  expect(response.status()).toBe(421);
  expect(await response.json()).toEqual({
    error: { code: "HOST_REJECTED", message: "This Solaris Server does not serve the requested host" },
  });
});

test("rejects a forged Host before routing, including on unknown paths", async ({ request }) => {
  const response = await request.get("/api/definitely-not-a-route", { headers: { host: "attacker.example" } });
  expect(response.status()).toBe(421);
  expect((await response.json()).error.code).toBe("HOST_REJECTED");
});

test("rejects a cross-origin browser request", async ({ request }) => {
  const response = await request.get("/api/deployment", { headers: { origin: "https://attacker.example" } });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: "ORIGIN_REJECTED", message: "This origin is not allowed to call the Solaris API" },
  });
});

test("rejects a malformed Origin rather than treating it as absent", async ({ request }) => {
  const response = await request.get("/api/deployment", { headers: { origin: "null" } });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("ORIGIN_REJECTED");
});

test("accepts the configured host with no Origin, as the desktop client sends it", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect((await response.json()).ok).toBe(true);
});

test("ignores X-Forwarded-For when no proxy is trusted", async ({ request }) => {
  const response = await request.get("/api/health", { headers: { "x-forwarded-for": "203.0.113.7" } });
  expect(response.status()).toBe(200);
  expect((await response.json()).ip).not.toBe("203.0.113.7");
});

test("refuses every account and catalog route without a session", async ({ request }) => {
  const calls = [
    { method: "GET" as const, path: "/api/me" },
    { method: "GET" as const, path: "/api/adapters" },
    { method: "GET" as const, path: "/api/connections" },
    { method: "GET" as const, path: "/api/runs" },
    { method: "DELETE" as const, path: "/api/runs/00000000-0000-4000-8000-000000000000" },
    { method: "POST" as const, path: "/api/auth/logout" },
  ];
  for (const call of calls) {
    const response = await request.fetch(`${origin}${call.path}`, { method: call.method });
    expect(response.status(), `${call.method} ${call.path}`).toBe(401);
    expect((await response.json()).error.code).toBe("AUTH_REQUIRED");
  }
});

test("refuses a bearer token that is not a live session", async ({ request }) => {
  const response = await request.get("/api/me", { headers: { authorization: "Bearer not-a-real-session" } });
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("AUTH_REQUIRED");
});

/**
 * The desktop login flow is B03's module, wired in by the composition. It is
 * reachable and it fails closed: the configured IdP is unroutable here, so the
 * authorize leg cannot produce a redirect. This does not prove a real sign-in.
 */
test("reaches the real desktop login flow, with strict loopback validation", async ({ request }) => {
  const valid = "/api/auth/desktop/authorize?state=client-state&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2Fcallback";
  const unreachableIdp = await request.get(valid, { maxRedirects: 0 });
  expect(unreachableIdp.status()).toBe(400);
  expect((await unreachableIdp.json()).error.code).toBe("AUTH_FLOW_INVALID");

  const publicRedirect = valid.replace(encodeURIComponent("http://127.0.0.1:45678/callback"), encodeURIComponent("https://attacker.example/callback"));
  const rejected = await request.get(publicRedirect, { maxRedirects: 0 });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error.code).toBe("AUTH_FLOW_INVALID");
});
