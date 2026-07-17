import { randomUUID } from "node:crypto";
import type { AssetStore } from "./assets.js";
import { AppError, toAppError } from "./errors.js";
import { env } from "./env.js";
import { configuredModel, pluginFor } from "./providers/index.js";
import { normalizeBaseUrl } from "./providers/http.js";
import type { Attachment, OperationParameters, ProviderModelOperationConfig, ProviderProfile } from "./providers/types.js";
import type { Repository } from "./repository.js";
import { decryptSecret, encryptSecret, redact } from "./vault.js";
import type { AttachmentPolicyDto, Capability, ModelDto, Operation, ProviderId } from "../shared/contracts.js";

export class SolarisService {
  constructor(private readonly repo: Repository, private readonly assets: AssetStore) {}
  providerProfile(profileId: string): ProviderProfile {
    const row = this.repo.getProfileRaw(profileId); const pluginId = row.plugin_id; return { id: row.id, pluginId, baseUrl: row.base_url, config: JSON.parse(row.config_json) as Record<string, unknown>, apiKey: decryptSecret(row.key_encrypted, row.id, env.masterKey) };
  }
  private assertModel(profileId: string, modelId: string, operation: Operation) {
    const profile = this.repo.getProfile(profileId); if (!profile.enabled) throw new AppError("PROFILE_DISABLED", "Connection is disabled", 409);
    const model = this.configured(this.repo.getModelForProfile(profileId, modelId));
    if (!model.adapted) throw new AppError("MODEL_NOT_ADAPTED", model.availabilityMessage ?? "This model is not adapted for Solaris and cannot be used", 400);
    if (!model.enabled || !model.capabilities.includes(operation as Capability)) throw new AppError("OPERATION_UNAVAILABLE", "This model has not been enabled for this operation", 400);
    return model;
  }
  private configured(model: ModelDto) { return configuredModel(model, this.repo.getProfile(model.profileId).pluginId); }
  listModels(profileId: string) { return this.repo.listModels(profileId).map((model) => this.configured(model)); }
  private operationConfig(profileId: string, model: ModelDto, operation: Capability): ProviderModelOperationConfig | undefined { return pluginFor(this.repo.getProfile(profileId).pluginId).modelOperationConfig?.(model.providerModelId, operation); }
  private parameters(profileId: string, model: ModelDto, operation: Capability, value: unknown): OperationParameters {
    const config = this.operationConfig(profileId, model, operation);
    if (config) return config.parseParameters(value ?? {});
    if (value && typeof value === "object" && Object.keys(value).length) throw new AppError("PARAMETERS_UNAVAILABLE", "This model does not expose configurable parameters for this operation", 400);
    return {};
  }
  private attachments(ids: string[] | undefined): Attachment[] { return (ids ?? []).map((id) => { const file = this.assets.read(id); return { mimeType: file.row.mime_type, base64: file.bytes.toString("base64"), byteSize: file.bytes.byteLength }; }); }
  private validatedAttachments(ids: string[] | undefined, policy?: AttachmentPolicyDto) {
    const attachments = this.attachments(ids);
    if (!policy) return attachments;
    if (attachments.length > policy.maxCount) throw new AppError("ASSET_COUNT", `This model accepts at most ${policy.maxCount} reference images`, 400);
    const invalid = attachments.find((attachment) => !policy.accept.includes(attachment.mimeType));
    if (invalid) throw new AppError("ASSET_TYPE", `Reference images must be ${policy.accept.map((type) => type.replace("image/", "").toUpperCase()).join(", ")}`, 415);
    const oversized = attachments.find((attachment) => attachment.byteSize > policy.maxFileBytes);
    if (oversized) throw new AppError("ASSET_SIZE", `Each reference image must be ${Math.floor(policy.maxFileBytes / 1024 / 1024)} MB or smaller`, 413);
    const total = attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0);
    if (total > policy.maxTotalBytes) throw new AppError("ASSET_TOTAL_SIZE", `Reference images must total ${Math.floor(policy.maxTotalBytes / 1024 / 1024)} MB or less`, 413);
    return attachments;
  }
  createProfile(input: { name: string; pluginId: ProviderId; baseUrl: string; config?: Record<string, unknown>; apiKey: string }) {
    const plugin = pluginFor(input.pluginId); const parsed = plugin.profileSchema.parse({ baseUrl: input.baseUrl, config: input.config ?? {} }); const id = randomUUID();
    return this.repo.createProfile({ id, name: input.name.trim(), pluginId: input.pluginId, baseUrl: normalizeBaseUrl(parsed.baseUrl), config: parsed.config ?? {}, keyEncrypted: encryptSecret(input.apiKey, id, env.masterKey) });
  }
  updateProfile(id: string, input: { name: string; baseUrl: string; config?: Record<string, unknown>; enabled: boolean; apiKey?: string }) { const current = this.repo.getProfile(id); const parsed = pluginFor(current.pluginId).profileSchema.parse({ baseUrl: input.baseUrl, config: input.config ?? {} }); return this.repo.updateProfile(id, { name: input.name.trim(), baseUrl: normalizeBaseUrl(parsed.baseUrl), config: parsed.config ?? {}, enabled: input.enabled, keyEncrypted: input.apiKey ? encryptSecret(input.apiKey, id, env.masterKey) : undefined }); }
  async testProfile(id: string) { try { const result = await pluginFor(this.repo.getProfile(id).pluginId).testConnection(this.providerProfile(id)); return this.repo.setProfileTest(id, { ok: true, at: new Date().toISOString(), detail: result.detail }); } catch (error) { const safe = toAppError(error); this.repo.setProfileTest(id, { ok: false, at: new Date().toISOString(), detail: safe.message }); throw safe; } }
  async refreshModels(profileId: string) { const profile = this.repo.getProfile(profileId); const discover = pluginFor(profile.pluginId).discoverModels; if (!discover) throw new AppError("MODEL_DISCOVERY_UNAVAILABLE", "This provider does not offer model discovery", 400); const discovered = await discover(this.providerProfile(profileId)); this.repo.replaceDiscoveredModels(profileId, discovered); return this.listModels(profileId); }
  addModel(input: { profileId: string; providerModelId: string; label?: string; capabilities: Capability[] }) { return this.configured(this.repo.upsertModel({ ...input, providerModelId: input.providerModelId.trim(), label: input.label?.trim() || input.providerModelId.trim(), manual: true })); }
  upload(bytes: Buffer, mimeType: string) { return this.assets.save(bytes, mimeType); }
  async createImageRun(input: { profileId: string; modelId: string; prompt: string; size?: string; assetIds?: string[]; parameters?: Record<string, unknown> }) { const model = this.assertModel(input.profileId, input.modelId, "imageGenerate"); const config = this.operationConfig(input.profileId, model, "imageGenerate"); const assetCount = input.assetIds?.length ?? 0; if (assetCount && !config?.dto.attachments) throw new AppError("OPERATION_ATTACHMENT_MISMATCH", "This model does not support reference images", 400); const parameters = this.parameters(input.profileId, model, "imageGenerate", input.parameters); const attachments = this.validatedAttachments(input.assetIds, config?.dto.attachments); const operation: Extract<Operation, "imageGenerate" | "imageEdit"> = assetCount ? "imageEdit" : "imageGenerate"; const storedInput = { ...input, parameters }; const run = this.repo.createRun({ profileId: input.profileId, modelId: input.modelId, operation, status: "running", input: storedInput }); try { const plugin = pluginFor(this.repo.getProfile(input.profileId).pluginId); const providerOperation = assetCount ? plugin.operations.imageEdit : plugin.operations.imageGenerate; if (!providerOperation) throw new AppError("OPERATION_UNAVAILABLE", assetCount ? "This provider does not support reference images" : "This provider does not implement image generation", 400); const result = await providerOperation(this.providerProfile(input.profileId), { model: model.providerModelId, prompt: input.prompt, size: input.size, attachments, parameters }); const assets = result.assets.map((asset) => this.assets.save(asset.bytes, asset.mimeType)); this.repo.linkAssets(run.id, assets); return this.repo.finishRun(run.id, "success", { assetCount: assets.length }, redact(result.inspector) as Record<string, unknown>); } catch (error) { const safe = toAppError(error); return this.repo.finishRun(run.id, "error", null, null, { code: safe.code, message: safe.message }); } }
  createVideoRun(input: { profileId: string; modelId: string; prompt: string; durationSeconds?: number; size?: string }) { this.assertModel(input.profileId, input.modelId, "videoGenerate"); const plugin = pluginFor(this.repo.getProfile(input.profileId).pluginId); if (!plugin.operations.videoGenerate) throw new AppError("OPERATION_UNAVAILABLE", "This provider does not implement video generation", 400); const run = this.repo.createRun({ profileId: input.profileId, modelId: input.modelId, operation: "videoGenerate", status: "queued", input }); this.repo.createJob(run.id); return run; }
  async cancelRun(id: string) { const run = this.repo.getRun(id); if (run.operation !== "videoGenerate") return this.repo.finishRun(id, "cancelled", null, run.inspector); const job = this.repo.getJobRawForRun(id); this.repo.cancelJob(id); const plugin = pluginFor(this.repo.getProfile(run.profileId).pluginId); if (job.remote_id && plugin.operations.videoGenerate?.cancel) { try { await plugin.operations.videoGenerate.cancel(this.providerProfile(run.profileId), job.remote_id); } catch { /* local cancellation remains authoritative */ } } return this.repo.finishRun(id, "cancelled", null, run.inspector); }
}
