import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoint, normalizeBaseUrl, providerCall, UpstreamTransportError } from "./http.js";
import type { ProviderConnection } from "./types.js";

const connection: ProviderConnection = {
  id: "connection",
  adapterId: "gemini",
  baseUrl: "https://gateway.example",
  config: {},
  credential: { apiKey: "super-secret-key", expiresAt: null },
};

/** Headers arrive immediately; the body sends one chunk and then stalls. */
function stalledBody() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('{"candidates":')) }), { status: 200 });
}

/** A body that never ends, counting how much of it the caller actually pulled. */
function endlessBody(chunkBytes = 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return { response: new Response(stream, { status: 200 }), pulled: () => pulled };
}

const serialized = (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error));

afterEach(() => vi.unstubAllGlobals());

describe("provider endpoint policy", () => {
  it("requires HTTPS provider endpoints", () => {
    expect(() => normalizeBaseUrl("http://127.0.0.1:11434/v1")).toThrow("must use HTTPS");
    expect(() => normalizeBaseUrl("http://provider.example/v1")).toThrow("must use HTTPS");
    expect(() => normalizeBaseUrl("https://provider.example/v1?redirect=x")).toThrow("cannot contain");
    expect(() => normalizeBaseUrl("https://user:pass@provider.example/v1")).toThrow("cannot contain");
    expect(() => normalizeBaseUrl("https://provider.example/v1#frag")).toThrow("cannot contain");
  });

  it("only accepts plugin paths, and never lets a plugin leave the configured origin", () => {
    expect(endpoint(connection, "/v1beta/models")).toBe("https://gateway.example/v1beta/models");
    expect(() => endpoint(connection, "https://elsewhere.example/v1")).toThrow("invalid route");
  });
});

describe("provider call deadline", () => {
  it("keeps one deadline through the body read: a stalled body fails instead of hanging", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stalledBody()));
    const startedAt = Date.now();
    const error = await providerCall(connection, "/v1beta/models/x:generateContent", { method: "POST" }, { timeoutMs: 60 }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UpstreamTransportError);
    expect((error as UpstreamTransportError).kind).toBe("timeout");
    // The headers arrived instantly; only the deadline can end this call.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not let a caller signal extend or bypass the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stalledBody()));
    const never = new AbortController();
    const error = await providerCall(connection, "/v1beta/models", { method: "GET", signal: never.signal }, { timeoutMs: 60 }).catch((thrown: unknown) => thrown);
    expect((error as UpstreamTransportError).kind).toBe("timeout");
  });

  it("lets a caller signal shorten the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stalledBody()));
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    const call = providerCall(connection, "/v1beta/models", { method: "GET", signal: caller.signal }, { timeoutMs: 30_000 });
    caller.abort(reason);
    await expect(call).rejects.toBe(reason);
  });

  it("arms the deadline for the whole call and clears it afterwards", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    await providerCall(connection, "/v1beta/models", { method: "GET" }, { timeoutMs: 30_000 });
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    clearTimeout.mockRestore();
  });
});

describe("provider pre-flight failures", () => {
  it("reports a request that was never sent, and never contacts the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await providerCall({ ...connection, baseUrl: "http://gateway.example" }, "/v1beta/models", { method: "GET" }).catch((thrown: unknown) => thrown);
    expect((error as UpstreamTransportError).kind).toBe("not-sent");
    expect((error as UpstreamTransportError).message).toBe("Provider URLs must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a plugin route that cannot be built, still without sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await providerCall(connection, "https://elsewhere.example/v1", { method: "GET" }).catch((thrown: unknown) => thrown);
    expect((error as UpstreamTransportError).kind).toBe("not-sent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("provider response budget", () => {
  it("refuses an oversized body while streaming, without reading it to the end", async () => {
    const body = endlessBody();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body.response));
    const error = await providerCall(connection, "/v1beta/models", { method: "GET" }, { maxBytes: 2_048 }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UpstreamTransportError);
    expect((error as UpstreamTransportError).kind).toBe("too-large");
    // Memory does not scale with the response: only a few chunks were pulled.
    expect(body.pulled()).toBeLessThan(20);
  });

  it("reads a body that fits the budget", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
    await expect(providerCall(connection, "/v1beta/models", { method: "GET" }, { maxBytes: 1_024 })).resolves.toEqual({ ok: true, status: 200, text: '{"ok":true}' });
  });
});

describe("provider outbound policy", () => {
  it("does not follow a redirect, and never re-sends the request to the target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://elsewhere.example/collect" } }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await providerCall(connection, "/v1beta/models", { method: "GET" }).catch((thrown: unknown) => thrown);

    expect((error as UpstreamTransportError).kind).toBe("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    // The redirect target is not echoed anywhere.
    expect(serialized(error)).not.toContain("elsewhere.example");
  });

  it("carries no URL or credential out of a failed call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await providerCall(connection, "/v1beta/models?key=super-secret-key", { method: "GET" }).catch((thrown: unknown) => thrown);
    expect(serialized(error)).not.toContain("super-secret-key");
    expect(serialized(error)).not.toContain("key=");
  });
});
