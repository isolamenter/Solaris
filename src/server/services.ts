import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { contentDigest, sha256Hex, type DigestReference } from "../shared/digest.js";
import type {
  AdapterDto, AdapterId, ConnectionDto, ConnectionTestDto, GeneratedImageDto, GenerationResponseDto, GenerationResultDto,
  ModelDto, Operation, ParameterValues, RunDto, RunImageRefDto, RunPageDto, RunStatus,
} from "../shared/contracts.js";
import type { ConnectionRow, CredentialSource, CredentialVault, ModelRow, ReceiptRow, Repository, RunRow } from "./interfaces.js";
import { adapterDtos, configuredModel, pluginFor } from "./providers/index.js";
import type { ProviderConnection } from "./providers/types.js";
import { ProviderCallError } from "./providers/types.js";
import type { ResultCache } from "./resultCache.js";

export type ReferenceInput = { mimeType: string; bytes: Buffer };

export type GenerateInput = {
  connectionId: string;
  modelId: string;
  prompt: string;
  parameters?: ParameterValues;
  submissionId: string;
  contentDigest: string;
  references: ReferenceInput[];
};

export type ServiceConfig = {
  /** Delivery budget for one response (CONTRACTS §4.2). */
  imageResultMaxBytes: number;
};

const toRunDto = (row: RunRow): RunDto => ({
  id: row.id, connectionId: row.connectionId, connectionName: row.connectionName, modelId: row.modelId,
  providerModelId: row.providerModelId, operation: row.operation, status: row.status, prompt: row.prompt,
  parameters: row.parameters, referenceCount: row.referenceCount, returnedImageCount: row.returnedImageCount,
  retainedImageCount: row.retainedImageCount, images: row.images, error: row.error,
  createdAt: row.createdAt, updatedAt: row.updatedAt,
});

export class SolarisService {
  /** Run ids currently inside an upstream call; never reaped while in flight. */
  private readonly active = new Set<string>();

  constructor(
    private readonly repo: Repository,
    private readonly credentials: CredentialSource,
    private readonly vault: CredentialVault,
    private readonly cache: ResultCache,
    private readonly config: ServiceConfig,
  ) {}

  // -- catalog -------------------------------------------------------------

  listAdapters(): AdapterDto[] {
    return adapterDtos();
  }

