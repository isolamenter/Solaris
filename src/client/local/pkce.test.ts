import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl, createLoginAttempt, s256Challenge } from "./pkce.js";

/** RFC 7636 Appendix B fixed vector. */
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("s256Challenge", () => {
  it("matches the RFC 7636 vector", async () => {
    await expect(s256Challenge(RFC_VERIFIER)).resolves.toBe(RFC_CHALLENGE);
  });
});

describe("createLoginAttempt", () => {
  it("derives the challenge from the verifier it returns", async () => {
    const attempt = await createLoginAttempt();
    expect(attempt.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(s256Challenge(attempt.codeVerifier)).resolves.toBe(attempt.codeChallenge);
  });

  it("produces a fresh state and verifier every time", async () => {
    const first = await createLoginAttempt();
    const second = await createLoginAttempt();
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });

  it("refuses a verifier outside the RFC length and alphabet", async () => {
    await expect(createLoginAttempt({ codeVerifier: "too-short" })).rejects.toThrow();
    await expect(createLoginAttempt({ codeVerifier: `${"a".repeat(43)}!` })).rejects.toThrow();
  });
});

describe("buildAuthorizationUrl", () => {
  it("carries the loopback redirect, the challenge and the state", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "http://127.0.0.1:3210/api/auth/desktop/authorize",
        redirectUri: "http://127.0.0.1:53124/callback",
        state: "state-value",
        codeChallenge: RFC_CHALLENGE,
      }),
    );
    expect(url.origin).toBe("http://127.0.0.1:3210");
    expect(url.pathname).toBe("/api/auth/desktop/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53124/callback");
    expect(url.searchParams.get("code_challenge")).toBe(RFC_CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });

  it("keeps parameters the Server already put on the endpoint", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://solaris.example/auth/authorize?tenant=alpha",
        redirectUri: "http://127.0.0.1:53124/callback",
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.searchParams.get("tenant")).toBe("alpha");
    expect(url.searchParams.get("state")).toBe("s");
  });

  it("refuses an endpoint that is not an absolute http(s) URL", () => {
    expect(() =>
      buildAuthorizationUrl({
        authorizationEndpoint: "/api/auth/desktop/authorize",
        redirectUri: "http://127.0.0.1:53124/callback",
        state: "s",
        codeChallenge: "c",
      }),
    ).toThrow();
    expect(() =>
      buildAuthorizationUrl({
        authorizationEndpoint: "javascript:alert(1)",
        redirectUri: "http://127.0.0.1:53124/callback",
        state: "s",
        codeChallenge: "c",
      }),
    ).toThrow();
    expect(() =>
      buildAuthorizationUrl({
        authorizationEndpoint: "https://solaris.example/auth#fragment",
        redirectUri: "http://127.0.0.1:53124/callback",
        state: "s",
        codeChallenge: "c",
      }),
    ).toThrow();
  });

  it("does not leak the verifier", async () => {
    const attempt = await createLoginAttempt();
    const url = buildAuthorizationUrl({
      authorizationEndpoint: "https://solaris.example/auth/authorize",
      redirectUri: "http://127.0.0.1:53124/callback",
      state: attempt.state,
      codeChallenge: attempt.codeChallenge,
    });
    expect(url).not.toContain(attempt.codeVerifier);
  });
});
