import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLocalEnv() {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!name || rawValue === undefined || process.env[name]) continue;
    const value = rawValue.replace(/^("|')|("|')$/g, "");
    process.env[name] = value;
  }
}

readLocalEnv();

function mockOidcEnabled(): boolean {
  const value = process.env.SOLARIS_MOCK_OIDC;
  if (value !== undefined && value !== "0" && value !== "1") throw new Error("SOLARIS_MOCK_OIDC must be 0 or 1");
  return value === "1";
}


/** A malformed budget must refuse startup, not be silently coerced. */
function intVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

/** A budget whose owner (B03) has not fixed a value yet stays absent. */
function optionalIntVar(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return intVar(name, 0);
}

function listVar(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Configuration surface named by CONTRACTS §13. Each value's semantics belong to
 * the task that owns it (marked below); B08 lands the final schema and the
 * public example. Numeric defaults repeat the candidate budgets from CONTRACTS
 * §4.2/§4.3 and the provider baselines in `providers/http.ts` — they are not
 * measured values, and B04/B05 write the real ones back after testing.
 *
 * This module only reads the environment. Values whose absence must stop the
 * process (the public origin, the trusted-proxy hop count, the auth/credential
 * registries, the master key) are validated by their owner — `main.ts` and
 * `http/security.ts` — so that importing `env` in a test does not require a
 * whole deployment's configuration.
 */
export const env = {
  dataDir: resolve(process.env.SOLARIS_DATA_DIR ?? ".solaris-data"),
  port: Number.parseInt(process.env.PORT ?? "3210", 10),
  masterKey: process.env.CREDENTIALS_MASTER_KEY,
  production: process.env.NODE_ENV === "production",

  // -- remote boundary (B08) -------------------------------------------------
  /** `SOLARIS_PUBLIC_ORIGIN`; required at startup, parsed by `http/security.ts`. */
  publicOrigin: process.env.SOLARIS_PUBLIC_ORIGIN,
  /** `SOLARIS_ALLOWED_ORIGINS`; empty means the public origin alone. */
  allowedOrigins: listVar("SOLARIS_ALLOWED_ORIGINS"),
  /** `SOLARIS_TRUST_PROXY`: a hop count, parsed by `http/security.ts`. */
  trustProxy: process.env.SOLARIS_TRUST_PROXY,
  /** `SOLARIS_BIND_HOST`; loopback unless the deployment says otherwise. */
  bindHost: process.env.SOLARIS_BIND_HOST ?? "127.0.0.1",

  // -- authentication (B03) --------------------------------------------------
  mockOidc: mockOidcEnabled(),
  geminiApiKey: process.env.SOLARIS_GEMINI_API_KEY,
  geminiBaseUrl: process.env.SOLARIS_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
  geminiModel: process.env.SOLARIS_GEMINI_MODEL ?? "gemini-3.1-flash-image",
  authAdapter: process.env.SOLARIS_AUTH_ADAPTER,
  credentialSource: process.env.SOLARIS_CREDENTIAL_SOURCE,
  oidcIssuer: process.env.SOLARIS_OIDC_ISSUER,
  oidcClientId: process.env.SOLARIS_OIDC_CLIENT_ID,
  oidcClientSecret: process.env.SOLARIS_OIDC_CLIENT_SECRET,
  oidcScopes: listVar("SOLARIS_OIDC_SCOPES"),
  sessionTtlSeconds: optionalIntVar("SOLARIS_SESSION_TTL_SECONDS"),
  desktopRedirectAllowlist: listVar("SOLARIS_DESKTOP_REDIRECT_ALLOWLIST"),

  // -- upstream call budgets (B04) -------------------------------------------
  upstreamTimeoutMs: intVar("SOLARIS_UPSTREAM_TIMEOUT_MS", 90_000),
  upstreamResponseMaxBytes: intVar("SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES", 32 * 1024 * 1024),

  // -- delivery and replay budgets (B04/B05) ---------------------------------
  imageResultMaxBytes: intVar("SOLARIS_IMAGE_RESULT_MAX_BYTES", 24 * 1024 * 1024),
  resultCacheTtlSeconds: intVar("SOLARIS_RESULT_CACHE_TTL_SECONDS", 10 * 60),
  resultCacheMaxBytes: intVar("SOLARIS_RESULT_CACHE_MAX_BYTES", 256 * 1024 * 1024),
};
