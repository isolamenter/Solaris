import { randomUUID } from "node:crypto";
import type { AssetStore } from "./assets.js";
import { AppError, toAppError } from "./errors.js";
import { env } from "./env.js";
import { configuredModel, pluginFor } from "./providers/index.js";
import { normalizeBaseUrl } from "./providers/http.js";
import { adaptGeminiOutput, geminiBatchRequest } from "./providers/geminiAdapter.js";
import type { Attachment, BatchInlineRequest, OperationParameters, ProviderModelOperationConfig, ProviderPlugin, ProviderProfile } from "./providers/types.js";
import type { Repository } from "./repository.js";
import { decryptSecret, encryptSecret, redact } from "./vault.js";
import type { AttachmentPolicyDto, BatchEntryDto, BatchJobDto, BatchJobStatus, Capability, ModelDto, Operation, ProviderId } from "../shared/contracts.js";

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
  async createImageRun(input: { profileId: string; modelId: string; prompt: string; size?: string; assetIds?: string[]; parameters?: Record<string, unknown> }) { const model = this.assertModel(input.profileId, input.modelId, "imageGenerate"); const config = this.operationConfig(input.profileId, model, "imageGenerate"); const assetCount = input.assetIds?.length ?? 0; if (assetCount && !config?.dto.attachments) throw new AppError("OPERATION_ATTACHMENT_MISMATCH", "This model does not support reference images", 400); const parameters = this.parameters(input.profileId, model, "imageGenerate", input.parameters); const attachments = this.validatedAttachments(input.assetIds, config?.dto.attachments); const storedInput = { ...input, parameters }; const run = this.repo.createRun({ profileId: input.profileId, modelId: input.modelId, operation: "imageGenerate", status: "running", input: storedInput }); try { const plugin = pluginFor(this.repo.getProfile(input.profileId).pluginId); const providerOperation = plugin.operations.imageGenerate; if (!providerOperation) throw new AppError("OPERATION_UNAVAILABLE", "This provider does not implement image generation", 400); const result = await providerOperation(this.providerProfile(input.profileId), { model: model.providerModelId, prompt: input.prompt, size: input.size, attachments, parameters }); const assets = result.assets.map((asset) => this.assets.save(asset.bytes, asset.mimeType)); this.repo.linkAssets(run.id, assets); return this.repo.finishRun(run.id, "success", { assetCount: assets.length }, redact(result.inspector) as Record<string, unknown>); } catch (error) { const safe = toAppError(error); return this.repo.finishRun(run.id, "error", null, null, { code: safe.code, message: safe.message }); } }
  createVideoRun(input: { profileId: string; modelId: string; prompt: string; durationSeconds?: number; size?: string }) { this.assertModel(input.profileId, input.modelId, "videoGenerate"); const plugin = pluginFor(this.repo.getProfile(input.profileId).pluginId); if (!plugin.operations.videoGenerate) throw new AppError("OPERATION_UNAVAILABLE", "This provider does not implement video generation", 400); const run = this.repo.createRun({ profileId: input.profileId, modelId: input.modelId, operation: "videoGenerate", status: "queued", input }); this.repo.createJob(run.id); return run; }
  async cancelRun(id: string) { const run = this.repo.getRun(id); if (run.operation !== "videoGenerate") return this.repo.finishRun(id, "cancelled", null, run.inspector); const job = this.repo.getJobRawForRun(id); this.repo.cancelJob(id); const plugin = pluginFor(this.repo.getProfile(run.profileId).pluginId); if (job.remote_id && plugin.operations.videoGenerate?.cancel) { try { await plugin.operations.videoGenerate.cancel(this.providerProfile(run.profileId), job.remote_id); } catch { /* local cancellation remains authoritative */ } } return this.repo.finishRun(id, "cancelled", null, run.inspector); }

  private assertAdaptedModel(profileId: string, modelId: string, operation: Capability): ModelDto {
    return this.assertModel(profileId, modelId, operation);
  }
  createBatchJob(input: { profileId: string; modelId: string; displayName?: string }) {
    const profile = this.repo.getProfile(input.profileId);
    if (!profile.enabled) throw new AppError("PROFILE_DISABLED", "Connection is disabled", 409);
    const model = this.assertAdaptedModel(input.profileId, input.modelId, "imageGenerate");
    const displayName = input.displayName?.trim() || `batch-${Date.now()}`;
    return this.repo.createBatchJob({ id: randomUUID(), profileId: input.profileId, modelId: input.modelId, providerModelId: model.providerModelId, displayName });
  }
  addBatchEntry(input: { batchJobId: string; prompt: string; parameters?: Record<string, unknown>; assetIds?: string[] }) {
    const job = this.repo.getBatchJob(input.batchJobId);
    if (job.status !== "draft") throw new AppError("BATCH_LOCKED", "Batch entries can only be added while the job is in draft", 409);
    const model = this.assertAdaptedModel(job.profileId, job.modelId, "imageGenerate");
    const config = this.operationConfig(job.profileId, model, "imageGenerate");
    if ((input.assetIds?.length ?? 0) && !config?.dto.attachments) throw new AppError("OPERATION_ATTACHMENT_MISMATCH", "This model does not support reference images", 400);
    const parameters = this.parameters(job.profileId, model, "imageGenerate", input.parameters);
    this.validatedAttachments(input.assetIds, config?.dto.attachments);
    return this.repo.addBatchEntry({ id: randomUUID(), batchJobId: input.batchJobId, prompt: input.prompt, parameters: parameters as unknown as Record<string, unknown>, assetIds: input.assetIds ?? [], modelId: job.modelId });
  }
  private buildBatchInlineRequests(job: BatchJobDto): { requests: BatchInlineRequest[]; bytesEstimate: number } {
    const model = this.repo.getModel(job.modelId);
    const config = this.operationConfig(job.profileId, model, "imageGenerate");
    const attachmentsPolicy = config?.dto.attachments;
    const requests: BatchInlineRequest[] = [];
    let bytesEstimate = 0;
    for (const entry of job.entries) {
      const attachments = attachmentsPolicy ? this.validatedAttachments(entry.assetIds, attachmentsPolicy) : [];
      const params = config?.parseParameters(entry.parameters ?? {}) as unknown as OperationParameters;
      const inlineRequest = geminiBatchRequest(model.providerModelId, entry.prompt, attachments, params);
      requests.push({ key: String(entry.index), request: inlineRequest });
      bytesEstimate += JSON.stringify(inlineRequest).length;
    }
    return { requests, bytesEstimate };
  }
  estimateBatchJsonlBytes(job: BatchJobDto): { bytes: number; entries: number; exceeds: boolean } {
    const model = this.repo.getModel(job.modelId);
    const policy = this.operationConfig(job.profileId, model, "imageGenerate")?.dto.attachments;
    const perEntry = Buffer.byteLength(job.entries[0]?.prompt ?? "", "utf8") + 512;
    let totalBytes = 0;
    for (const entry of job.entries) {
      const refs = policy ? this.attachments(entry.assetIds) : [];
      totalBytes += perEntry + refs.reduce((sum, ref) => sum + Math.ceil(ref.byteSize * 4 / 3), 0);
    }
    return { bytes: totalBytes, entries: job.entries.length, exceeds: totalBytes > 20 * 1024 * 1024 };
  }
  previewBatchJsonl(jobId: string): string {
    const job = this.repo.getBatchJob(jobId);
    if (job.status !== "draft") throw new AppError("BATCH_LOCKED", "JSONL preview is only available while the job is in draft", 409);
    const model = this.repo.getModel(job.modelId);
    const config = this.operationConfig(job.profileId, model, "imageGenerate");
    const attachmentsPolicy = config?.dto.attachments;
    const lines: string[] = [];
    for (const entry of job.entries) {
      const attachments = attachmentsPolicy ? this.attachments(entry.assetIds) : [];
      const params = config?.parseParameters(entry.parameters ?? {}) as unknown as OperationParameters;
      const inlineRequest = geminiBatchRequest(model.providerModelId, entry.prompt, attachments, params);
      lines.push(JSON.stringify({ key: String(entry.index), request: inlineRequest }));
    }
    return lines.join("\n");
  }
  async submitBatchJob(id: string) {
    const job = this.repo.getBatchJob(id);
    if (job.status !== "draft") throw new AppError("BATCH_LOCKED", "Batch job is no longer in draft", 409);
    if (!job.entries.length) throw new AppError("BATCH_EMPTY", "Add at least one entry before submitting", 400);
    const estimate = this.estimateBatchJsonlBytes(job);
    if (estimate.exceeds) throw new AppError("BATCH_TOO_LARGE", `Batch payload exceeds Gemini's 20MB inline limit (estimated ${Math.ceil(estimate.bytes / 1024)} KB)`, 413);
    const plugin = pluginFor(this.repo.getProfile(job.profileId).pluginId);
    const batch = plugin.operations.batchGenerate;
    if (!batch) throw new AppError("OPERATION_UNAVAILABLE", "This provider does not implement batch generation", 400);
    const built = this.buildBatchInlineRequests(job);
    this.repo.setBatchJobStatus(job.id, "submitting", { inspector: { requestsPreview: built.requests.map((req) => ({ key: req.key, request: "<omitted>" })) } });
    try {
      const result = await batch.submit(this.providerProfile(job.profileId), { model: this.repo.getModel(job.modelId).providerModelId, requests: built.requests, displayName: job.displayName });
      this.repo.setBatchJobStatus(job.id, "running", { remoteId: result.remoteId, inspector: redact(result.inspector) as Record<string, unknown>, submittedCount: job.entries.length });
      return this.repo.getBatchJob(job.id);
    } catch (error) {
      const safe = toAppError(error);
      this.repo.setBatchJobStatus(job.id, "failed", { error: { code: safe.code, message: safe.message } });
      throw safe;
    }
  }
  async cancelBatchJob(id: string) {
    const job = this.repo.getBatchJob(id);
    if (!["draft", "submitting", "running"].includes(job.status)) throw new AppError("BATCH_LOCKED", "This batch can no longer be cancelled", 409);
    if (job.remoteId) {
      const plugin = pluginFor(this.repo.getProfile(job.profileId).pluginId);
      try { await plugin.operations.batchGenerate?.cancel?.(this.providerProfile(job.profileId), job.remoteId); } catch { /* local cancellation remains authoritative */ }
    }
    this.repo.setBatchJobStatus(job.id, "cancelled");
    for (const entry of job.entries) this.repo.setBatchEntryStatus(entry.id, entry.runId ? "success" : "pending");
    return this.repo.getBatchJob(id);
  }
  deleteBatchJob(id: string) { this.repo.deleteBatchJob(id); }
  deleteBatchEntry(entryId: string) { this.repo.deleteBatchEntry(entryId); }
  listBatchJobs() { return this.repo.listBatchJobs(); }
  getBatchJob(id: string) { return this.repo.getBatchJob(id); }
  async processBatchJob(job: BatchJobDto): Promise<BatchJobDto> {
    const plugin = pluginFor(this.repo.getProfile(job.profileId).pluginId);
    const batch = plugin.operations.batchGenerate;
    if (!batch) throw new AppError("OPERATION_UNAVAILABLE", "This provider does not implement batch generation", 400);
    const current = this.repo.getBatchJob(job.id);
    if (!current.remoteId) throw new AppError("BATCH_NOT_SUBMITTED", "Batch job has not been submitted", 409);
    if (current.status !== "running" && current.status !== "submitting") return current;
    const poll = await batch.poll(this.providerProfile(current.profileId), current.remoteId);
    this.repo.setBatchJobStatus(current.id, poll.state as BatchJobStatus, { inspector: redact(poll.inspector) as Record<string, unknown> });
    if (poll.state === "failed" || poll.state === "cancelled" || poll.state === "expired") {
      this.repo.setBatchJobStatus(current.id, poll.state, { error: poll.error ? { code: "BATCH_FAILED", message: poll.error } : null });
      return this.repo.getBatchJob(current.id);
    }
    if (poll.state !== "succeeded" || !poll.responseFile) return this.repo.getBatchJob(current.id);
    const results = await batch.download(this.providerProfile(current.profileId), poll.responseFile);
    return this.materializeBatchResults(current.id, results);
  }
  private materializeBatchResults(batchJobId: string, results: Awaited<ReturnType<NonNullable<NonNullable<ProviderPlugin["operations"]["batchGenerate"]>["download"]>>>): BatchJobDto {
    const job = this.repo.getBatchJob(batchJobId);
    const model = this.repo.getModel(job.modelId);
    const byIndex = new Map<string, BatchEntryDto>(job.entries.map((entry) => [String(entry.index), entry]));
    let succeeded = 0;
    let failed = 0;
    for (const result of results) {
      const key = result.key ?? "";
      const entry = byIndex.get(key);
      if (!entry) continue;
      if (result.error) {
        failed += 1;
        this.repo.setBatchEntryStatus(entry.id, "error", { error: { code: "BATCH_ENTRY_FAILED", message: result.error.message ?? "Provider returned an error for this request" } });
        this.repo.createRun({ profileId: job.profileId, modelId: job.modelId, operation: "imageGenerate", status: "error", input: { batchJobId: job.id, batchEntryId: entry.id, prompt: entry.prompt, parameters: entry.parameters, assetIds: entry.assetIds } });
        continue;
      }
      const adapted = adaptGeminiOutput(result.response as Parameters<typeof adaptGeminiOutput>[0]);
      const params = this.parameters(job.profileId, model, "imageGenerate", entry.parameters);
      const configuredCount = (params as Record<string, unknown>).outputCount;
      const outputCount = typeof configuredCount === "number" ? configuredCount : 1;
      const assets = adapted.assets.slice(0, outputCount);
      if (!assets.length) {
        failed += 1;
        this.repo.setBatchEntryStatus(entry.id, "error", { error: { code: "NO_INLINE_IMAGE", message: "Provider returned no inline image data" } });
        this.repo.createRun({ profileId: job.profileId, modelId: job.modelId, operation: "imageGenerate", status: "error", input: { batchJobId: job.id, batchEntryId: entry.id, prompt: entry.prompt, parameters: entry.parameters, assetIds: entry.assetIds } });
        continue;
      }
      const run = this.repo.createRun({ profileId: job.profileId, modelId: job.modelId, operation: "imageGenerate", status: "success", input: { batchJobId: job.id, batchEntryId: entry.id, prompt: entry.prompt, parameters: entry.parameters, assetIds: entry.assetIds } });
      const saved = assets.map((asset) => this.assets.save(asset.bytes, asset.mimeType));
      this.repo.linkAssets(run.id, saved);
      this.repo.finishRun(run.id, "success", { assetCount: saved.length }, { batch: { key, responsePreview: "<inline image omitted>" } });
      this.repo.setBatchEntryStatus(entry.id, "success", { runId: run.id });
      succeeded += 1;
    }
    this.repo.setBatchJobStatus(batchJobId, "succeeded", { succeededCount: succeeded, failedCount: failed });
    return this.repo.getBatchJob(batchJobId);
  }
}
