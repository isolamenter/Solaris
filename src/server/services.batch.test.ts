import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "solaris-batch-service-"));
process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.SOLARIS_DATA_DIR = root;
const { openDatabase } = await import("./db/index.js");
const { AssetStore } = await import("./assets.js");
const { Repository } = await import("./repository.js");
const { SolarisService } = await import("./services.js");
const { gemini } = await import("./providers/gemini.js");

afterEach(() => vi.unstubAllGlobals());

describe("Batch service state machine", () => {
  let database: ReturnType<typeof openDatabase>;
  let assets: InstanceType<typeof AssetStore>;
  let repo: InstanceType<typeof Repository>;
  let service: InstanceType<typeof SolarisService>;
  let profileId: string;
  let modelId: string;

  beforeEach(() => {
    database = openDatabase(root); assets = new AssetStore(database.sqlite, root); repo = new Repository(database.sqlite, assets); service = new SolarisService(repo, assets);
    const profile = service.createProfile({ name: "Gemini", pluginId: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "secret" });
    const model = repo.upsertModel({ profileId: profile.id, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true });
    profileId = profile.id; modelId = model.id;
  });

  afterEach(() => { database.sqlite.close(); rmSync(root, { recursive: true, force: true }); });

  it("builds inline JSONL for every entry", async () => {
    const batch = service.createBatchJob({ profileId, modelId, displayName: "demo" });
    const withEntries = service.addBatchEntry({ batchJobId: batch.id, prompt: "first" });
    service.addBatchEntry({ batchJobId: batch.id, prompt: "second" });
    expect(withEntries.entries).toHaveLength(1);
    const jsonl = service.previewBatchJsonl(batch.id);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\"first\"");
    expect(lines[1]).toContain("\"second\"");
  });

  it("processes a successful poll by materializing one run per entry", async () => {
    const submitFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "batches/test-1" }), { status: 200 }));
    vi.stubGlobal("fetch", submitFetch);
    const batch = service.createBatchJob({ profileId, modelId });
    service.addBatchEntry({ batchJobId: batch.id, prompt: "alpha" });
    service.addBatchEntry({ batchJobId: batch.id, prompt: "beta" });
    await service.submitBatchJob(batch.id);
    expect(service.getBatchJob(batch.id).status).toBe("running");
    expect(submitFetch).toHaveBeenCalledTimes(1);

    const pollFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: { state: "JOB_STATE_SUCCEEDED" }, response: { responsesFile: "files/out" } }), { status: 200 }));
    vi.stubGlobal("fetch", pollFetch);
    gemini.operations.batchGenerate!.download = async (profile, fileName) => {
      expect(fileName).toBe("files/out");
      return [
        { key: "0", response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1nMA==" } }] } }] } },
        { key: "1", response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1nMQ==" } }] } }] } },
      ];
    };
    const processed = await service.processBatchJob(service.getBatchJob(batch.id));
    expect(processed.status).toBe("succeeded");
    expect(processed.succeededCount).toBe(2);
    expect(processed.failedCount).toBe(0);
    const finalEntries = processed.entries;
    expect(finalEntries.every((entry) => entry.status === "success" && entry.runId !== null)).toBe(true);
  });
});
