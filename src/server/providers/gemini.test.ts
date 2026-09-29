import { afterEach, describe, expect, it, vi } from "vitest";
import { gemini } from "./gemini.js";
import { ProviderCallError, type ProviderConnection } from "./types.js";

const connection: ProviderConnection = {
  id: "connection",
  adapterId: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  config: {},
  credential: { apiKey: "test-key", expiresAt: null },
};
const parameters = { aspectRatio: "16:9", imageSize: "2K", thinkingLevel: "high", googleSearch: true, outputCount: 1 };
const generate = (input: Parameters<NonNullable<typeof gemini.operations.imageGenerate>>[1] = { model: "gemini-3.1-flash-image", prompt: "draw", parameters }) =>
  gemini.operations.imageGenerate!(connection, input);

const imageResponse = (parts: { text?: string; inlineData?: { mimeType?: string; data?: string }; uri?: string }[]) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 });

const serialized = (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error));

afterEach(() => vi.unstubAllGlobals());

describe("Gemini 3.1 image requests", () => {
  it("maps image creation controls into generationConfig", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse([{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }]));
    vi.stubGlobal("fetch", fetchMock);
    await generate();
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" }, thinkingConfig: { thinkingLevel: "high" } });
    expect(request.tools).toEqual([{ googleSearch: {} }]);
  });

  it("calls the single-generation route only, with no Batch, Files or Interactions request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse([{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }]));
    vi.stubGlobal("fetch", fetchMock);
    await generate();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=test-key");
  });

  it("maps multiple edit references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse([{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }]));
    vi.stubGlobal("fetch", fetchMock);
    const attachments = [{ mimeType: "image/png", base64: "b25l", byteSize: 3 }, { mimeType: "image/jpeg", base64: "dHdv", byteSize: 3 }];
    await generate({ model: "gemini-3.1-flash-image", prompt: "combine", attachments, parameters });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.contents[0].parts).toHaveLength(3);
    expect(request.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
    expect(request.tools).toEqual([{ googleSearch: {} }]);
  });

  it("truncates returned images to the selected count and reports both numbers without calling upstream again", async () => {
    const parts = ["b25l", "dHdv", "dGhyZWU="].map((data) => ({ inlineData: { mimeType: "image/png", data } }));
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(parts));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generate({ model: "gemini-3.1-flash-image", prompt: "draw", parameters: { ...parameters, outputCount: 4 } });
    expect(result.images).toHaveLength(3);
    // Upstream returned 3; the retention rule asked for 4 and kept 4 at most.
    // This is a Solaris-side truncation, not an upstream parameter, and it never
    // turns into extra calls to reach the requested count.
    expect(result.returnedImageCount).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.generationConfig).not.toHaveProperty("outputCount");
  });

  it("keeps the result to the safe whitelist and never returns the raw body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse([{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generate();
    expect(Object.keys(result).sort()).toEqual(["diagnostics", "images", "returnedImageCount"]);
    expect(Object.keys(result.diagnostics).sort()).toEqual(["durationMs", "returnedImageCount"]);
    expect(serialized(result.diagnostics)).not.toContain("aW1hZ2U=");
  });
});

