import { env } from "../env.js";
import { AppError } from "../errors.js";
import type { ProviderConnection } from "./types.js";

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("BASE_URL_INVALID", "Base URL must be a valid absolute URL", 400);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError("BASE_URL_INVALID", "Base URL cannot contain credentials, query text, or fragments", 400);
  }
  if (url.protocol !== "https:") throw new AppError("BASE_URL_INSECURE", "Provider URLs must use HTTPS", 400);
  return url.toString().replace(/\/$/, "");
}

export function endpoint(connection: ProviderConnection, path: string): string {
  if (!path.startsWith("/")) throw new AppError("INTERNAL", "Provider plugin supplied an invalid route", 500);
  return `${normalizeBaseUrl(connection.baseUrl)}${path}`;
}

export type ProviderTextResponse = { ok: boolean; status: number; text: string };

/**
 * Why Solaris stopped a call on its own terms. A closed set, so the reason can
 * be reported without echoing anything the model service sent.
 *
 * `not-sent` is the one kind that is known to have reached nothing upstream:
 * the request could not even be built. It must not be treated as an unknown
 * outcome, which would claim the request may have been accepted and billed.
 */
export type UpstreamTransportFailure = "not-sent" | "timeout" | "too-large" | "redirect";

/** A locally determined transport failure; it carries no upstream text. */
export class UpstreamTransportError extends Error {
  constructor(readonly kind: UpstreamTransportFailure, message: string) {
    super(message);
    this.name = "UpstreamTransportError";
  }
}

/**
 * Performs one upstream call and reads its body inside a single overall
 * deadline taken from `SOLARIS_UPSTREAM_TIMEOUT_MS`.
 *
 * The deadline covers sending, body reading and parsing. Aborting only until
 * the headers arrive — and clearing the timer in a `finally` that runs before
 * the body is consumed — leaves a slow body unbounded, which is exactly how a
 * stalled upstream exhausts a server. The timer therefore stays armed until the
 * body has been read; a body that stalls mid-read aborts like any other.
 *
 * A caller-supplied signal may shorten the deadline but never bypass it: it is
 * combined with the deadline, not substituted for it.
 *
 * The body is read under a byte budget (`SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES`)
 * so an oversized response is refused while streaming, rather than buffered and
 * then checked.
 */
export async function providerCall(
  connection: ProviderConnection,
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ProviderTextResponse> {
  const timeoutMs = options.timeoutMs ?? env.upstreamTimeoutMs;
  const maxBytes = options.maxBytes ?? env.upstreamResponseMaxBytes;

  let url: string;
  try {
    url = endpoint(connection, path);
  } catch (error) {
    // Raised while building the request: nothing was sent, so this is the one
    // failure that proves upstream cannot have accepted anything.
    throw new UpstreamTransportError("not-sent", error instanceof Error ? error.message : "The provider endpoint is not usable");
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new UpstreamTransportError("timeout", "Upstream call exceeded its deadline")), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

  try {
    // `redirect: "manual"` keeps Solaris from chasing an upstream-supplied
    // location. Following one would replay the POST body — and the `?key=`
    // query carrying the credential — to whatever host the response names, and
    // an upstream-supplied URL is not a request target Solaris will use.
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new UpstreamTransportError("redirect", "Upstream answered with a redirect, which Solaris does not follow");
    }
    return { ok: response.ok, status: response.status, text: await readBounded(response, maxBytes, signal) };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readOrAbort(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new UpstreamTransportError("too-large", "Upstream response exceeded the configured limit");
      chunks.push(value);
    }
  } catch (error) {
    // Stop the transfer when the read is abandoned, so an oversized or stalled
    // body is not left draining in the background.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One `read()` bounded by the deadline.
 *
 * A runtime is expected to error a body whose signal aborted, but the deadline
 * must not depend on that: racing the read here keeps a stalled body from
 * holding the call open indefinitely on any runtime or fixture.
 */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
