/**
 * Client-side PKCE and authorization request construction (CONTRACTS §2.3).
 *
 * The verifier is minted here, kept in memory by `DesktopLogin`, and handed only
 * to the caller that exchanges it at the token endpoint. It is never passed to
 * the native layer, written to a record or logged.
 */

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type LoginAttempt = {
  /** Client state: compared against the value the Server echoes to `/callback`. */
  state: string;
  /** S256 code verifier: 43 characters, never leaves this process. */
  codeVerifier: string;
  /** S256 challenge sent with the authorization request. */
  codeChallenge: string;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/** S256 challenge of a verifier: base64url(SHA-256(ASCII(verifier))). */
export async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * Fresh state and PKCE pair for one authorization attempt.
 *
 * `codeVerifier` is injectable so the RFC 7636 fixed vector can be checked;
 * production callers leave it to `crypto.getRandomValues`.
 */
export async function createLoginAttempt(options: { codeVerifier?: string } = {}): Promise<LoginAttempt> {
  const codeVerifier = options.codeVerifier ?? randomBase64Url(32);
  if (!VERIFIER_PATTERN.test(codeVerifier)) {
    throw new Error("A PKCE code verifier must be 43 to 128 unreserved characters");
  }
  const state = randomBase64Url(32);
  if (!BASE64URL_PATTERN.test(state)) {
    throw new Error("Could not create authorization state");
  }
  return { state, codeVerifier, codeChallenge: await s256Challenge(codeVerifier) };
}

/**
 * Authorization request URL.
 *
 * The endpoint arrives in `DeploymentDto.auth.authorizationEndpoint` and must be
 * an absolute http(s) URL; a fragment would be dropped by the Server's strict
 * parsing, so it is refused here instead.
 */
export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  let endpoint: URL;
  try {
    endpoint = new URL(input.authorizationEndpoint);
  } catch {
    throw new Error("The Server authorization endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`The Server authorization endpoint must use http or https, received ${endpoint.protocol}`);
  }
  if (endpoint.hash !== "") {
    throw new Error("The Server authorization endpoint must not carry a fragment");
  }
  endpoint.searchParams.set("response_type", "code");
  endpoint.searchParams.set("redirect_uri", input.redirectUri);
  endpoint.searchParams.set("code_challenge", input.codeChallenge);
  endpoint.searchParams.set("code_challenge_method", "S256");
  endpoint.searchParams.set("state", input.state);
  return endpoint.toString();
}
