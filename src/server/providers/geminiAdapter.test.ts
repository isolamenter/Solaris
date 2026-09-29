import { describe, expect, it } from "vitest";
import { adaptGeminiModels, adaptGeminiOutput, geminiImageRequest, geminiModelAvailability, geminiModelOperationConfig } from "./geminiAdapter.js";

describe("Gemini adapter", () => {
  it("filters candidates by image name and drops everything else, including video", () => {
    // A gateway returns no capability metadata at all, so discovery only narrows
    // candidates by name. `adapted` (see geminiModelAvailability) is what
    // actually authorizes a run — a candidate capability is not a guarantee.
    expect(adaptGeminiModels([
      { name: "models/gemini-2.5-flash" },
      { name: "models/gemini-3.1-flash-image-preview" },
      { name: "models/gemini-2.5-flash-image" },
      { name: "models/veo-3.1-generate-preview" },
    ])).toEqual([
      { providerModelId: "gemini-3.1-flash-image-preview", label: undefined, capabilities: ["imageGenerate"] },
      { providerModelId: "gemini-2.5-flash-image", label: undefined, capabilities: ["imageGenerate"] },
    ]);
    // Video is out of scope entirely (D5): it is not even a candidate.
    expect(adaptGeminiModels([{ name: "models/veo-3.1-generate-preview" }])).toEqual([]);
  });

  it("treats a candidate as unusable until the allowlist adapts it", () => {
    const [candidate] = adaptGeminiModels([{ name: "models/gemini-2.5-flash-image" }]);
    expect(candidate?.capabilities).toEqual(["imageGenerate"]);
    expect(geminiModelAvailability("gemini-2.5-flash-image")).toMatchObject({ adapted: false });
    expect(geminiModelOperationConfig("gemini-2.5-flash-image", "imageGenerate")).toBeUndefined();
  });

  it("excludes native chat-only models", () => {
    expect(adaptGeminiModels([{ name: "models/gemini-2.5-flash", displayName: "Gemini Flash", supportedGenerationMethods: ["generateContent"] }])).toEqual([]);
  });

  it("adapts image edit input and inline image output", () => {
    expect(geminiImageRequest("gemini-3.1-flash-image", "make it blue", [{ mimeType: "image/png", base64: "c291cmNl", byteSize: 6 }], { aspectRatio: "16:9", imageSize: "4K", thinkingLevel: "high", googleSearch: true })).toEqual({
      contents: [{ role: "user", parts: [{ text: "make it blue" }, { inlineData: { mimeType: "image/png", data: "c291cmNl" } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "4K" }, thinkingConfig: { thinkingLevel: "high" } },
      tools: [{ googleSearch: {} }],
    });
    const output = adaptGeminiOutput({ candidates: [{ content: { parts: [{ text: "done" }, { inlineData: { mimeType: "image/webp", data: "aW1hZ2U=" } }] } }] });
    expect(output.text).toBe("done");
    expect(output.assets).toEqual([{ bytes: Buffer.from("image"), mimeType: "image/webp" }]);
  });

  it("keeps only inline, decodable, image-typed parts as usable assets", () => {
    const parts = [
      { text: "here you go" },
      // A result delivered by URL is not a request target Solaris will fetch.
      { uri: "https://elsewhere.example/result.png" },
      { inlineData: { mimeType: "text/html", data: "aW1hZ2U=" } },
      { inlineData: { mimeType: "image/png", data: "!!!" } },
      { inlineData: { data: "aW1hZ2U=" } },
      { inlineData: { mimeType: "IMAGE/PNG", data: "aW1hZ2U=" } },
    ];
    const output = adaptGeminiOutput({ candidates: [{ content: { parts } }] });
    expect(output.assets).toEqual([{ bytes: Buffer.from("image"), mimeType: "image/png" }]);
    expect(adaptGeminiOutput({ candidates: [{ content: { parts: parts.slice(0, 4) } }] }).assets).toEqual([]);
    expect(adaptGeminiOutput({}).assets).toEqual([]);
  });

  it("ignores fields it does not consume when discovery returns unvalidated JSON", () => {
    expect(adaptGeminiModels([
      { name: 42 as unknown as string },
      { name: "models/gemini-3.1-flash-image", displayName: 7 as unknown as string },
    ])).toEqual([{ providerModelId: "gemini-3.1-flash-image", label: undefined, capabilities: ["imageGenerate"] }]);
  });

  it("keeps legacy image models on their original generation config", () => {
    expect(geminiImageRequest("gemini-2.5-flash-image", "draw a cat").generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
    expect(geminiImageRequest("gemini-3.1-flash-image", "draw a cat")).not.toHaveProperty("tools");
  });

  it("publishes strict controls for each adapted stable image model", () => {
    const stable = geminiModelOperationConfig("gemini-3.1-flash-image", "imageGenerate");
    expect(stable?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "thinkingLevel", "googleSearch", "outputCount"]);
    expect(stable?.dto.attachments?.maxCount).toBe(14);
    expect(stable?.dto.warning).toBeUndefined();
    expect(stable?.parseParameters({})).toEqual({ aspectRatio: "auto", imageSize: "1K", thinkingLevel: "minimal", googleSearch: false, outputCount: 1 });
    expect(stable?.parseParameters({ outputCount: 4 })).toMatchObject({ outputCount: 4 });
    expect(() => stable?.parseParameters({ outputCount: 5 })).toThrow();

    const pro = geminiModelOperationConfig("gemini-3-pro-image", "imageGenerate");
    expect(pro?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "googleSearch", "outputCount"]);
    expect(pro?.parseParameters({})).toEqual({ aspectRatio: "auto", imageSize: "1K", googleSearch: false, outputCount: 1 });
    expect(() => pro?.parseParameters({ thinkingLevel: "high" })).toThrow();

    const lite = geminiModelOperationConfig("gemini-3.1-flash-lite-image", "imageGenerate");
    expect(lite?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "thinkingLevel", "outputCount"]);
    expect(lite?.parseParameters({})).toEqual({ aspectRatio: "auto", thinkingLevel: "minimal", outputCount: 1 });
    expect(() => lite?.parseParameters({ googleSearch: true })).toThrow();

    expect(geminiModelOperationConfig("gemini-3.1-flash-image-preview", "imageGenerate")?.dto.warning).toContain("gateway still supports it");
    expect(geminiModelOperationConfig("gemini-3-pro-image-preview", "imageGenerate")?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "googleSearch", "outputCount"]);
    expect(geminiModelOperationConfig("gemini-2.5-flash-image", "imageGenerate")).toBeUndefined();
    expect(geminiModelAvailability("gemini-3.1-flash-image-preview")).toEqual({ adapted: true });
    expect(geminiModelAvailability("gemini-3-pro-image-preview")).toEqual({ adapted: true });
  });

  it("builds model-specific Pro and Flash Lite requests", () => {
    expect(geminiImageRequest("gemini-3-pro-image", "studio poster", [], { aspectRatio: "16:9", imageSize: "4K", googleSearch: true })).toEqual({
      contents: [{ role: "user", parts: [{ text: "studio poster" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "4K" } },
      tools: [{ googleSearch: {} }],
    });
    expect(geminiImageRequest("gemini-3.1-flash-lite-image", "quick draft", [], { aspectRatio: "1:4", thinkingLevel: "high" })).toEqual({
      contents: [{ role: "user", parts: [{ text: "quick draft" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:4" }, thinkingConfig: { thinkingLevel: "high" } },
    });
  });
});
