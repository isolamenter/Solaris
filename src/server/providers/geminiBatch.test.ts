import { afterEach, describe, expect, it, vi } from "vitest";
import { gemini } from "./gemini.js";

const profile = { id: "profile", pluginId: "gemini" as const, baseUrl: "https://generativelanguage.googleapis.com", config: {}, apiKey: "test-key" };

afterEach(() => vi.unstubAllGlobals());

describe("Gemini batch operations", () => {
  it("submits an inline batch with display_name and metadata keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "batches/abc123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await gemini.operations.batchGenerate!.submit(profile, {
      model: "gemini-3.1-flash-image",
      displayName: "weekly",
      requests: [{ key: "0", request: { contents: [{ parts: [{ text: "hi" }] }] } }, { key: "1", request: { contents: [{ parts: [{ text: "there" }] }] } }],
    });
    expect(result.remoteId).toBe("batches/abc123");
    expect(result.totalCount).toBe(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1beta/models/gemini-3.1-flash-image:batchGenerateContent");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.batch.display_name).toBe("weekly");
    expect(body.batch.input_config.requests.requests).toHaveLength(2);
    expect(body.batch.input_config.requests.requests[0].metadata.key).toBe("0");
  });

  it("polls the operation and maps Gemini state enums to our status union", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: { state: "JOB_STATE_RUNNING" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const poll = await gemini.operations.batchGenerate!.poll(profile, "batches/xyz");
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1beta/batches/xyz");
    expect(poll.state).toBe("running");

    const fileResponse = new Response(JSON.stringify({ metadata: { state: "JOB_STATE_SUCCEEDED" }, response: { responsesFile: "files/abc" } }), { status: 200 });
    fetchMock.mockResolvedValueOnce(fileResponse);
    const ok = await gemini.operations.batchGenerate!.poll(profile, "batches/xyz");
    expect(ok.state).toBe("succeeded");
    expect(ok.responseFile).toBe("files/abc");
  });

  it("parses downloaded batch result lines and falls back for malformed entries", async () => {
    const lines = [
      JSON.stringify({ key: "0", response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1h" } }] } }] } }),
      JSON.stringify({ key: "1", error: { message: "boom" } }),
      "not-json",
      "",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(lines, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const download = await gemini.operations.batchGenerate!.download(profile, "files/abc");
    expect(fetchMock.mock.calls[0]![0]).toContain("/download/v1beta/files/abc:download?alt=media");
    expect(download).toHaveLength(3);
    expect((download[0] as { key?: string }).key).toBe("0");
    expect((download[1] as { error?: { message: string } }).error?.message).toBe("boom");
    expect((download[2] as { error?: { message: string } }).error?.message).toBe("Unparseable result line");
  });

  it("cancels a batch by calling the cancel endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await gemini.operations.batchGenerate!.cancel!(profile, "batches/xyz");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1beta/batches/xyz:cancel");
    expect((init as RequestInit).method).toBe("POST");
  });
});
