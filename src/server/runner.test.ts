import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "solaris-runner-"));
process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SOLARIS_DATA_DIR = root;
const { openDatabase } = await import("./db/index.js");
const { AssetStore } = await import("./assets.js");
const { Repository } = await import("./repository.js");
const { SolarisService } = await import("./services.js");
const { VideoRunner } = await import("./runner.js");

describe("video runner", () => {
  let database: ReturnType<typeof openDatabase>;
  beforeEach(() => { database = openDatabase(root); });
  afterEach(() => { vi.unstubAllGlobals(); database.sqlite.close(); rmSync(root, { recursive: true, force: true }); });
  it("never retries an uncertain remote video submission", async () => {
    const assets = new AssetStore(database.sqlite, root); const repo = new Repository(database.sqlite, assets); const service = new SolarisService(repo, assets);
    const profile = service.createProfile({ name: "Gemini", pluginId: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "secret" }); const model = repo.upsertModel({ profileId: profile.id, providerModelId: "veo-3.1-generate-preview", capabilities: ["videoGenerate"], manual: true }); const run = service.createVideoRun({ profileId: profile.id, modelId: model.id, prompt: "a quiet forest" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network dropped")));
    const runner = new VideoRunner(repo, service, assets); await runner.tick();
    expect(repo.getRun(run.id).status).toBe("uncertain"); expect(repo.getRun(run.id).error?.code).toBe("SUBMISSION_UNKNOWN"); expect(repo.getJobForRun(run.id).state).toBe("uncertain");
  });
});
