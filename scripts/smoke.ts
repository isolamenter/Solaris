/**
 * Smoke check against a running Server (CONTRACTS §9).
 *
 * It is deliberately not a health ping: a Server that answers `ok` but serves
 * every host is not deployed. The script therefore checks the deployment
 * boundary as well — the configured host is served, a forged `Host` and a
 * forged `Origin` are refused with their transport statuses, and an
 * unauthenticated account route is `401`.
 *
 * The probes use `node:http`/`node:https` rather than `fetch`, because `fetch`
 * refuses to send a `Host` header that disagrees with the connection target —
 * which is the one header this check exists to forge.
 *
 * Configuration comes from the same variables the server reads, so pointing it
 * at a deployment is the same as pointing the server at it.
 */
export {};

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const port = process.env.PORT ?? "3210";
const origin = process.env.SOLARIS_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const target = new URL(origin);
const authority = target.host;

type Check = { name: string; status: number; code?: string };

/** The boundary's response envelope, or nothing when the body is not one. */
function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined;
    const { error } = parsed as { error?: { code?: unknown } };
    return typeof error?.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function probe(path: string, headers: Record<string, string> = {}): Promise<Check> {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const call = send(
      { host: target.hostname, port: target.port === "" ? undefined : Number(target.port), path, method: "GET", headers: { host: authority, ...headers } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          const code = errorCode(body);
          done({ name: path, status: response.statusCode ?? 0, ...(code === undefined ? {} : { code }) });
        });
      },
    );
    call.on("error", fail);
    call.end();
  });
}

const checks: Check[] = [];
function record(check: Check): Check {
  checks.push(check);
  return check;
}

function expect(check: Check, status: number, code: string | undefined, what: string): void {
  if (check.status !== status || check.code !== code) {
    throw new Error(`${what}: expected ${status} ${code ?? ""}, got ${check.status} ${check.code ?? ""}`.trimEnd());
  }
}

const health = record(await probe("/api/health"));
expect(health, 200, undefined, "The configured host was not served");

const forgedHost = record(await probe("/api/health", { host: "attacker.example" }));
expect(forgedHost, 421, "HOST_REJECTED", "The boundary did not refuse a forged Host");

const forgedOrigin = record(await probe("/api/health", { origin: "https://attacker.example" }));
expect(forgedOrigin, 403, "ORIGIN_REJECTED", "The boundary did not refuse a forged Origin");

const unauthenticated = record(await probe("/api/me"));
expect(unauthenticated, 401, "AUTH_REQUIRED", "An account route answered without a session");

console.log(`Solaris smoke check passed for ${origin} (host ${authority})`);
for (const check of checks) console.log(`  ${check.status} ${check.code ?? ""} ${check.name}`.trimEnd());
