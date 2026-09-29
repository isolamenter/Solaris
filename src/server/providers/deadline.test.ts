import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderCallError, type ProviderConnection } from "./types.js";

/**
 * End-to-end proof that the configured upstream budgets reach the provider and
 * that one deadline covers the whole call (CONTRACTS §5, §13).
 *
 * `SOLARIS_UPSTREAM_TIMEOUT_MS` and `SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES` are
 * read when the transport module is imported, so they are set before the
 * dynamic import below (AGENTS.md). `types.ts` carries no configuration and is
 * imported statically.
 */
process.env.SOLARIS_UPSTREAM_TIMEOUT_MS = "120";
process.env.SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES = "4096";

let gemini: typeof import("./gemini.js").gemini;

const connection: ProviderConnection = {
  id: "connection",
  adapterId: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  config: {},
  credential: { apiKey: "test-key", expiresAt: null },
};

beforeAll(async () => {
  ({ gemini } = await import("./gemini.js"));
});

afterAll(() => {
  delete process.env.SOLARIS_UPSTREAM_TIMEOUT_MS;
  delete process.env.SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES;
});

afterEach(() => vi.unstubAllGlobals());

function generate() {
  return gemini.operations.imageGenerate!(connection, {
    model: "gemini-3.1-flash-image",
    prompt: "draw",
    parameters: { aspectRatio: "auto", imageSize: "1K", thinkingLevel: "minimal", googleSearch: false, outputCount: 1 },
  });
}

/** Headers arrive, then the body stalls: only the deadline can end the call. */
const stalledBody = () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"candidates":')) }), { status: 200 });

describe("configured upstream deadline and budget", () => {
  it("fails a generation whose body stalls instead of hanging, and does not resubmit it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stalledBody());
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();
    const error = await generate().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({ outcome: "unknown", errorCode: "UPSTREAM_UNAVAILABLE" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails a generation whose response exceeds the configured byte budget", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(1024)) });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await generate().catch((thrown: unknown) => thrown);
    // Over budget before the body could be parsed: the image count is unknown,
    // so the outcome stays unknown and the run is never resubmitted.
    expect(error).toMatchObject({ outcome: "unknown", errorCode: "RESULT_TOO_LARGE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
