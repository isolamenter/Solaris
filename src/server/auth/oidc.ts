import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { AuthAdapterId } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import type { AuthAdapter, AuthTransaction, ExternalIdentity } from "../interfaces.js";

const DISCOVERY_PATH = "/.well-known/openid-configuration";
const HTTP_TIMEOUT_MS = 10_000;
const JWKS_TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * id_token signature algorithms accepted from the IdP. Asymmetric only: an HMAC
 * algorithm would let anything that can publish a JWKS sign the token it is
 * supposed to verify.
 */
const ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

export type OidcConfig = {
  /** Must equal the IdP's `iss` claim; a trailing slash is tolerated. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Injectable for tests; production uses the global fetch. */
  fetch?: typeof fetch;
};

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

/**
 * What the adapter keeps privately for one login attempt. CONTRACTS §2.3: the
 * OIDC leg has its OWN PKCE verifier and nonce. The desktop verifier never
 * reaches this class — `begin` is not even given it — so the two secrets cannot
 * be confused or reused.
 */
type PendingLogin = { codeVerifier: string; codeChallenge: string; nonce: string; expiresAt: number };

/** Static, secret-free: an error from this boundary must never carry a token, code or verifier. */
function flowInvalid(): AppError {
  return new AppError("AUTH_FLOW_INVALID", "The sign-in attempt could not be verified", 400);
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function s256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * The public OIDC auth adapter (CONTRACTS §2.2).
 *
 * D2: the desktop holds no client secret, so the Server is the OIDC client —
 * it is the one that talks to the IdP, and it alone holds the client secret,
 * the upstream PKCE verifier and the nonce.
 *
 * `complete` verifies rather than parses: the authorization code is exchanged
 * at the token endpoint, and the returned id_token is checked against the IdP
 * JWKS for signature, `iss`, `aud`, `exp` and the nonce this attempt generated.
 * Upstream tokens are used only to establish identity here and are never
 * persisted.
 */
export class OidcAuthAdapter implements AuthAdapter {
  readonly id: AuthAdapterId = "oidc";

  private readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Map<string, PendingLogin>();
  private discoveryPromise: Promise<OidcDiscovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: OidcConfig) {
    this.issuer = config.issuer.replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? fetch;
  }

  async begin(input: { transaction: AuthTransaction; callbackUrl: string }): Promise<{ authorizationUrl: string }> {
    const discovery = await this.discovery();
    this.evictPending();
    const codeVerifier = randomToken();
    const nonce = randomToken();
    this.pending.set(input.transaction.id, {
      codeVerifier,
      codeChallenge: s256(codeVerifier),
      nonce,
      expiresAt: Date.parse(input.transaction.expiresAt),
    });

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.callbackUrl);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("code_challenge", s256(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", nonce);
    // The upstream state is the Server's own; it is never the Client's state.
    url.searchParams.set("state", input.transaction.state);
    return { authorizationUrl: url.toString() };
  }

  async complete(input: { transaction: AuthTransaction; callbackUrl: string; parameters: Record<string, string> }): Promise<ExternalIdentity> {
    const pending = this.pending.get(input.transaction.id);
    // Single use: consumed before anything can fail, so a replayed callback or a
    // failed verification can never be retried against the same nonce.
    this.pending.delete(input.transaction.id);
    if (!pending) throw flowInvalid();
    if (!(pending.expiresAt > Date.now())) throw flowInvalid();
    if (input.parameters.state !== input.transaction.state) throw flowInvalid();
    const code = input.parameters.code;
    if (!code) throw flowInvalid();

    const discovery = await this.discovery();
    const idToken = await this.exchangeCode(discovery, code, pending.codeVerifier, input.callbackUrl);
    const payload = await this.verifyIdToken(discovery, idToken, pending.nonce);

    const issuer = payload.iss;
    const subject = payload.sub;
    if (typeof issuer !== "string" || typeof subject !== "string" || subject.length === 0) throw flowInvalid();
    const displayName = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : undefined;
    // Identity is (issuer, subject) only — never email, never display name.
    return { issuer, subject, ...(displayName === undefined ? {} : { displayName }) };
  }

  discard(transactionId: string): void {
    this.pending.delete(transactionId);
  }

  /** Authorization-code exchange. The response body is never echoed or logged. */
  private async exchangeCode(discovery: OidcDiscovery, code: string, codeVerifier: string, callbackUrl: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
    });
    const response = await this.request(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        // client_secret_basic: the default method for a confidential client.
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      },
      body: body.toString(),
    });
    if (!response.ok) throw flowInvalid();
    let document: unknown;
    try {
      document = await response.json();
    } catch {
      throw flowInvalid();
    }
    const idToken = document && typeof document === "object" && "id_token" in document ? document.id_token : undefined;
    if (typeof idToken !== "string" || idToken.length === 0) throw flowInvalid();
    // `access_token` and `refresh_token` are deliberately ignored: nothing about
    // the upstream session leaves this method.
    return idToken;
  }

  /** Signature, issuer, audience, expiry and nonce — all of them, or no identity. */
  private async verifyIdToken(discovery: OidcDiscovery, idToken: string, nonce: string): Promise<{ iss?: unknown; sub?: unknown; name?: unknown }> {
    this.jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: JWKS_TIMEOUT_MS, [customFetch]: this.fetchImpl });
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.issuer,
        audience: this.config.clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        // `sub` is the identity; `exp` must be present or the token never expires.
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.nonce !== "string" || !constantTimeEquals(payload.nonce, nonce)) throw flowInvalid();
      return payload;
    } catch (error) {
      // One message for every verification failure: which check failed is not
      // something an unauthenticated caller gets to learn.
      if (error instanceof AppError) throw error;
      throw flowInvalid();
    }
  }

  private async discovery(): Promise<OidcDiscovery> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.loadDiscovery().catch((error: unknown) => {
        // A transient failure must not be cached as the provider's answer.
        this.discoveryPromise = null;
        throw error;
      });
    }
    return this.discoveryPromise;
  }

  private async loadDiscovery(): Promise<OidcDiscovery> {
    const response = await this.request(`${this.issuer}${DISCOVERY_PATH}`, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) throw flowInvalid();
    let document: Partial<OidcDiscovery>;
    try {
      document = (await response.json()) as Partial<OidcDiscovery>;
    } catch {
      throw flowInvalid();
    }
    const { issuer, authorization_endpoint, token_endpoint, jwks_uri } = document;
    if (issuer !== this.issuer) throw flowInvalid();
    if (typeof authorization_endpoint !== "string" || typeof token_endpoint !== "string" || typeof jwks_uri !== "string") throw flowInvalid();
    return { issuer, authorization_endpoint, token_endpoint, jwks_uri };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch {
      throw flowInvalid();
    }
  }

  /** Pending PKCE secrets whose transaction is already over are dropped. */
  private evictPending(): void {
    for (const [id, pending] of this.pending) {
      if (!(pending.expiresAt > Date.now())) this.pending.delete(id);
    }
  }
}
