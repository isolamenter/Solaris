import { z } from "zod";
import {
  adaptGeminiModels,
  adaptGeminiOutput,
  geminiImageRequest,
  geminiModelAvailability,
  geminiModelOperationConfig,
} from "./geminiAdapter.js";
import { normalizeBaseUrl, providerCall, UpstreamTransportError, type ProviderTextResponse } from "./http.js";
import { ProviderCallError, type DiscoveredModel, type ImageResult, type ProviderConnection, type ProviderPlugin } from "./types.js";

/**
 * Gemini single-generation adapter (D4: `:generateContent`, no Interactions
 * migration, no Batch and no file upload — PROTOCOL_MATRIX §4 measured none of
 * those surfaces on the configured gateway).
 */

/**
 * The base URL is validated and normalized by the same function the outbound
 * policy uses, so an insecure or malformed URL is rejected at connection
 * create/update (`BASE_URL_INSECURE` / `BASE_URL_INVALID`) instead of being
 * stored and failing at call time.
 */
const schema = z.object({
  baseUrl: z.string().default("https://generativelanguage.googleapis.com").transform((value) => normalizeBaseUrl(value)),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Model discovery is a read-only call, so it may be retried a bounded number of
 * times: it can never have been accepted for processing.
 *
 * A generation POST must never be retried. `unknown` means the request may
 * already have been accepted upstream, and there is no idempotency key to
 * resubmit it safely.
 */
const discoveryAttempts = 3;
const discoveryRetryDelayMs = 150;

function keyPath(path: string, key: string) {
  return `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

/**
 * Classifies a failed call. Only an explicit 4xx is a determinate rejection: a
 * 5xx cannot prove the request was refused, so it is `unknown`.
 *
 * The upstream body is deliberately not included. This message is persisted in
 * the run record and shown to the client, and a gateway error often echoes the
 * request line, which carries the API key in its query string.
 */
function classify(status: number): ProviderCallError {
  if (status >= 400 && status < 500) return new ProviderCallError("rejected", "UPSTREAM_FAILED", `The model service refused the request (HTTP ${status})`);
  return new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", `The model service returned HTTP ${status} and the request may have been accepted`);
}

/**
 * A failure that never reached a verdict on the request, or that Solaris
 * detected itself. A request that was sent may have been accepted, so the
 * outcome is `unknown` and nothing is resubmitted automatically.
 */
function transportFailure(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof UpstreamTransportError) {
    // The request could not even be built: nothing was sent, so nothing can
    // have been accepted. This is determinate — recording it as `uncertain`
    // would claim a request that never left Solaris might be billed.
    if (error.kind === "not-sent") return new ProviderCallError("rejected", "UPSTREAM_FAILED", error.message);
    if (error.kind === "too-large") return new ProviderCallError("unknown", "RESULT_TOO_LARGE", "The model service response exceeded the configured limit");
    if (error.kind === "timeout") return new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "The model service did not finish responding within the Solaris deadline");
    return new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "The model service answered with a redirect, which Solaris does not follow");
  }
  return new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "The model service could not be reached");
}

/** A body we received in full but cannot read is a determinate failure, not an unknown outcome. */
function unreadableResponse(): ProviderCallError {
  return new ProviderCallError("rejected", "UPSTREAM_FAILED", "The model service returned a response Solaris could not read");
}

function parseObject(text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw unreadableResponse();
  }
  if (typeof data !== "object" || data === null) throw unreadableResponse();
  return data as Record<string, unknown>;
}

async function fetchJson(connection: ProviderConnection, path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Record<string, unknown>> {
  let response: ProviderTextResponse;
  try {
    response = await providerCall(connection, path, init);
  } catch (error) {
    throw transportFailure(error);
  }
  if (!response.ok) throw classify(response.status);
  return parseObject(response.text);
}

/**
 * `outputCount` is a Solaris-side retention rule, not an upstream parameter:
 * the protocol has no image-count control, so the count only truncates what was
 * returned. It never triggers an extra call to reach a requested total.
 */
function retentionCount(configured: unknown): number {
  return typeof configured === "number" && Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1;
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const gemini: ProviderPlugin = {
  id: "gemini",
  label: "Google Gemini",
  connectionSchema: schema,
  fields: [{ name: "baseUrl", label: "Base URL", type: "url", placeholder: "https://generativelanguage.googleapis.com", required: true }],
  modelAvailability: geminiModelAvailability,
  modelOperationConfig: geminiModelOperationConfig,
  operations: {
    async imageGenerate(connection: ProviderConnection, input): Promise<ImageResult> {
      const startedAt = Date.now();
      // Model and parameter validation happen before the call: a parameter the
      // model does not expose must fail here, not upstream.
      const request = geminiImageRequest(input.model, input.prompt, input.attachments ?? [], input.parameters);
      const data = await fetchJson(
        connection,
        keyPath(`/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, connection.credential.apiKey),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
      );

      const output = adaptGeminiOutput(data as Parameters<typeof adaptGeminiOutput>[0]);
      const returnedImageCount = output.assets.length;
      if (returnedImageCount === 0) throw new ProviderCallError("rejected", "UPSTREAM_NO_IMAGE", "The model service returned no usable image for this request");

      return {
        images: output.assets.slice(0, retentionCount(input.parameters?.outputCount)),
        returnedImageCount,
        // Safe whitelist only: duration and counts, never the request, the
        // response, or any image byte.
        diagnostics: { durationMs: Date.now() - startedAt, returnedImageCount },
      };
    },
  },
  async discoverModels(connection): Promise<DiscoveredModel[]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const data = await fetchJson(connection, keyPath("/v1beta/models", connection.credential.apiKey), { method: "GET" });
        return adaptGeminiModels(Array.isArray(data.models) ? data.models : []);
      } catch (error) {
        // Only a failure that could not have been accepted is worth retrying.
        const retryable = error instanceof ProviderCallError && error.outcome === "unknown" && attempt < discoveryAttempts;
        if (!retryable) throw error;
        await delay(discoveryRetryDelayMs);
      }
    }
  },
  async testConnection(connection) {
    // Kept non-fatal on an empty list so a reachable service still reports OK.
    const models = await gemini.discoverModels?.(connection);
    return { detail: `${models?.length ?? 0} models available` };
  },
};
