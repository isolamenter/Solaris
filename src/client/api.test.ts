import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

describe("api request headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not declare JSON for an empty POST body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/empty", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledWith("/api/empty", expect.objectContaining({ headers: {} }));
  });

  it("declares JSON when a request body is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/json", { method: "POST", body: JSON.stringify({ value: 1 }) });

    expect(fetchMock).toHaveBeenCalledWith("/api/json", expect.objectContaining({ headers: { "content-type": "application/json" } }));
  });
});
