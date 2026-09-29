import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequestDto } from "../shared/contracts.js";
import { ApiClientError, SolarisApi } from "./api.js";

function createApi(getToken: () => string | null = () => "session-token") {
  return new SolarisApi({ baseUrl: "http://127.0.0.1:3210", getToken });
}

function firstCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(0);
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

const request: GenerationRequestDto = {
  connectionId: "c1",
  modelId: "m1",
  prompt: "a lighthouse at dusk",
  parameters: { aspectRatio: "16:9" },
  submissionId: "sub-1",
  contentDigest: "digest-1",
};

describe("SolarisApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a relative base URL", () => {
    expect(() => new SolarisApi({ baseUrl: "/api", getToken: () => null })).toThrow(/absolute/);
  });

  it("always calls an absolute Server URL with the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await createApi().listConnections();

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://127.0.0.1:3210/api/connections");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-token");
  });

  it("sends no authorization header when signed out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await createApi(() => null).getDeployment();

    const [, init] = firstCall(fetchMock);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("does not declare a JSON body for a body-less POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, at: "2026-09-29T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    await createApi().testConnection("c1");

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://127.0.0.1:3210/api/connections/c1/test");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    expect(init.body).toBeUndefined();
  });

  it("passes pagination as query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await createApi().listRuns({ limit: 30, cursor: "abc" });

    const [url] = firstCall(fetchMock);
    expect(url).toBe("http://127.0.0.1:3210/api/runs?limit=30&cursor=abc");
  });

  it("parses the canonical error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: { code: "NOT_FOUND", message: "No such connection" } }, { status: 404 }),
      ),
    );

    const error: unknown = await createApi()
      .listModels("c1")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: "NOT_FOUND", message: "No such connection", status: 404, envelope: true });
  });

  it("reports a non-envelope failure as an unknown outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })));

    const error: unknown = await createApi()
      .listRuns()
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "HTTP_ERROR", envelope: false, status: 502 });
  });

  it("sends the request as a text field and references as file parts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ submissionId: "sub-1", status: "success", run: null, result: { kind: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createApi().submitGeneration({
      request,
      references: [
        { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
        { mimeType: "image/jpeg", bytes: new Uint8Array([4]) },
      ],
    });

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://127.0.0.1:3210/api/generations");
    const form = init.body as FormData;
    expect(form.get("request")).toBe(JSON.stringify(request));
    const parts = form.getAll("reference") as File[];
    expect(parts.map((part) => part.name)).toEqual(["reference-1", "reference-2"]);
    expect(parts.map((part) => part.type)).toEqual(["image/png", "image/jpeg"]);
    // The browser owns the multipart boundary.
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });
});