describe("Gemini outcome classification", () => {
  it("classifies an explicit 4xx as a determinate rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    await expect(generate()).rejects.toMatchObject({ name: "ProviderCallError", outcome: "rejected", errorCode: "UPSTREAM_FAILED" });
  });

  it("classifies a 5xx as unknown so the caller never auto-resubmits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate()).rejects.toMatchObject({ name: "ProviderCallError", outcome: "unknown", errorCode: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a generation POST after a transport failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate()).rejects.toMatchObject({ name: "ProviderCallError", outcome: "unknown", errorCode: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a 200 with no usable image as a determinate failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse([{ inlineData: undefined }])));
    await expect(generate()).rejects.toMatchObject({ outcome: "rejected", errorCode: "UPSTREAM_NO_IMAGE" });
  });

  it("does not treat a non-image MIME type or an empty decode as a usable image", async () => {
    for (const parts of [
      [{ inlineData: { mimeType: "text/html", data: "aW1hZ2U=" } }],
      [{ inlineData: { mimeType: "image/png", data: "!!!" } }],
      [{ inlineData: { data: "aW1hZ2U=" } }],
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(imageResponse(parts));
      vi.stubGlobal("fetch", fetchMock);
      await expect(generate()).rejects.toMatchObject({ outcome: "rejected", errorCode: "UPSTREAM_NO_IMAGE" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("never fetches an upstream-supplied result URL", async () => {
    // `delivery: "uri"` points at a host Solaris will not request, and the part
    // carries no inline bytes, so there is no usable image.
    const fetchMock = vi.fn().mockResolvedValue(imageResponse([{ uri: "https://elsewhere.example/result.png" }]));
    vi.stubGlobal("fetch", fetchMock);
    const error = await generate().catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ outcome: "rejected", errorCode: "UPSTREAM_NO_IMAGE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(serialized(error)).not.toContain("elsewhere.example");
  });

  it("treats a complete but unreadable body as a determinate failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 })));
    const error = await generate().catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ outcome: "rejected", errorCode: "UPSTREAM_FAILED" });
    expect(serialized(error)).not.toContain("nope");
  });
});

describe("Gemini credentials and diagnostics", () => {
  it("never leaks the API key or an upstream body into the surfaced error", async () => {
    // A gateway error often echoes the request line, which carries the key.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied for key=test-key (secret-key)", { status: 403 })));
    const error = (await generate().catch((thrown: unknown) => thrown)) as ProviderCallError;
    expect(serialized(error)).not.toContain("test-key");
    expect(serialized(error)).not.toContain("key=");
    expect(serialized(error)).not.toContain("denied");
    expect(error.message).toBe("The model service refused the request (HTTP 403)");
  });

  it("carries only the frozen outcome, code and message on a failed call", async () => {
    // No raw body, no URL, no
    // original exception: the error object itself is the whole public surface.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("key=test-key rejected", { status: 400 })));
    const error = (await generate().catch((thrown: unknown) => thrown)) as ProviderCallError;
    const ownProperties = Object.getOwnPropertyNames(error).filter((name) => name !== "stack").sort();
    expect(ownProperties).toEqual(["errorCode", "message", "name", "outcome"]);
  });

  it("classifies an unusable base URL as a determinate failure, never as uncertain", async () => {
    // Such a URL cannot be stored through the API any more (see the connection
    // schema tests), so this is the boundary guard for a row that bypassed it.
    // Reporting it as `unknown` would claim a request that never left Solaris
    // may have been accepted and billed.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await gemini.operations.imageGenerate!({ ...connection, baseUrl: "http://gateway.example" }, { model: "gemini-3.1-flash-image", prompt: "draw", parameters })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "ProviderCallError", outcome: "rejected", errorCode: "UPSTREAM_FAILED" });
    expect((error as ProviderCallError).message).toContain("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a local URL problem instead of claiming the service was unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const error = await gemini.discoverModels!({ ...connection, baseUrl: "not a url" }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ outcome: "rejected", errorCode: "UPSTREAM_FAILED" });
    expect((error as ProviderCallError).message).toBe("Base URL must be a valid absolute URL");
  });

  it("fails an unknown parameter before any upstream call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate({ model: "gemini-3.1-flash-image", prompt: "draw", parameters: { ...parameters, surprise: true } })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Gemini connection schema", () => {
  const failure = (input: unknown) => {
    try {
      gemini.connectionSchema.parse(input);
      return undefined;
    } catch (thrown: unknown) {
      return thrown as { code?: string; statusCode?: number };
    }
  };

  it("normalizes a usable base URL and defaults it when absent", () => {
    expect(gemini.connectionSchema.parse({ baseUrl: "https://gateway.example/v1/" }).baseUrl).toBe("https://gateway.example/v1");
    expect(gemini.connectionSchema.parse({ baseUrl: "https://gateway.example" }).baseUrl).toBe("https://gateway.example");
    expect(gemini.connectionSchema.parse({}).baseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("refuses to store an insecure or malformed base URL", () => {
    // Rejected at create/update with the frozen 400 codes instead of being
    // stored and only failing when a generation is attempted.
    expect(failure({ baseUrl: "http://gateway.example" })).toMatchObject({ code: "BASE_URL_INSECURE", statusCode: 400 });
    expect(failure({ baseUrl: "not a url" })).toMatchObject({ code: "BASE_URL_INVALID", statusCode: 400 });
    expect(failure({ baseUrl: "https://user:secret@gateway.example/v1" })).toMatchObject({ code: "BASE_URL_INVALID", statusCode: 400 });
    expect(failure({ baseUrl: "https://gateway.example/v1?key=secret" })).toMatchObject({ code: "BASE_URL_INVALID", statusCode: 400 });
    expect(failure({ baseUrl: "https://gateway.example/v1#frag" })).toMatchObject({ code: "BASE_URL_INVALID", statusCode: 400 });
    expect(failure({ baseUrl: "" })).toMatchObject({ code: "BASE_URL_INVALID", statusCode: 400 });
  });
});

describe("Gemini model discovery", () => {
  const models = new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-image" }] }), { status: 200 });

  it("retries a read-only call a bounded number of times before succeeding", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(models);
    vi.stubGlobal("fetch", fetchMock);
    await expect(gemini.discoverModels!(connection)).resolves.toEqual([{ providerModelId: "gemini-3.1-flash-image", label: undefined, capabilities: ["imageGenerate"] }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a determinate rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gemini.discoverModels!(connection)).rejects.toMatchObject({ outcome: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the bounded attempt count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gemini.discoverModels!(connection)).rejects.toMatchObject({ outcome: "unknown", errorCode: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a reachable service even when it lists no image model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }), { status: 200 })));
    await expect(gemini.testConnection(connection)).resolves.toEqual({ detail: "0 models available" });
  });
});
