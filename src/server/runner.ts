import type { AssetStore } from "./assets.js";
import { toAppError } from "./errors.js";
import { pluginFor } from "./providers/index.js";
import type { Repository } from "./repository.js";
import { SolarisService } from "./services.js";
import { redact } from "./vault.js";

export class VideoRunner {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private readonly repo: Repository, private readonly service: SolarisService, private readonly assets: AssetStore) {}
  start() { this.timer = setInterval(() => void this.tick(), 2_000); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      for (const job of this.repo.dueJobs()) await this.process(job);
      for (const batch of this.repo.dueBatchJobs()) await this.processBatch(batch);
    } finally { this.busy = false; }
  }
  private async process(job: { id: string; run_id: string; state: string; remote_id: string | null }) {
    const run = this.repo.getRun(job.run_id); if (["success", "error", "cancelled", "uncertain"].includes(run.status)) return;
    const plugin = pluginFor(this.repo.getProfile(run.profileId).pluginId); const video = plugin.operations.videoGenerate; if (!video) return;
    if (job.state === "queued") {
      this.repo.markSubmitting(job.id);
      try { const input = run.input as { prompt: string; durationSeconds?: number; size?: string }; const submitted = await video.submit(this.service.providerProfile(run.profileId), { model: this.repo.getModel(run.modelId).providerModelId, ...input }); this.repo.markPolling(job.id, submitted.remoteId); this.repo.setRunInspector(run.id, redact(submitted.inspector) as Record<string, unknown>); } catch (error) { const safe = toAppError(error); const uncertain = safe.code === "PROVIDER_UNAVAILABLE"; this.repo.markJobDone(job.id, uncertain ? "uncertain" : "error"); this.repo.finishRun(run.id, uncertain ? "uncertain" : "error", null, null, { code: uncertain ? "SUBMISSION_UNKNOWN" : safe.code, message: uncertain ? "Video submission outcome is unknown; Solaris will not submit it again." : safe.message }); }
      return;
    }
    if (job.state !== "polling" || !job.remote_id) return;
    try { const result = await video.poll(this.service.providerProfile(run.profileId), job.remote_id); if (result.state === "pending") return; if (result.state === "error") { this.repo.markJobDone(job.id, "error"); this.repo.finishRun(run.id, "error", null, redact(result.inspector) as Record<string, unknown>, { code: "VIDEO_FAILED", message: result.error ?? "Video generation failed" }); return; } const assets = (result.assets ?? []).map((asset) => this.assets.save(asset.bytes, asset.mimeType)); this.repo.linkAssets(run.id, assets); this.repo.markJobDone(job.id, "success"); this.repo.finishRun(run.id, "success", { assetCount: assets.length }, redact(result.inspector) as Record<string, unknown>); } catch (error) { const safe = toAppError(error); this.repo.markJobDone(job.id, "error"); this.repo.finishRun(run.id, "error", null, null, { code: safe.code, message: safe.message }); }
  }
  private async processBatch(batch: { id: string }) {
    try { await this.service.processBatchJob(this.repo.getBatchJob(batch.id)); } catch { /* service already records errors on the batch job */ }
  }
}
