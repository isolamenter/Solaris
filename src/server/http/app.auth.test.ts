import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHORIZE_PATH, CALLBACK_PATH, TOKEN_PATH } from "../auth/index.js";
import { createTestDeployment, TEST_CALLBACK_URL, TEST_OIDC_ISSUER, type TestDeployment } from "./testSupport.js";

/**
 * The desktop sign-in flow over HTTP (CONTRACTS §2.3), with a fake IdP.
 *
 * This proves the Server's side of the flow: the loopback redirect rules, the
 * two separate PKCE legs, the single-use authorization code, and that the
 * id_token is *verified* (signature, issuer, audience, expiry, nonce) rather
 * than parsed. It does not prove anything about a real IdP — no test here
 * reaches one, and a real public sign-in has not been run.
 */

const CLIENT_ID = "solaris-test";
const CLIENT_SECRET = "test-client-secret";
const DESKTOP_REDIRECT = "http://127.0.0.1:53421/callback";
const DESKTOP_STATE = "desktop-state-0001";

/** The private key jose signs with; taken from jose so no version type is guessed. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

type IdpState = {
  nonce: string;
  issuer: string;
  audience: string;
  subject: string;
  name: string;
  claimExpiry: number;
  key: SigningKey;
  discoveryStatus: number;
  tokenStatus: number;
};

type FakeIdp = {
  state: IdpState;
  /** What the Server actually sent to the token endpoint. */
  tokenRequests: { authorization: string | undefined; body: string }[];
  fetch: typeof fetch;
};

async function createFakeIdp(): Promise<FakeIdp> {
  const signing = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: "idp-key-1", alg: "RS256", use: "sig" };
  const state: IdpState = {
    nonce: "",
    issuer: TEST_OIDC_ISSUER,
    audience: CLIENT_ID,
    subject: "external-subject-1",
    name: "Ada Lovelace",
    claimExpiry: Math.floor(Date.now() / 1000) + 300,
    key: signing.privateKey,
    discoveryStatus: 200,
    tokenStatus: 200,
  };
  const tokenRequests: FakeIdp["tokenRequests"] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/.well-known/openid-configuration")) {
      if (state.discoveryStatus !== 200) return new Response("nope", { status: state.discoveryStatus });
      return Response.json({
        issuer: state.issuer,
        authorization_endpoint: `${TEST_OIDC_ISSUER}/authorize`,
        token_endpoint: `${TEST_OIDC_ISSUER}/token`,
        jwks_uri: `${TEST_OIDC_ISSUER}/jwks.json`,
      });
    }
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [publicJwk] });
    if (url.endsWith("/token")) {
      const headers = new Headers(init?.headers);
      tokenRequests.push({ authorization: headers.get("authorization") ?? undefined, body: String(init?.body ?? "") });
      if (state.tokenStatus !== 200) return new Response("denied", { status: state.tokenStatus });
      const idToken = await new SignJWT({ nonce: state.nonce, name: state.name })
        .setProtectedHeader({ alg: "RS256", kid: "idp-key-1" })
        .setIssuer(state.issuer)
        .setAudience(state.audience)
        .setSubject(state.subject)
        .setIssuedAt()
        .setExpirationTime(state.claimExpiry)
        .sign(state.key);
      return Response.json({ id_token: idToken, access_token: "upstream-access-token-never-stored" });
    }
    return new Response("not found", { status: 404 });
  };
  return { state, tokenRequests, fetch: fetchImpl };
}

let deployment: TestDeployment;
let idp: FakeIdp;

beforeEach(async () => {
  idp = await createFakeIdp();
  deployment = await createTestDeployment({ idpFetch: idp.fetch, oidcIssuer: TEST_OIDC_ISSUER });
});

afterEach(async () => {
  await deployment.close();
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Drives the authorize leg and returns what the Server sent upstream. */
async function authorize(input: { redirectUri?: string; challenge?: string; state?: string; method?: string } = {}) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    state: input.state ?? DESKTOP_STATE,
    redirect_uri: input.redirectUri ?? DESKTOP_REDIRECT,
    code_challenge: input.challenge ?? challenge,
    code_challenge_method: input.method ?? "S256",
  });
  const response = await deployment.call({ method: "GET", url: `${AUTHORIZE_PATH}?${query.toString()}` });
  return { response, verifier, challenge };
}

