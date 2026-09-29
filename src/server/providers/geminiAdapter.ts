import { z } from "zod";
import type { ModelOperationConfigDto, Operation, ParameterValues } from "../../shared/contracts.js";
import type { Attachment, DiscoveredModel, ProviderModelOperationConfig } from "./types.js";

export type GeminiModelRecord = {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
};

const isImageModel = (id: string) => /(?:^|[-_.])(image|imagen)(?:$|[-_.])/i.test(id);

/**
 * Image types Solaris can deliver, and therefore the only ones it accepts as
 * references or treats as a usable upstream result.
 */
const imageMimeTypes: string[] = ["image/png", "image/jpeg", "image/webp"];
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
const attachmentPolicy = (description: string) => ({ accept: imageMimeTypes, maxCount: 14, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 14 * 1024 * 1024, description });

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

const modelConfigs: Record<AdaptedGeminiImageModel, { dto: ModelOperationConfigDto; schema: z.ZodType<ParameterValues> }> = {
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
  if (adaptedImageModel(model)) return { adapted: true };
  return { adapted: false, message: "This Gemini model has not been adapted for Solaris and cannot be used." };
}

export function geminiModelOperationConfig(model: string, operation: Operation): ProviderModelOperationConfig | undefined {
  const adapted = adaptedImageModel(model);
  if (!adapted || operation !== "imageGenerate") return undefined;
  const config = modelConfigs[adapted];
  return { dto: { ...config.dto, ...(model.toLowerCase().endsWith("-preview") ? { warning: retiredPreviewWarning } : {}) }, parseParameters: (value) => config.schema.parse(value ?? {}) };
}

/**
 * Discovers candidate models.
 *
 * A gateway returns no capability metadata at all
 * (`supportedGenerationMethods` is null for every model), so this only narrows
 * candidates by name. Usability is decided by the curated allowlist in
 * `geminiModelAvailability`; a name match never authorizes a run.
 */
export function adaptGeminiModels(models: GeminiModelRecord[]): DiscoveredModel[] {
  return models.flatMap((model) => {
    // Discovery reads unvalidated JSON, so each field is used only in the shape
    // it is supposed to have.
    const providerModelId = typeof model.name === "string" ? model.name.replace(/^models\//, "") : undefined;
    if (!providerModelId) return [];
    if (!isImageModel(providerModelId)) return [];

    const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    const capabilityIsCandidate = methods.length === 0 || methods.includes("generateContent");
    const capabilities: Operation[] = capabilityIsCandidate ? ["imageGenerate"] : [];

    return [{ providerModelId, label: typeof model.displayName === "string" ? model.displayName : undefined, capabilities }];
  });
}

export function geminiParts(prompt: string, attachments: Attachment[] = []) {
  return [{ text: prompt }, ...attachments.map((attachment) => ({ inlineData: { mimeType: attachment.mimeType, data: attachment.base64 } }))];
}

export function geminiImageGenerationConfig(model: string, parameters: ParameterValues = {}) {
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

export function geminiImageRequest(model: string, prompt: string, attachments: Attachment[] = [], parameters: ParameterValues = {}) {
  const adapted = adaptedImageModel(model);
  const parsed = adapted ? modelConfigs[adapted].schema.parse(parameters) : undefined;
  return {
    contents: [{ role: "user", parts: geminiParts(prompt, attachments) }],
    generationConfig: geminiImageGenerationConfig(model, parameters),
    ...(parsed?.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
}

/**
 * Reads the parts of a completed response.
 *
 * Only inline base64 image data is a usable asset:
 * - `delivery: "uri"` results are ignored. An upstream-supplied URL is not a
 *   request target Solaris will fetch, and the host and lifetime of such a URL
 *   are undocumented (PROTOCOL_MATRIX §2.1).
 * - a part whose MIME type is not an image Solaris can deliver is not an image.
 *   The declared type is used as given rather than guessed from the bytes, and
 *   base64 that decodes to nothing is not an image either.
 * A response in which nothing survives these rules has no usable image, which
 * the caller reports as a determinate failure.
 */
function imageAsset(part: { inlineData?: { mimeType?: string; data?: string } }) {
  const inline = part.inlineData;
  if (!inline?.data) return undefined;
  const mimeType = (inline.mimeType ?? "").toLowerCase();
  if (!imageMimeTypes.includes(mimeType)) return undefined;
  const bytes = Buffer.from(inline.data, "base64");
  if (bytes.byteLength === 0) return undefined;
  return { bytes, mimeType };
}

export function adaptGeminiOutput(data: { candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] } }[] }) {
  const parts = data.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  return {
    text: parts.map((part) => part.text ?? "").join(""),
    assets: parts.flatMap((part) => {
      const asset = imageAsset(part);
      return asset ? [asset] : [];
    }),
  };
}