  private connectionDto(row: ConnectionRow): ConnectionDto {
    return {
      id: row.id, name: row.name, adapterId: row.adapterId, baseUrl: row.baseUrl, config: row.config,
      enabled: row.enabled, hasKey: Boolean(row.keyEncrypted), lastTest: row.lastTest,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  /** Read-time derived fields; `operationConfigs` and `adapted` are never persisted. */
  private configured(row: ModelRow, adapterId: AdapterId): ModelDto {
    return configuredModel({
      id: row.id, connectionId: row.connectionId, providerModelId: row.providerModelId, label: row.label,
      capabilities: row.capabilities, operationConfigs: {}, adapted: true, manual: row.manual,
      enabled: row.enabled, createdAt: row.createdAt,
    }, adapterId);
  }

  private modelDto(row: ModelRow): ModelDto {
    return this.configured(row, this.repo.getConnection(row.userId, row.connectionId).adapterId);
  }

  listConnections(userId: string): ConnectionDto[] {
    return this.repo.listConnections(userId).map((row) => this.connectionDto(row));
  }

  createConnection(userId: string, input: { name: string; adapterId: ConnectionDto["adapterId"]; baseUrl: string; config?: Record<string, unknown>; apiKey: string }, id = randomUUID()): ConnectionDto {
    const plugin = pluginFor(input.adapterId);
    const parsed = plugin.connectionSchema.parse({ baseUrl: input.baseUrl, config: input.config ?? {} });
    const row = this.repo.createConnection({
      userId, id, name: input.name, adapterId: input.adapterId, baseUrl: parsed.baseUrl,
      config: parsed.config ?? {}, keyEncrypted: this.vault.encrypt(input.apiKey, userId, id),
    });
    return this.connectionDto(row);
  }

  updateConnection(userId: string, connectionId: string, input: { name: string; baseUrl: string; config?: Record<string, unknown>; enabled: boolean; apiKey?: string }): ConnectionDto {
    const current = this.repo.getConnection(userId, connectionId);
    const parsed = pluginFor(current.adapterId).connectionSchema.parse({ baseUrl: input.baseUrl, config: input.config ?? {} });
    const row = this.repo.updateConnection(userId, connectionId, {
      name: input.name, baseUrl: parsed.baseUrl, config: parsed.config ?? {}, enabled: input.enabled,
      keyEncrypted: input.apiKey ? this.vault.encrypt(input.apiKey, userId, connectionId) : undefined,
    });
    return this.connectionDto(row);
  }

  deleteConnection(userId: string, connectionId: string): void {
    this.repo.deleteConnection(userId, connectionId);
  }

  async testConnection(userId: string, connectionId: string): Promise<ConnectionTestDto> {
    const connection = this.repo.getConnection(userId, connectionId);
    const at = new Date().toISOString();
    try {
      const result = await pluginFor(connection.adapterId).testConnection(await this.providerConnection(connection));
      const test: ConnectionTestDto = { ok: true, at, detail: result.detail };
      this.repo.recordConnectionTest(userId, connectionId, test);
      return test;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed";
      this.repo.recordConnectionTest(userId, connectionId, { ok: false, at, detail: message });
      throw error;
    }
  }

  async listModels(userId: string, connectionId: string): Promise<ModelDto[]> {
    return this.repo.listModels(userId, connectionId).map((row) => this.modelDto(row));
  }

  async refreshModels(userId: string, connectionId: string): Promise<ModelDto[]> {
    const connection = this.repo.getConnection(userId, connectionId);
    const plugin = pluginFor(connection.adapterId);
    if (!plugin.discoverModels) throw new AppError("OPERATION_UNAVAILABLE", "This adapter does not offer model discovery", 400);
    const discovered = await plugin.discoverModels(await this.providerConnection(connection));
    this.repo.replaceDiscoveredModels(userId, connectionId, discovered);
    return this.listModels(userId, connectionId);
  }

  async addModel(userId: string, connectionId: string, input: { providerModelId: string; label?: string; capabilities: Operation[] }): Promise<ModelDto> {
    const row = this.repo.upsertModel({
      userId, connectionId, providerModelId: input.providerModelId, label: input.label,
      capabilities: input.capabilities, manual: true,
    });
    return this.modelDto(row);
  }

  deleteModel(userId: string, connectionId: string, modelId: string): void {
    this.repo.deleteModel(userId, connectionId, modelId);
  }

  // -- history -------------------------------------------------------------

  getRun(userId: string, runId: string): RunDto {
    return toRunDto(this.repo.getRun(userId, runId));
  }

  listRuns(userId: string, page: { limit: number; cursor?: string }): RunPageDto {
    const result = this.repo.listRuns(userId, page);
    return { items: result.items.map(toRunDto), nextCursor: result.nextCursor };
  }

  deleteRun(userId: string, runId: string): void {
    const { submissionId } = this.repo.deleteRun(userId, runId);
    // History is gone, so the delivery cache must not keep serving it.
    this.cache.clear(userId, submissionId);
  }

  // -- lifecycle -----------------------------------------------------------

  /** Startup: a single process owns the data directory, so nothing is in flight. */
  recoverAbandonedRuns(): string[] {
    return this.repo.recoverAbandonedRuns();
  }

  /** Periodic sweep. Active calls are excluded so a slow call is never reaped. */
  reapStaleRuns(before: string): string[] {
    return this.repo.reapStaleRuns({ before, excludeRunIds: [...this.active] });
  }

  // -- generation ----------------------------------------------------------

  async generate(userId: string, input: GenerateInput): Promise<GenerationResponseDto> {
    // A replay is answered from the receipt before any current resource is
    // consulted (CONTRACTS §6.1): a connection that has since been deleted or
    // disabled must not turn a replay into a new upstream call. The digest is
    // recomputed from the bytes actually received and never taken from the
    // client's claim, so reusing a submission id for different content is still
    // the conflict §6.3 requires — the client that reuses an id is exactly the
    // one whose declared digest may be stale.
    const existing = this.repo.getReceipt(userId, input.submissionId);
    if (existing) return this.replay(userId, existing, await this.digestOf(input));

    const { connection, model, parameters } = this.validate(userId, input);
    const digest = await this.digestOf(input);
    if (digest !== input.contentDigest) {
      throw new AppError("DIGEST_MISMATCH", "The submitted content digest does not match the request", 400);
    }
    // Resolved before the run is claimed: an operation the adapter does not
    // implement is a pre-execution failure, and must not leave a `running` row
    // behind for a call that was never made.
    const operation = pluginFor(connection.adapterId).operations.imageGenerate;
    if (!operation) throw new AppError("OPERATION_UNAVAILABLE", "This adapter does not implement image generation", 400);
    const resolved = await this.credentials.resolve({ userId, connectionId: input.connectionId });

    const runId = randomUUID();
    const claim = this.repo.claimRun({
      userId, id: runId, submissionId: input.submissionId, contentDigest: digest,
      connectionId: connection.id, connectionName: connection.name, modelId: model.id,
      providerModelId: model.providerModelId, prompt: input.prompt,
      parameters, referenceCount: input.references.length,
    });
    // Lost the race: another request owns this submission, and this one must not
    // reach upstream.
    if (!claim.claimed) return this.replay(userId, claim.receipt, digest);

    this.active.add(runId);
    try {
      const result = await operation(
        { id: connection.id, adapterId: connection.adapterId, baseUrl: connection.baseUrl, config: connection.config, credential: resolved },
        { model: model.providerModelId, prompt: input.prompt, attachments: input.references.map((r) => ({ mimeType: r.mimeType, base64: r.bytes.toString("base64"), byteSize: r.bytes.byteLength })), parameters },
      );
      return this.deliver(userId, input.submissionId, runId, result.images, result.returnedImageCount);
    } catch (error) {
      return this.recordFailure(userId, input.submissionId, runId, error);
    } finally {
      this.active.delete(runId);
    }
  }

  /** Canonical digest of the raw input as received (CONTRACTS §6.1). */
  private async digestOf(input: GenerateInput): Promise<string> {
    const references: DigestReference[] = [];
    for (const reference of input.references) {
      references.push({ mimeType: reference.mimeType.toLowerCase(), sha256: await sha256Hex(reference.bytes) });
    }
    return contentDigest({
      connectionId: input.connectionId, modelId: input.modelId, prompt: input.prompt,
      parameters: input.parameters ?? null, references,
    });
  }

  /**
   * Everything a run needs from the current resources. Parameters are defaulted
   * here — after the digest, which is computed from the raw input — and the
   * defaulted values are what the run snapshots.
   */
  private validate(userId: string, input: GenerateInput): { connection: ConnectionRow; model: ModelRow; parameters: ParameterValues } {
    const connection = this.repo.getConnection(userId, input.connectionId);
    if (!connection.enabled) throw new AppError("CONNECTION_DISABLED", "This connection is disabled", 409);
    const plugin = pluginFor(connection.adapterId);
    const model = this.repo.getModelForConnection(userId, input.connectionId, input.modelId);
    const configured = this.configured(model, connection.adapterId);
    if (!configured.adapted) throw new AppError("MODEL_NOT_ADAPTED", configured.availabilityMessage ?? "This model is not adapted for Solaris", 400);
    if (!configured.enabled || !configured.capabilities.includes("imageGenerate")) {
      throw new AppError("OPERATION_UNAVAILABLE", "This model is not enabled for image generation", 400);
    }

    const config = plugin.modelOperationConfig?.(model.providerModelId, "imageGenerate");
    if (!config && input.parameters && Object.keys(input.parameters).length) {
      throw new AppError("PARAMETERS_UNAVAILABLE", "This model does not expose configurable parameters", 400);
    }
    const parameters = config ? config.parseParameters(input.parameters ?? {}) : {};
    this.validateReferences(input.references, config?.dto.attachments);
    return { connection, model, parameters };
  }

  private validateReferences(references: ReferenceInput[], policy?: { accept: string[]; maxCount: number; maxFileBytes: number; maxTotalBytes: number }) {
    if (references.length === 0) return;
    if (!policy) throw new AppError("REFERENCE_COUNT", "This model does not support reference images", 400);
    if (references.length > policy.maxCount) throw new AppError("REFERENCE_COUNT", `This model accepts at most ${policy.maxCount} reference images`, 400);
    const invalid = references.find((reference) => !policy.accept.includes(reference.mimeType.toLowerCase()));
    if (invalid) throw new AppError("REFERENCE_TYPE", `Reference images must be ${policy.accept.map((type) => type.replace("image/", "").toUpperCase()).join(", ")}`, 415);
    const oversized = references.find((reference) => reference.bytes.byteLength > policy.maxFileBytes);
    if (oversized) throw new AppError("REFERENCE_SIZE", `Each reference image must be ${Math.floor(policy.maxFileBytes / 1024 / 1024)} MB or smaller`, 413);
    const total = references.reduce((sum, reference) => sum + reference.bytes.byteLength, 0);
    if (total > policy.maxTotalBytes) throw new AppError("REFERENCE_TOTAL_SIZE", `Reference images must total ${Math.floor(policy.maxTotalBytes / 1024 / 1024)} MB or less`, 413);
  }

  private deliver(userId: string, submissionId: string, runId: string, images: { bytes: Buffer; mimeType: string }[], returnedImageCount: number): GenerationResponseDto {
    const refs: RunImageRefDto[] = images.map((image) => ({ mimeType: image.mimeType, byteSize: image.bytes.byteLength }));
    const total = refs.reduce((sum, image) => sum + image.byteSize, 0);

    // Generated successfully but too large to hand back: the generation stands,
    // the delivery does not. Downgrading it to `error` would claim the model
    // produced nothing.
    if (total > this.config.imageResultMaxBytes) {
      const run = this.repo.finishRun(userId, runId, {
        status: "success", images: refs, returnedImageCount, retainedImageCount: images.length,
      });
      return this.response(submissionId, run, { kind: "unavailable", reason: "result-too-large" });
    }

    const delivered: GeneratedImageDto[] = images.map((image) => ({ mimeType: image.mimeType, byteSize: image.bytes.byteLength, dataBase64: image.bytes.toString("base64") }));
    // Published before the run is marked success, so a replay in this process
    // can never observe `success` with the bytes not yet available.
    this.cache.publish(userId, submissionId, delivered);
    const run = this.repo.finishRun(userId, runId, {
      status: "success", images: refs, returnedImageCount, retainedImageCount: images.length,
    });
    return this.response(submissionId, run, { kind: "delivered", images: delivered });
  }

  private recordFailure(userId: string, submissionId: string, runId: string, error: unknown): GenerationResponseDto {
    if (!(error instanceof ProviderCallError)) throw error;
    // `unknown` means the request may have been accepted: terminal, never retried.
    const status: Extract<RunStatus, "error" | "uncertain"> = error.outcome === "unknown" ? "uncertain" : "error";
    const reason: Extract<GenerationResultDto, { kind: "unavailable" }>["reason"] =
      error.outcome === "unknown" ? (error.errorCode === "RESULT_TOO_LARGE" ? "result-too-large" : "submission-unknown") : "not-generated";
    const run = this.repo.finishRun(userId, runId, {
      status, images: [], returnedImageCount: null, retainedImageCount: null,
      error: { code: error.errorCode, message: error.message },
    });
    return this.response(submissionId, run, { kind: "unavailable", reason });
  }

  private response(submissionId: string, row: RunRow, result: GenerationResultDto): GenerationResponseDto {
    return { submissionId, status: row.status, run: toRunDto(row), result };
  }

  /**
   * CONTRACTS §6.2. `digest` is the digest recomputed from the received bytes,
   * never the client's declared one, so a reused submission id carrying
   * different content is a conflict here too.
   */
  private replay(userId: string, receipt: ReceiptRow, digest: string): GenerationResponseDto {
    if (receipt.contentDigest !== digest) {
      throw new AppError("SUBMISSION_CONFLICT", "This submission id was already used with different content", 409);
    }
    if (receipt.historyDeleted) {
      return { submissionId: receipt.submissionId, status: receipt.status, run: null, result: { kind: "unavailable", reason: "history-deleted" } };
    }
    const run = this.repo.getRun(userId, receipt.runId);
    const dto = toRunDto(run);
    switch (receipt.status) {
      case "running":
        return { submissionId: receipt.submissionId, status: "running", run: dto, result: { kind: "pending" } };
      case "success": {
        const images = this.cache.get(userId, receipt.submissionId);
        return { submissionId: receipt.submissionId, status: "success", run: dto, result: images ? { kind: "delivered", images } : { kind: "unavailable", reason: "cache-miss" } };
      }
      case "error":
        return { submissionId: receipt.submissionId, status: "error", run: dto, result: { kind: "unavailable", reason: "not-generated" } };
      case "uncertain":
        return { submissionId: receipt.submissionId, status: "uncertain", run: dto, result: { kind: "unavailable", reason: "submission-unknown" } };
    }
  }

  // -- credential plumbing -------------------------------------------------

  private async providerConnection(connection: ConnectionRow): Promise<ProviderConnection> {
    return {
      id: connection.id, adapterId: connection.adapterId, baseUrl: connection.baseUrl, config: connection.config,
      credential: await this.credentials.resolve({ userId: connection.userId, connectionId: connection.id }),
    };
  }
}
