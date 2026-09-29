import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionDto } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import type { AuthAdapter, AuthTransactionStore, ExternalIdentity, Repository, SessionService } from "../interfaces.js";
import { parseDesktopRedirect } from "./redirect.js";

// ---------------------------------------------------------------------------
// Frozen route spellings (CONTRACTS §9)
// ---------------------------------------------------------------------------

/** The only routes this module owns. B08 wires them into the composition. */
export const AUTHORIZE_PATH = "/api/auth/desktop/authorize";
export const CALLBACK_PATH = "/api/auth/callback";
export const TOKEN_PATH = "/api/auth/desktop/token";

/**
 * These parameter names are the frozen desktop-login contract. They follow the
 * OAuth/OIDC spellings the desktop client already speaks, and `strictObject`
 * means an extra parameter is a validation failure rather than something a
 * typo silently ignores.
 */
export const authorizeQuerySchema = z.strictObject({
  state: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
});

/** The IdP callback. `code` and the Server's own upstream `state`. */
export const callbackQuerySchema = z.strictObject({
  code: z.string().min(1).max(4000),
  state: z.string().min(1).max(200),
});

/** The desktop token exchange. No `redirect_uri`, no client secret (D2: the desktop has none). */
export const tokenBodySchema = z.strictObject({
  code: z.string().min(1).max(4000),
  code_verifier: z.string().min(43).max(128),
});

export type UserDirectory = Pick<Repository, "findUserByExternalIdentity" | "createUserWithIdentity">;

export type AuthRouteDependencies = {
  adapter: AuthAdapter;
  transactions: AuthTransactionStore;
  sessions: SessionService;
  users: UserDirectory;
  /** Registered loopback IPs, from `parseRedirectAllowlist`. */
  redirectAllowlist: string[];
  /** The Server's own fixed IdP callback (CONTRACTS §2.3 step 4). */
  callbackUrl: string;
};

function flowInvalid(message: string): AppError {
  return new AppError("AUTH_FLOW_INVALID", message, 400);
}

/** S256 of the desktop verifier must equal the challenge the login started with. */
function matchesChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const expected = Buffer.from(codeChallenge);
  return computed.byteLength === expected.byteLength && timingSafeEqual(computed, expected);
}

/**
 * The two-stage desktop authorization-code flow of CONTRACTS §2.3.
 *
 * 1. `authorize` validates the loopback redirect, opens one login transaction
 *    bound to the Client's state, challenge and redirect URI, and hands the
 *    IdP leg to the adapter with the Server's own separate upstream state.
 * 2. `callback` atomically consumes the upstream transaction, lets the adapter
 *    exchange and verify the code, maps `(issuer, subject)` to a Solaris user,
 *    and redirects to the *stored* loopback URI with a one-time code. The
 *    session token is never placed in a URL.
 * 3. `token` atomically consumes the code, re-derives the S256 challenge from
 *    the verifier, and only then issues the session.
 */
export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): void {
  const { adapter, transactions, sessions, users, redirectAllowlist, callbackUrl } = dependencies;

  app.get(AUTHORIZE_PATH, async (request, reply) => {
    const query = authorizeQuerySchema.parse(request.query);
    const redirectUri = parseDesktopRedirect(query.redirect_uri, redirectAllowlist);
    const login = transactions.begin({ clientState: query.state, clientChallenge: query.code_challenge, redirectUri });
    try {
      const { authorizationUrl } = await adapter.begin({
        transaction: { id: login.id, state: login.upstreamState, expiresAt: login.expiresAt },
        callbackUrl,
      });
      return reply.header("cache-control", "no-store").redirect(authorizationUrl);
    } catch (error) {
      adapter.discard(login.id);
      transactions.discard(login.id);
      throw error;
    }
  });

  app.get(CALLBACK_PATH, async (request, reply) => {
    const query = callbackQuerySchema.parse(request.query);
    // Atomic single use: a replayed callback finds no transaction and can never
    // produce a second authorization code.
    const login = transactions.consumeByUpstreamState(query.state);
    if (!login) throw flowInvalid("This sign-in attempt is no longer valid");

    let identity: ExternalIdentity;
    try {
      identity = await adapter.complete({
        transaction: { id: login.id, state: login.upstreamState, expiresAt: login.expiresAt },
        callbackUrl,
        parameters: { code: query.code, state: query.state },
      });
    } catch (error) {
      adapter.discard(login.id);
      throw error;
    }

    // The only identity key is (issuer, subject). Email and display name are
    // never matching criteria.
    const user =
      users.findUserByExternalIdentity(identity.issuer, identity.subject) ??
      users.createUserWithIdentity({
        issuer: identity.issuer,
        subject: identity.subject,
        ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      });

    const { code } = transactions.issueCode({ userId: user.id, clientChallenge: login.clientChallenge, redirectUri: login.redirectUri });
    // The redirect target is the URI validated and stored at authorize time,
    // never a value from this request.
    const target = new URL(login.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", login.clientState);
    return reply.header("cache-control", "no-store").redirect(target.toString());
  });

  app.post(TOKEN_PATH, async (request, reply) => {
    const body = tokenBodySchema.parse(request.body);
    const issued = transactions.consumeCode(body.code);
    if (!issued) throw flowInvalid("This authorization code is no longer valid");
    if (!matchesChallenge(body.code_verifier, issued.clientChallenge)) throw flowInvalid("The code verifier does not match this sign-in");
    const session: SessionDto = await sessions.issue(issued.userId);
    return reply.header("cache-control", "no-store").send(session);
  });
}
