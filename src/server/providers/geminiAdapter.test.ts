import { describe, expect, it } from "vitest";
import { adaptGeminiModels, adaptGeminiOutput, geminiImageRequest, geminiModelAvailability, geminiModelOperationConfig } from "./geminiAdapter.js";

describe("Gemini adapter", () => {
  it("recognizes gateway preview aliases while keeping unknown image models visible", () => {
    expect(adaptGeminiModels([
      { name: "models/gemini-2.5-flash" },
      { name: "models/gemini-3.1-flash-image-preview" },
      { name: "models/gemini-2.5-flash-image" },
      { name: "models/veo-3.1-generate-preview" },
    ])).toEqual([
      { providerModelId: "gemini-3.1-flash-image-preview", label: undefined, capabilities: ["imageGenerate"] },
      { providerModelId: "gemini-2.5-flash-image", label: undefined, capabilities: [] },
      { providerModelId: "veo-3.1-generate-preview", label: undefined, capabilities: ["videoGenerate"] },
    ]);
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

  it("keeps legacy image models on their original generation config", () => {
    expect(geminiImageRequest("gemini-2.5-flash-image", "draw a cat").generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
    expect(geminiImageRequest("gemini-3.1-flash-image", "draw a cat")).not.toHaveProperty("tools");
  });

  it("publishes strict controls for each adapted stable image model", () => {
    const stable = geminiModelOperationConfig("gemini-3.1-flash-image", "imageGenerate");
    expect(stable?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "thinkingLevel", "googleSearch"]);
    expect(stable?.dto.attachments?.maxCount).toBe(14);
    expect(stable?.dto.warning).toBeUndefined();
    expect(stable?.parseParameters({})).toEqual({ aspectRatio: "auto", imageSize: "1K", thinkingLevel: "minimal", googleSearch: false });
    expect(() => stable?.parseParameters({ imageSize: "8K" })).toThrow();
    expect(() => stable?.parseParameters({ imageSize: "1K", proxyHeader: "unsafe" })).toThrow();

    const pro = geminiModelOperationConfig("gemini-3-pro-image", "imageGenerate");
    expect(pro?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "googleSearch"]);
    expect(pro?.parseParameters({})).toEqual({ aspectRatio: "auto", imageSize: "1K", googleSearch: false });
    expect(() => pro?.parseParameters({ thinkingLevel: "high" })).toThrow();

    const lite = geminiModelOperationConfig("gemini-3.1-flash-lite-image", "imageGenerate");
    expect(lite?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "thinkingLevel"]);
    expect(lite?.parseParameters({})).toEqual({ aspectRatio: "auto", thinkingLevel: "minimal" });
    expect(() => lite?.parseParameters({ googleSearch: true })).toThrow();

    expect(geminiModelOperationConfig("gemini-3.1-flash-image-preview", "imageGenerate")?.dto.warning).toContain("gateway still supports it");
    expect(geminiModelOperationConfig("gemini-3-pro-image-preview", "imageGenerate")?.dto.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "googleSearch"]);
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
