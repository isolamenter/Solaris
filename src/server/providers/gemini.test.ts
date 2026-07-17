import { afterEach, describe, expect, it, vi } from "vitest";
import { gemini } from "./gemini.js";

const profile = { id: "profile", pluginId: "gemini" as const, baseUrl: "https://generativelanguage.googleapis.com", config: {}, apiKey: "test-key" };
const parameters = { aspectRatio: "16:9", imageSize: "2K", thinkingLevel: "high", googleSearch: true, outputCount: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("Gemini 3.1 image requests", () => {
  it("maps image creation controls into generationConfig", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] }), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    await gemini.operations.imageGenerate!(profile, { model: "gemini-3.1-flash-image", prompt: "draw", parameters });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" }, thinkingConfig: { thinkingLevel: "high" } });
    expect(request.tools).toEqual([{ googleSearch: {} }]);
  });

  it("maps multiple edit references", async () => {
    const imageResponse = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] }); const fetchMock = vi.fn().mockResolvedValue(new Response(imageResponse, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const attachments = [{ mimeType: "image/png", base64: "b25l", byteSize: 3 }, { mimeType: "image/jpeg", base64: "dHdv", byteSize: 3 }];
    const edit = await gemini.operations.imageGenerate!(profile, { model: "gemini-3.1-flash-image", prompt: "combine", attachments, parameters });
    expect((edit.inspector.request as { attachmentCount: number }).attachmentCount).toBe(2);
    const editRequest = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(editRequest.contents[0].parts).toHaveLength(3);
    expect(editRequest.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
    expect(editRequest.tools).toEqual([{ googleSearch: {} }]);
  });

  it("limits multiple returned images to the selected count", async () => {
    const parts = ["b25l", "dHdv", "dGhyZWU="].map((data) => ({ inlineData: { mimeType: "image/png", data } }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const result = await gemini.operations.imageGenerate!(profile, { model: "gemini-3.1-flash-image", prompt: "draw", parameters: { ...parameters, outputCount: 2 } });
    expect(result.assets).toHaveLength(2);
    expect(result.inspector.response).toEqual({ returnedImageCount: 3, retainedImageCount: 2 });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.generationConfig).not.toHaveProperty("outputCount");
  });
});
