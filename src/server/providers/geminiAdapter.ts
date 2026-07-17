import { z } from "zod";
import type { Capability, ModelOperationConfigDto } from "../../shared/contracts.js";
import type { Attachment, DiscoveredModel, OperationParameters, ProviderModelOperationConfig } from "./types.js";

export type GeminiModelRecord = {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
};

const isImageModel = (id: string) => /(?:^|[-_.])(image|imagen)(?:$|[-_.])/i.test(id);
const isVideoModel = (id: string) => /(?:^|[-_.])veo(?:$|[-_.])/i.test(id);
type AdaptedGeminiImageModel = "gemini-3.1-flash-image" | "gemini-3-pro-image" | "gemini-3.1-flash-lite-image";
const geminiImageModelAliases: Record<string, AdaptedGeminiImageModel> = {
  "gemini-3.1-flash-image": "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
  "gemini-3-pro-image": "gemini-3-pro-image",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image": "gemini-3.1-flash-lite-image",
};
const adaptedImageModel = (id: string): AdaptedGeminiImageModel | undefined => geminiImageModelAliases[id.toLowerCase()];
const retiredPreviewWarning = "Google retired this preview ID on June 25, 2026. Use it only while your gateway still supports it.";

export const geminiImageAspectRatios = ["1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const geminiProImageAspectRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const geminiImageSizes = ["512", "1K", "2K", "4K"] as const;
export const geminiProImageSizes = ["1K", "2K", "4K"] as const;
export const geminiThinkingLevels = ["minimal", "high"] as const;
const aspectRatioParameter = (ratios: readonly string[]) => ({ key: "aspectRatio", label: "Aspect ratio", type: "enum" as const, default: "auto", description: "Auto follows a reference image, or uses Gemini's square default.", options: [{ label: "Auto", value: "auto" }, ...ratios.map((value) => ({ label: value, value }))] });
const thinkingParameter = { key: "thinkingLevel", label: "Thinking", type: "enum" as const, default: "minimal", description: "Higher thinking can improve difficult compositions but adds latency.", options: [{ label: "Fast", value: "minimal", detail: "Minimal" }, { label: "High quality", value: "high", detail: "High" }] };
const googleSearchParameter = { key: "googleSearch", label: "Google Search", type: "boolean" as const, default: false, description: "Ground the image in current Google Search results." };
const attachmentPolicy = (description: string) => ({ accept: ["image/jpeg", "image/png", "image/webp"], maxCount: 14, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 14 * 1024 * 1024, description });

const outputCountParameter = { key: "outputCount", label: "Images", type: "enum" as const, default: 1, description: "Keep up to this many images when Gemini returns multiple results.", options: [1, 2, 3, 4].map((value) => ({ label: String(value), value })) };

const flashParameters = z.object({
  aspectRatio: z.enum(["auto", ...geminiImageAspectRatios]).default("auto"),
  imageSize: z.enum(geminiImageSizes).default("1K"),
  thinkingLevel: z.enum(geminiThinkingLevels).default("minimal"),
  googleSearch: z.boolean().default(false),
  outputCount: z.number().int().min(1).max(4).default(1),
}).strict();
const proParameters = z.object({ aspectRatio: z.enum(["auto", ...geminiProImageAspectRatios]).default("auto"), imageSize: z.enum(geminiProImageSizes).default("1K"), googleSearch: z.boolean().default(false), outputCount: z.number().int().min(1).max(4).default(1) }).strict();
const flashLiteParameters = z.object({ aspectRatio: z.enum(["auto", ...geminiImageAspectRatios]).default("auto"), thinkingLevel: z.enum(geminiThinkingLevels).default("minimal"), outputCount: z.number().int().min(1).max(4).default(1) }).strict();

const modelConfigs: Record<AdaptedGeminiImageModel, { dto: ModelOperationConfigDto; schema: z.ZodType<OperationParameters> }> = {
  "gemini-3.1-flash-image": {
    schema: flashParameters,
    dto: { parameters: [aspectRatioParameter(geminiImageAspectRatios), { key: "imageSize", label: "Resolution", type: "enum", default: "1K", options: geminiImageSizes.map((value) => ({ label: value === "512" ? "512 px" : value, value })) }, thinkingParameter, googleSearchParameter, outputCountParameter], attachments: attachmentPolicy("Up to 14 references; best fidelity with up to 10 objects and 4 characters.") },
  },
  "gemini-3-pro-image": {
    schema: proParameters,
    dto: { parameters: [aspectRatioParameter(geminiProImageAspectRatios), { key: "imageSize", label: "Resolution", type: "enum", default: "1K", options: geminiProImageSizes.map((value) => ({ label: value, value })) }, googleSearchParameter, outputCountParameter], attachments: attachmentPolicy("Up to 14 references; best fidelity with up to 6 objects, 5 characters, and 3 style images.") },
  },
  "gemini-3.1-flash-lite-image": {
    schema: flashLiteParameters,
    dto: { parameters: [aspectRatioParameter(geminiImageAspectRatios), thinkingParameter, outputCountParameter], attachments: attachmentPolicy("Up to 14 references. This efficiency model is best suited to simpler, single-pass edits.") },
  },
};

export function geminiModelAvailability(model: string) {
  if (adaptedImageModel(model) || isVideoModel(model)) return { adapted: true };
  return { adapted: false, message: "This Gemini model has not been adapted for Solaris and cannot be used." };
}

export function geminiModelOperationConfig(model: string, operation: Capability): ProviderModelOperationConfig | undefined {
  const adapted = adaptedImageModel(model);
  if (!adapted || operation !== "imageGenerate") return undefined;
  const config = modelConfigs[adapted];
  return { dto: { ...config.dto, ...(model.toLowerCase().endsWith("-preview") ? { warning: retiredPreviewWarning } : {}) }, parseParameters: (value) => config.schema.parse(value ?? {}) };
}

export function adaptGeminiModels(models: GeminiModelRecord[]): DiscoveredModel[] {
  return models.flatMap((model) => {
    const providerModelId = model.name?.replace(/^models\//, "");
    if (!providerModelId) return [];

    const methods = model.supportedGenerationMethods ?? [];
    const inferCapabilities = methods.length === 0;
    const capabilities: Capability[] = [];

    if (adaptedImageModel(providerModelId) && (inferCapabilities || methods.includes("generateContent"))) capabilities.push("imageGenerate");
    if (isVideoModel(providerModelId) && (inferCapabilities || methods.includes("predictLongRunning"))) capabilities.push("videoGenerate");

    return isImageModel(providerModelId) || isVideoModel(providerModelId) ? [{ providerModelId, label: model.displayName, capabilities }] : [];
  });
}

export function geminiParts(prompt: string, attachments: Attachment[] = []) {
  return [{ text: prompt }, ...attachments.map((attachment) => ({ inlineData: { mimeType: attachment.mimeType, data: attachment.base64 } }))];
}

export function geminiImageGenerationConfig(model: string, parameters: OperationParameters = {}) {
  const adapted = adaptedImageModel(model);
  if (!adapted) return { responseModalities: ["TEXT", "IMAGE"] };
  const parsed = modelConfigs[adapted].schema.parse(parameters);
  return {
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: {
      ...(parsed.aspectRatio === "auto" ? {} : { aspectRatio: parsed.aspectRatio }),
      ...(adapted === "gemini-3.1-flash-lite-image" ? {} : { imageSize: parsed.imageSize }),
    },
    ...("thinkingLevel" in parsed ? { thinkingConfig: { thinkingLevel: parsed.thinkingLevel } } : {}),
  };
}

export function geminiImageRequest(model: string, prompt: string, attachments: Attachment[] = [], parameters: OperationParameters = {}) {
  const adapted = adaptedImageModel(model);
  const parsed = adapted ? modelConfigs[adapted].schema.parse(parameters) : undefined;
  return {
    contents: [{ role: "user", parts: geminiParts(prompt, attachments) }],
    generationConfig: geminiImageGenerationConfig(model, parameters),
    ...(parsed?.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
}

export function adaptGeminiOutput(data: { candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] } }[] }) {
  const parts = data.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  return {
    text: parts.map((part) => part.text ?? "").join(""),
    assets: parts.flatMap((part) => part.inlineData?.data ? [{ bytes: Buffer.from(part.inlineData.data, "base64"), mimeType: part.inlineData.mimeType ?? "image/png" }] : []),
  };
}
