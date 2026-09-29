import type { FastifyRequest } from "fastify";
import { isLoopbackAddress } from "../auth/index.js";

/**
 * The deployment boundary (CONTRACTS §1, §9, §13).
 *
 * Solaris is no longer a loopback-only BFF: the desktop client reaches a Server
 * over the network, so the boundary is not a bind address but a configuration.
 * Two things are checked before any route handler runs:
 *
 * - `Host` must be the authority of `SOLARIS_PUBLIC_ORIGIN`. This is what stops
 *   a request addressed to some other name from being served as Solaris.
 * - `Origin`, when the client sends one, must be in the explicit allowlist
 *   (default: the public origin itself). A request with no `Origin` is not
 *   treated as same-origin — it is a non-browser client, and it still has to
 *   present a valid bearer session for every API route that carries user data.
 *
 * Both checks fail closed: an unconfigured or malformed deployment refuses to
 * start (`deploymentBoundary` throws) rather than serving unprotected, and an
 * unparseable `Origin` is a rejection, not a pass.
 */

/** A transport-boundary rejection. Deliberately outside the frozen API code table. */
export type BoundaryRejection = {
  readonly code: "HOST_REJECTED" | "ORIGIN_REJECTED";
  readonly statusCode: number;
  readonly message: string;
};

/**
 * Transport-level status codes, chosen so an operator can tell a routine
 * boundary rejection apart from a real fault:
 *
 * - `HOST_REJECTED` is 421 Misdirected Request (RFC 9110 §15.5.20): the request
 *   reached a server that does not serve this authority.
 * - `ORIGIN_REJECTED` is 403: the request is understood and the caller is not
 *   allowed to make it from that origin.
 *
 * These are not API error codes: they are not in `errorCodes` and must not be
 * added to the frozen table. They are answered by the boundary hook itself, so
 * `toPublicError` never sees them.
 */
export const HOST_REJECTED: BoundaryRejection = {
  code: "HOST_REJECTED",
  statusCode: 421,
  message: "This Solaris Server does not serve the requested host",
};

export const ORIGIN_REJECTED: BoundaryRejection = {
  code: "ORIGIN_REJECTED",
  statusCode: 403,
  message: "This origin is not allowed to call the Solaris API",
};

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** A header whose duplicate form is a joined string is not a usable authority. */
type BoundaryRequest = {
  headers: { host?: string | string[] | undefined; origin?: string | string[] | undefined };
};

export type DeploymentBoundary = {
  /** The configured public origin, canonical (`scheme://authority`). */
  readonly publicOrigin: string;
  /** Authorities accepted in the `Host` header. */
  readonly authorities: ReadonlySet<string>;
  /** Origins accepted in the `Origin` header. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Exactly the number of proxy hops trusted; 0 means none. */
  readonly trustProxy: number;
  rejectionFor(request: BoundaryRequest): BoundaryRejection | null;
};

export type BoundaryConfig = {
  /** `SOLARIS_PUBLIC_ORIGIN`. */
  publicOrigin: string | undefined;
  /** `SOLARIS_ALLOWED_ORIGINS`; empty means the public origin only. */
  allowedOrigins: string[];
  /** `SOLARIS_TRUST_PROXY`: a hop count, not a boolean. */
  trustProxy: string | undefined;
};

/**
 * A trusted proxy is expressed as a number of hops, never as a boolean.
 * `true` would mean "believe `X-Forwarded-*` from anyone", which lets a direct
 * peer forge the client address and protocol; a count cannot do that, because
 * the address is read that many hops from the socket and no further.
 */