/** The IdP leg: what a browser would send back to the Server's callback. */
async function callback(state: string, code = "idp-authorization-code-1") {
  return deployment.call({ method: "GET", url: `${CALLBACK_PATH}?${new URLSearchParams({ code, state }).toString()}` });
}

async function exchange(code: string, verifier: string) {
  return deployment.call({ method: "POST", url: TOKEN_PATH, payload: { code, code_verifier: verifier } });
}

/** authorize → callback → token, the whole happy path. */
async function signIn() {
  const started = await authorize();
  expect(started.response.statusCode).toBe(302);
  const upstream = new URL(String(started.response.headers.location));
  const upstreamState = upstream.searchParams.get("state") ?? "";
  idp.state.nonce = upstream.searchParams.get("nonce") ?? "";

  const returned = await callback(upstreamState);
  expect(returned.statusCode, returned.body).toBe(302);
  const back = new URL(String(returned.headers.location));
  const code = back.searchParams.get("code") ?? "";

  const session = await exchange(code, started.verifier);
  expect(session.statusCode, session.body).toBe(200);
  return { started, upstream, upstreamState, back, code, session: session.json() };
}

describe("the desktop sign-in flow", () => {
  it("completes and issues a session that authenticates account routes", async () => {
    const { upstream, upstreamState, back, session } = await signIn();

    // The IdP leg is the Server's own: its state and challenge are not the
    // desktop's, and the desktop's verifier never leaves the desktop.
    expect(upstream.origin).toBe(TEST_OIDC_ISSUER);
    expect(upstream.pathname).toBe("/authorize");
    expect(upstream.searchParams.get("state")).not.toBe(DESKTOP_STATE);
    expect(upstream.searchParams.get("redirect_uri")).toBe(TEST_CALLBACK_URL);
    expect(upstream.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    expect(upstream.searchParams.get("nonce")).toBe(idp.state.nonce);

    // The redirect goes to the URI validated at authorize time, with a
    // one-time code — never a session token.
    expect(back.origin + back.pathname).toBe(DESKTOP_REDIRECT);
    expect(back.searchParams.get("state")).toBe(DESKTOP_STATE);
    expect(back.searchParams.has("token")).toBe(false);
    expect(upstreamState).not.toBe("");

    expect(session.user.displayName).toBe("Ada Lovelace");
    expect(typeof session.token).toBe("string");

    const me = await deployment.call({ method: "GET", url: "/api/me", token: session.token });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: session.user.id, displayName: "Ada Lovelace" });
  });

  it("is the OIDC client: it authenticates itself and sends the upstream verifier", async () => {
    await signIn();
    expect(idp.tokenRequests).toHaveLength(1);
    const request = idp.tokenRequests[0];
    if (!request) throw new Error("no token request was made");
    expect(request.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    const sent = new URLSearchParams(request.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("idp-authorization-code-1");
    expect(sent.get("code_verifier")).toBeTruthy();
    expect(sent.get("code_verifier")).not.toBe(DESKTOP_STATE);
  });

  it("never puts an upstream token in a URL or in the session it issues", async () => {
    const { session, back, upstream } = await signIn();
    const serialized = `${back.toString()} ${upstream.toString()} ${JSON.stringify(session)}`;
    expect(serialized).not.toContain("upstream-access-token-never-stored");
    // No refresh token is issued to the desktop: the upstream one is dropped.
    expect(session.refreshToken).toBeUndefined();
  });
});

describe("a sign-in that cannot be trusted produces no session", () => {
  it("refuses a redirect_uri that is not an allowlisted loopback /callback", async () => {
    for (const redirectUri of [
      "https://127.0.0.1:53421/callback",
      "http://localhost:53421/callback",
      "http://127.0.0.1:53421/other",
      "http://127.0.0.1:53421/callback?x=1",
      "http://127.0.0.2:53421/callback",
      "http://127.0.0.1/callback",
      "http://user@127.0.0.1:53421/callback",
      "http://127.0.0.1.attacker.example:53421/callback",
    ]) {
      const { response } = await authorize({ redirectUri });
      expect(response.statusCode, redirectUri).toBe(400);
      expect(response.json().error.code, redirectUri).toBe("AUTH_FLOW_INVALID");
    }
  });

  it("refuses a malformed authorize query", async () => {
    const plain = await authorize({ method: "plain" });
    expect(plain.response.statusCode).toBe(400);
    expect(plain.response.json().error.code).toBe("VALIDATION");

    const shortChallenge = await deployment.call({
      method: "GET",
      url: `${AUTHORIZE_PATH}?state=x&redirect_uri=${encodeURIComponent(DESKTOP_REDIRECT)}&code_challenge=short&code_challenge_method=S256`,
    });
    expect(shortChallenge.statusCode).toBe(400);
    expect(shortChallenge.json().error.code).toBe("VALIDATION");
  });

  it("refuses a callback whose state the Server never issued", async () => {
    const response = await callback("not-a-state-this-server-issued");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
  });

  it("consumes the callback state once, so a replay issues nothing", async () => {
    const started = await authorize();
    const upstream = new URL(String(started.response.headers.location));
    const upstreamState = upstream.searchParams.get("state") ?? "";
    idp.state.nonce = upstream.searchParams.get("nonce") ?? "";

    expect((await callback(upstreamState)).statusCode).toBe(302);
    const replay = await callback(upstreamState);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("AUTH_FLOW_INVALID");
  });

  it("consumes the authorization code once", async () => {
    const { code, started } = await signIn();
    const replay = await exchange(code, started.verifier);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("AUTH_FLOW_INVALID");
  });

  it("refuses a code verifier that does not match the original challenge", async () => {
    const started = await authorize();
    const upstream = new URL(String(started.response.headers.location));
    idp.state.nonce = upstream.searchParams.get("nonce") ?? "";
    const returned = await callback(upstream.searchParams.get("state") ?? "");
    const code = new URL(String(returned.headers.location)).searchParams.get("code") ?? "";

    // A well-formed verifier that is simply not the one the challenge was made
    // from; a malformed one is a VALIDATION failure and is covered above.
    for (const verifier of [pkce().verifier, "x".repeat(43)]) {
      const response = await exchange(code, verifier);
      expect(response.statusCode, verifier).toBe(400);
      expect(response.json().error.code, verifier).toBe("AUTH_FLOW_INVALID");
    }
  });

  it("refuses an id_token the IdP did not sign for this attempt", async () => {
    const cases: { name: string; apply: () => void }[] = [
      { name: "wrong nonce", apply: () => (idp.state.nonce = "not-the-nonce-the-server-generated") },
      { name: "wrong issuer", apply: () => (idp.state.issuer = "https://somewhere-else.example.test") },
      { name: "wrong audience", apply: () => (idp.state.audience = "another-client") },
      { name: "expired", apply: () => (idp.state.claimExpiry = Math.floor(Date.now() / 1000) - 60) },
    ];
    for (const testCase of cases) {
      const started = await authorize();
      const upstream = new URL(String(started.response.headers.location));
      idp.state.nonce = upstream.searchParams.get("nonce") ?? "";
      // Applied after the authorize leg so only the IdP's answer is affected.
      testCase.apply();
      const response = await callback(upstream.searchParams.get("state") ?? "");
      expect(response.statusCode, testCase.name).toBe(400);
      expect(response.json().error.code, testCase.name).toBe("AUTH_FLOW_INVALID");
      // Nothing was issued, so no session exists to use.
      expect(response.json().user, testCase.name).toBeUndefined();
    }
  });

  it("refuses an id_token signed with a key the published JWKS does not contain", async () => {
    const other = await generateKeyPair("RS256");
    const started = await authorize();
    const upstream = new URL(String(started.response.headers.location));
    idp.state.nonce = upstream.searchParams.get("nonce") ?? "";
    idp.state.key = other.privateKey;
    const response = await callback(upstream.searchParams.get("state") ?? "");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
  });

  it("reports an unreachable IdP as a flow failure, not a server fault", async () => {
    idp.state.discoveryStatus = 503;
    const { response } = await authorize();
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
  });

  it("reports a token endpoint that refuses the exchange as a flow failure", async () => {
    const started = await authorize();
    const upstream = new URL(String(started.response.headers.location));
    idp.state.nonce = upstream.searchParams.get("nonce") ?? "";
    idp.state.tokenStatus = 400;
    const response = await callback(upstream.searchParams.get("state") ?? "");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("AUTH_FLOW_INVALID");
  });
});
