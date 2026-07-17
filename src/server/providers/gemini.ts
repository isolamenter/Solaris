import { z } from "zod";
import { AppError } from "../errors.js";
import { json, providerFetch } from "./http.js";
import { adaptGeminiModels, adaptGeminiOutput, geminiImageRequest, geminiModelAvailability, geminiModelOperationConfig } from "./geminiAdapter.js";
import type { BatchEntryResult, ProviderPlugin } from "./types.js";

const schema = z.object({ baseUrl: z.string().min(1).default("https://generativelanguage.googleapis.com"), config: z.record(z.string(), z.unknown()).optional() });
function keyPath(path: string, key: string) { return `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`; }
async function getModels(profile: Parameters<NonNullable<ProviderPlugin["discoverModels"]>>[0]) { const data = await (await providerFetch(profile, keyPath("/v1beta/models", profile.apiKey), { method: "GET", headers: {} })).json() as { models?: Parameters<typeof adaptGeminiModels>[0] }; return adaptGeminiModels(data.models ?? []); }
export const gemini: ProviderPlugin = {
  id: "gemini", label: "Google Gemini", profileSchema: schema, fields: [{ name: "baseUrl", label: "Base URL", type: "url", placeholder: "https://generativelanguage.googleapis.com", required: true }], discoverModels: getModels,
  modelAvailability: geminiModelAvailability,
  modelOperationConfig: geminiModelOperationConfig,
  async testConnection(profile) { return { detail: `${(await getModels(profile)).length} models available` }; },
  operations: {
    async imageGenerate(profile, input) { const request = geminiImageRequest(input.model, input.prompt, input.attachments ?? [], input.parameters); const response = await providerFetch(profile, keyPath(`/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, profile.apiKey), { method: "POST", headers: { "content-type": "application/json" }, body: json(request) }); const output = adaptGeminiOutput(await response.json() as Parameters<typeof adaptGeminiOutput>[0]); const configuredCount = input.parameters?.outputCount; const outputCount = typeof configuredCount === "number" ? configuredCount : 1; const assets = output.assets.slice(0, outputCount); if (!assets.length) throw new AppError("PROVIDER_RESPONSE", "Gemini returned no inline image data", 502); return { assets, inspector: { request: { path: "/v1beta/models/:model:generateContent", body: request, attachmentCount: input.attachments?.length ?? 0 }, response: { returnedImageCount: output.assets.length, retainedImageCount: assets.length } } }; },
    videoGenerate: {
      async submit(profile, input) { const request = { instances: [{ prompt: input.prompt }], parameters: { ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}), ...(input.size ? { aspectRatio: input.size } : {}) } }; const data = await (await providerFetch(profile, keyPath(`/v1beta/models/${encodeURIComponent(input.model)}:predictLongRunning`, profile.apiKey), { method: "POST", headers: { "content-type": "application/json" }, body: json(request) })).json() as { name?: string }; if (!data.name) throw new AppError("PROVIDER_RESPONSE", "Gemini did not return an operation name", 502); return { remoteId: data.name, inspector: { request: { path: "/v1beta/models/:model:predictLongRunning", body: request } } }; },
      async poll(profile, remoteId) { const data = await (await providerFetch(profile, keyPath(`/v1beta/${remoteId.replace(/^\/+/, "")}`, profile.apiKey), { method: "GET", headers: {} })).json() as { done?: boolean; error?: { message?: string }; response?: { generatedVideos?: { video?: { bytesBase64Encoded?: string; mimeType?: string } }[] } }; if (data.error) return { state: "error", error: data.error.message ?? "Gemini video failed", inspector: { poll: { path: "/v1beta/operations/:id" } } }; if (!data.done) return { state: "pending", inspector: { poll: { path: "/v1beta/operations/:id" } } }; const video = data.response?.generatedVideos?.[0]?.video; if (!video?.bytesBase64Encoded) return { state: "error", error: "Gemini completed without inline video content", inspector: { poll: { path: "/v1beta/operations/:id" } } }; return { state: "success", assets: [{ bytes: Buffer.from(video.bytesBase64Encoded, "base64"), mimeType: video.mimeType ?? "video/mp4" }], inspector: { poll: { path: "/v1beta/operations/:id" } } }; },
    },
    batchGenerate: {
      async submit(profile, input) {
        const inlineRequests = input.requests.map((request) => ({ request: request.request, metadata: { key: request.key } }));
        const payload = { batch: { ...(input.displayName ? { display_name: input.displayName } : {}), input_config: { requests: { requests: inlineRequests } } } };
        const data = await (await providerFetch(profile, keyPath(`/v1beta/models/${encodeURIComponent(input.model)}:batchGenerateContent`, profile.apiKey), { method: "POST", headers: { "content-type": "application/json" }, body: json(payload) })).json() as { name?: string; metadata?: { state?: string } };
        if (!data.name) throw new AppError("PROVIDER_RESPONSE", "Gemini did not return a batch job name", 502);
        return { remoteId: data.name, totalCount: input.requests.length, inspector: { request: { path: "/v1beta/models/:model:batchGenerateContent", body: { batch: { ...payload.batch, input_config: { requests: { requests: inlineRequests.map((req) => ({ ...req, request: "<omitted>" })) } } } } } } };
      },
      async poll(profile, remoteId) {
        const data = await (await providerFetch(profile, keyPath(`/v1beta/${remoteId.replace(/^\/+/, "")}`, profile.apiKey), { method: "GET", headers: {} })).json() as { done?: boolean; error?: { message?: string }; metadata?: { state?: string }; response?: { responsesFile?: string; inlinedResponses?: BatchEntryResult[] } };
        const state = data.metadata?.state ?? (data.done ? "JOB_STATE_SUCCEEDED" : "JOB_STATE_RUNNING");
        const mapped = state === "JOB_STATE_SUCCEEDED" ? "succeeded" : state === "JOB_STATE_FAILED" ? "failed" : state === "JOB_STATE_CANCELLED" ? "cancelled" : state === "JOB_STATE_EXPIRED" ? "expired" : state === "JOB_STATE_PENDING" ? "submitting" : "running";
        if (data.error) return { state: "failed", error: data.error.message ?? "Gemini batch failed", inspector: { poll: { path: "/v1beta/operations/:id", state } } };
        const responseFile = data.response?.responsesFile;
        return { state: mapped, ...(responseFile ? { responseFile } : {}), inspector: { poll: { path: "/v1beta/operations/:id", state } } };
      },
      async cancel(profile, remoteId) { await providerFetch(profile, keyPath(`/v1beta/${remoteId.replace(/^\/+/, "")}:cancel`, profile.apiKey), { method: "POST", headers: {} }); },
      async download(profile, fileName) {
        const response = await providerFetch(profile, `/download/v1beta/${fileName.replace(/^\/+/, "")}:download?alt=media`, { method: "GET", headers: {} });
        const text = await response.text();
        return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => { try { return JSON.parse(line) as BatchEntryResult; } catch { return { error: { message: "Unparseable result line" } }; } });
      },
    },
  },
};
