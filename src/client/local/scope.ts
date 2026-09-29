/**
 * Local scope keying — CONTRACTS §10.
 *
 * Every client-local record is addressed by `(normalized Server origin, Solaris
 * user id)`. The key is derived here, in one place, so two accounts or two
 * Servers can never share a directory, a record id or a session. Ownership is
 * never inferred from a global "current account": the caller always passes the
 * scope it is acting for.
 */

import type { LocalScope } from "../../shared/local.js";

/** Longest accepted user id, matching the Server's UUID identifiers. */
const MAX_USER_ID = 128;

/**
 * Canonical form of a Server origin: lowercase scheme and host, explicit port
 * only when it is not the default, no path, no credentials, no trailing slash.
 *
 * This must agree with `SolarisApi.origin` (`new URL(baseUrl).origin`); the
 * explicit checks below only reject input that is not a Server origin at all.
 */
export function normalizeServerOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`A Server origin must be an absolute URL, received ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`A Server origin must use http or https, received ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("A Server origin must not carry credentials");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`A Server origin must not carry a path, received ${parsed.pathname}`);
  }
  return parsed.origin;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertUserId(userId: string): string {
  if (userId === "" || userId.length > MAX_USER_ID || hasControlCharacter(userId)) {
    throw new Error("A local scope needs a Solaris user id");
  }
  return userId;
}

/**
 * Directory-safe scope key: `s-` plus the hex SHA-256 of the normalized origin
 * and the user id.
 *
 * A digest keeps the key bounded and free of separators, so a hostile user id
 * cannot address another scope's directory; the two components are joined with a
 * newline that neither may contain in a normalized origin.
 */
export async function localScopeKey(scope: LocalScope): Promise<string> {
  const origin = normalizeServerOrigin(scope.serverOrigin);
  const userId = assertUserId(scope.userId);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${origin}\n${userId}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `s-${hex}`;
}

/**
 * A record id must be usable as one file name and must not address anything
 * else. It is rejected rather than rewritten: rewriting `a/b` into `a_b` would
 * let two different ids land on one record.
 */
export function assertRecordId(id: string, label: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`The local ${label} is not a usable record id: ${JSON.stringify(id)}`);
  }
  return id;
}
