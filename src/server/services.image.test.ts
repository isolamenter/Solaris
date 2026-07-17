import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "solaris-image-service-"));
process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.SOLARIS_DATA_DIR = root;
const { openDatabase } = await import("./db/index.js");
const { AssetStore } = await import("./assets.js");
const { Repository } = await import("./repository.js");
const { SolarisService } = await import("./services.js");

describe("Gemini image service controls", () => {
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

  it("enriches model DTOs without persisting operation configuration", () => {
    const [model] = service.listModels(profileId);
    expect(model?.operationConfigs.imageGenerate?.parameters.map((parameter) => parameter.key)).toEqual(["aspectRatio", "imageSize", "thinkingLevel", "googleSearch"]);
    expect(repo.getModel(modelId).operationConfigs).toEqual({});
  });

  it("keeps unadapted discovery results visible but unusable", () => {
    repo.replaceDiscoveredModels(profileId, [
      { providerModelId: "chat-only", capabilities: ["chat" as never] },
      { providerModelId: "image-with-chat", capabilities: ["chat" as never, "imageGenerate"] },
    ]);
    const discovered = service.listModels(profileId).filter((model) => !model.manual);
    expect(discovered).toHaveLength(2);
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerModelId: "chat-only", capabilities: [], adapted: false }),
      expect.objectContaining({ providerModelId: "image-with-chat", capabilities: ["imageGenerate"], adapted: false }),
    ]));
  });

  it("rejects unknown parameters before creating a run", async () => {
    await expect(service.createImageRun({ profileId, modelId, prompt: "test", parameters: { proxyHeader: "unsafe" } })).rejects.toThrow("Unrecognized key");
    expect(repo.listRuns()).toHaveLength(0);
  });

  it("blocks an unadapted model even when it was manually assigned image capabilities", async () => {
    const legacy = repo.upsertModel({ profileId, providerModelId: "gemini-2.5-flash-image", capabilities: ["imageGenerate"], manual: true });
    await expect(service.createImageRun({ profileId, modelId: legacy.id, prompt: "test" })).rejects.toMatchObject({ code: "MODEL_NOT_ADAPTED" });
    expect(repo.listRuns()).toHaveLength(0);
  });

  it("enforces Gemini reference count, type, and total byte limits", async () => {
    const text = assets.save(Buffer.from("not an image"), "text/plain");
    await expect(service.createImageRun({ profileId, modelId, prompt: "test", assetIds: [text.id] })).rejects.toMatchObject({ code: "ASSET_TYPE" });

    const references = Array.from({ length: 15 }, (_, index) => assets.save(Buffer.from(`image-${index}`), "image/png"));
    await expect(service.createImageRun({ profileId, modelId, prompt: "test", assetIds: references.map((asset) => asset.id) })).rejects.toMatchObject({ code: "ASSET_COUNT" });

    const first = assets.save(Buffer.alloc(8 * 1024 * 1024, 1), "image/png");
    const second = assets.save(Buffer.alloc(8 * 1024 * 1024, 2), "image/png");
    await expect(service.createImageRun({ profileId, modelId, prompt: "test", assetIds: [first.id, second.id] })).rejects.toMatchObject({ code: "ASSET_TOTAL_SIZE" });
  });
});