export function parseTrustProxy(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`SOLARIS_TRUST_PROXY must be a non-negative integer hop count (0 means no proxy is trusted), got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** IPv6 origins arrive bracketed from `URL`, and loopback is exactly 127/8 or `::1`. */
function isLoopbackHost(hostname: string): boolean {
  return isLoopbackAddress(hostname.replace(/^\[|\]$/g, ""));
}

type ParsedOrigin = { origin: string; authority: string; defaultPort: string | undefined };

/**
 * An origin value is accepted only as `scheme://authority` with nothing else:
 * no credentials, no path, no query, no fragment. `https` is required, except
 * for a literal loopback host, where `http` is how a local development server
 * (and the e2e harness) is reached.
 */
function parseOrigin(value: string, source: string, requireHttps: boolean): ParsedOrigin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} must be an absolute origin such as https://solaris.example.com, got ${JSON.stringify(value)}`);
  }
  if (url.host === "") throw new Error(`${source} must include a host, got ${JSON.stringify(value)}`);
  if (url.username !== "" || url.password !== "") throw new Error(`${source} must not carry credentials`);
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error(`${source} must be an origin only, with no path, query or fragment, got ${JSON.stringify(value)}`);
  }
  if (requireHttps && url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${source} must use https; http is accepted only for a loopback host, got ${JSON.stringify(value)}`);
  }
  return { origin: `${url.protocol}//${url.host}`, authority: url.host, defaultPort: DEFAULT_PORT[url.protocol] };
}

/** Lower-cased authority, with the public origin's default port normalized away. */
function canonicalAuthority(raw: string, defaultPort: string | undefined): string | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || !/^[a-z0-9.:[\]-]+$/.test(value)) return null;
  if (defaultPort !== undefined && value.endsWith(`:${defaultPort}`)) return value.slice(0, -(defaultPort.length + 1));
  return value;
}

/**
 * An `Origin` header is exactly `scheme://authority`. Anything else — a joined
 * duplicate, the literal `null` a sandboxed document sends, junk — is not an
 * allowed origin and is rejected.
 */
function canonicalOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.host === "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Builds the boundary from configuration. Every failure here is a startup
 * failure: a deployment that cannot say what it is reachable at does not get to
 * serve requests.
 */
export function deploymentBoundary(config: BoundaryConfig): DeploymentBoundary {
  if (config.publicOrigin === undefined || config.publicOrigin.trim() === "") {
    throw new Error(
      "SOLARIS_PUBLIC_ORIGIN is required: Solaris must know the origin it is served at " +
        "(for example https://solaris.example.com) before it will accept requests",
    );
  }
  const publicOrigin = parseOrigin(config.publicOrigin.trim(), "SOLARIS_PUBLIC_ORIGIN", true);

  const allowedOrigins = new Set<string>([publicOrigin.origin]);
  for (const entry of config.allowedOrigins) {
    if (entry.trim() === "") continue;
    allowedOrigins.add(parseOrigin(entry, "SOLARIS_ALLOWED_ORIGINS", false).origin);
  }

  const authorities = new Set<string>([publicOrigin.authority]);
  const trustProxy = parseTrustProxy(config.trustProxy);

  return {
    publicOrigin: publicOrigin.origin,
    authorities,
    allowedOrigins,
    trustProxy,
    rejectionFor(request: BoundaryRequest): BoundaryRejection | null {
      const host = request.headers.host;
      const authority = typeof host === "string" ? canonicalAuthority(host, publicOrigin.defaultPort) : null;
      if (authority === null || !authorities.has(authority)) return HOST_REJECTED;
      const origin = request.headers.origin;
      if (origin === undefined) return null;
      const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
      if (canonical === null || !allowedOrigins.has(canonical)) return ORIGIN_REJECTED;
      return null;
    },
  };
}

/**
 * Reports a rejection to the operator.
 *
 * The server runs with `logger: false`, so without this line a routine boundary
 * rejection is completely silent — indistinguishable from a network fault. Only
 * the rejection code, the requested host and the origin are written, as
 * JSON-escaped and length-bounded strings, so an attacker-controlled header
 * cannot forge a log line or flood the log. No session token, cookie or
 * credential is ever part of a rejection.
 */
export function reportBoundaryRejection(request: FastifyRequest, rejection: BoundaryRejection): void {
  const bound = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : null);
  console.warn(
    `Solaris refused a request at the deployment boundary: ${JSON.stringify({
      code: rejection.code,
      method: request.method,
      url: request.url.split("?")[0] ?? "",
      host: bound(request.headers.host),
      origin: bound(request.headers.origin),
    })}`,
  );
}
