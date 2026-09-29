import { authAdapterIds } from "../../shared/contracts.js";
import type { AuthAdapter, AuthTransactionStore, SessionService } from "../interfaces.js";
import { OidcAuthAdapter } from "./oidc.js";
import { DEFAULT_REDIRECT_ALLOWLIST, parseRedirectAllowlist } from "./redirect.js";
import { BearerSessionService, DEFAULT_SESSION_TTL_SECONDS, type SessionStore } from "./sessions.js";
import { InMemoryAuthTransactionStore } from "./transactions.js";

export { OidcAuthAdapter, type OidcConfig } from "./oidc.js";
export { AUTHORIZE_PATH, CALLBACK_PATH, TOKEN_PATH, authorizeQuerySchema, callbackQuerySchema, tokenBodySchema, registerAuthRoutes, type AuthRouteDependencies, type UserDirectory } from "./routes.js";
export { DEFAULT_REDIRECT_ALLOWLIST, isLoopbackAddress, parseDesktopRedirect, parseRedirectAllowlist } from "./redirect.js";
export { BearerSessionService, DEFAULT_SESSION_TTL_SECONDS, sessionTokenHash, type SessionStore } from "./sessions.js";
export { InMemoryAuthTransactionStore, LOGIN_TRANSACTION_TTL_MS, AUTHORIZATION_CODE_TTL_MS, MAX_LOGIN_TRANSACTIONS, MAX_AUTHORIZATION_CODES, type AuthTransactionStoreConfig } from "./transactions.js";

/** Config surface of CONTRACTS §13 that B03 owns; B08 lands `env.ts`. */
export type AuthConfig = {
  /** `SOLARIS_AUTH_ADAPTER`. */
  adapter: string | undefined;
  /** `SOLARIS_SESSION_TTL_SECONDS`; absent means `DEFAULT_SESSION_TTL_SECONDS`. */
  sessionTtlSeconds: number | undefined;
  /** `SOLARIS_DESKTOP_REDIRECT_ALLOWLIST`; empty means the documented loopback default. */
  desktopRedirectAllowlist: string[];
  oidc: {
    /** `SOLARIS_OIDC_ISSUER`. */
    issuer: string | undefined;
    /** `SOLARIS_OIDC_CLIENT_ID`. */
    clientId: string | undefined;
    /** `SOLARIS_OIDC_CLIENT_SECRET` — the Server's own client, never the desktop's (D2). */
    clientSecret: string | undefined;
    /** `SOLARIS_OIDC_SCOPES`; `openid` is mandatory for an id_token. */
    scopes: string[];
  };
  /** Injectable for tests; production uses the global fetch. */
  fetch?: typeof fetch;
  clock?: () => number;
};

export type AuthBoundaries = {
  adapter: AuthAdapter;
  sessions: SessionService;
  transactions: AuthTransactionStore;
  /** The validated loopback IPs the authorize route accepts. */
  redirectAllowlist: string[];
};

/**
 * The closed auth-adapter registry (CONTRACTS §1/§13).
 *
 * Only `oidc` exists publicly, and a missing or unsupported value is a startup
 * failure: there is no silent fallback to a weaker sign-in path, and the OIDC
 * configuration keys are required only when `oidc` is the selected adapter, so
 * a future internal deployment is not forced to configure them.
 */
export function createAuthBoundaries(repository: SessionStore, config: AuthConfig): AuthBoundaries {
  if (config.adapter !== "oidc") {
    throw new Error(`SOLARIS_AUTH_ADAPTER must be one of ${authAdapterIds.join(", ")}; got ${JSON.stringify(config.adapter ?? null)}`);
  }
  const { issuer, clientId, clientSecret } = config.oidc;
  if (!issuer) throw new Error("SOLARIS_OIDC_ISSUER is required when SOLARIS_AUTH_ADAPTER=oidc");
  if (!clientId) throw new Error("SOLARIS_OIDC_CLIENT_ID is required when SOLARIS_AUTH_ADAPTER=oidc");
  if (!clientSecret) throw new Error("SOLARIS_OIDC_CLIENT_SECRET is required when SOLARIS_AUTH_ADAPTER=oidc");
  // `openid` is what makes the IdP return an id_token at all, so a scope list
  // without it cannot authenticate anyone.
  const scopes = config.oidc.scopes.length === 0 ? ["openid"] : config.oidc.scopes;
  if (!scopes.includes("openid")) throw new Error('SOLARIS_OIDC_SCOPES must include "openid"');

  const sessionTtlSeconds = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error(`SOLARIS_SESSION_TTL_SECONDS must be a positive integer, got ${JSON.stringify(config.sessionTtlSeconds ?? null)}`);
  }

  const redirectAllowlist = parseRedirectAllowlist(config.desktopRedirectAllowlist.length > 0 ? config.desktopRedirectAllowlist : DEFAULT_REDIRECT_ALLOWLIST);

  const adapter = new OidcAuthAdapter({ issuer, clientId, clientSecret, scopes, ...(config.fetch === undefined ? {} : { fetch: config.fetch }) });

  return {
    adapter,
    sessions: new BearerSessionService(repository, sessionTtlSeconds, config.clock ?? Date.now),
    transactions: new InMemoryAuthTransactionStore(config.clock === undefined ? {} : { clock: config.clock }),
    redirectAllowlist,
  };
}
