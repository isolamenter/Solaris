import { isIP } from "node:net";
import { AppError } from "../errors.js";

/** CONTRACTS §2.3: the desktop client's single, exact callback path. */
const CALLBACK_PATH = "/callback";

/** The flow the contract documents (`http://127.0.0.1:<port>/callback`). */
export const DEFAULT_REDIRECT_ALLOWLIST = ["127.0.0.1"];

function invalidRedirect(): AppError {
  // The rejected value is deliberately not echoed: it is attacker-controlled
  // and this message can end up in a browser-facing error.
  return new AppError("AUTH_FLOW_INVALID", "redirect_uri must be a registered loopback http://<ip>:<port>/callback address", 400);
}

/** IPv4 loopback is 127.0.0.0/8; IPv6 loopback is exactly ::1. Nothing else is loopback. */
export function isLoopbackAddress(value: string): boolean {
  if (isIP(value) === 4) return value.split(".")[0] === "127";
  if (isIP(value) === 6) return value.toLowerCase() === "::1";
  return false;
}

/**
 * `SOLARIS_DESKTOP_REDIRECT_ALLOWLIST` holds loopback IP literals only. A public
 * host here would silently turn the authorize route into an open redirect, so a
 * non-loopback entry is a startup error, not a per-request rejection.
 */
export function parseRedirectAllowlist(entries: string[]): string[] {
  const hosts = entries.map((entry) => {
    const host = entry.trim().replace(/^\[|\]$/g, "");
    if (!isLoopbackAddress(host)) {
      throw new Error(`SOLARIS_DESKTOP_REDIRECT_ALLOWLIST accepts loopback IP literals only; ${JSON.stringify(entry)} is not one`);
    }
    return host;
  });
  return [...new Set(hosts)];
}

/**
 * Strict loopback parsing for the desktop `redirect_uri` (CONTRACTS §2.3).
 *
 * Accepted: `http://<allowlisted loopback ip>:<1-65535>/callback`, and nothing
 * else. Rejected: any other scheme (HTTPS included), any name such as
 * `localhost` or a suffix lookalike, an explicit `@` credential part, a query,
 * a fragment, a path other than `/callback`, a missing or zero port, and any
 * host that is not in the allowlist.
 *
 * The returned value is the canonical URL, and it is what the rest of the flow
 * binds: the authorize leg stores it on the login transaction, the callback leg
 * redirects only to that stored value, so a later request cannot redirect the
 * authorization code anywhere else.
 */
export function parseDesktopRedirect(raw: string, allowlist: string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRedirect();
  }
  if (url.protocol !== "http:") throw invalidRedirect();
  if (url.username !== "" || url.password !== "") throw invalidRedirect();
  if (url.search !== "" || url.hash !== "") throw invalidRedirect();
  if (url.pathname !== CALLBACK_PATH) throw invalidRedirect();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowlist.includes(host)) throw invalidRedirect();
  if (!/^\d{1,5}$/.test(url.port)) throw invalidRedirect();
  const port = Number(url.port);
  if (port < 1 || port > 65_535) throw invalidRedirect();
  return url.toString();
}
