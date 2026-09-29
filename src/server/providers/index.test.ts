import { describe, expect, it } from "vitest";
import type { ModelDto } from "../../shared/contracts.js";
import { configuredModel, pluginFor, plugins } from "./index.js";

const model = (providerModelId: string): ModelDto => ({
  id: "model",
  connectionId: "connection",
  providerModelId,
  label: providerModelId,
  // Stored capability: a name-matched candidate is stored as an image model.
  capabilities: ["imageGenerate"],
  operationConfigs: {},
  adapted: true,
  manual: false,
  enabled: true,
  createdAt: "2026-09-29T00:00:00.000Z",
});

describe("provider registry", () => {
  it("registers Gemini with the single synchronous operation only", () => {
    expect(plugins.map((plugin) => plugin.id)).toEqual(["gemini"]);
    expect(Object.keys(pluginFor("gemini").operations)).toEqual(["imageGenerate"]);
    expect(() => pluginFor("openai" as never)).toThrow("Unknown model adapter");
  });
});

describe("derived model capability", () => {
  it("lets the curated allowlist decide usability, not a name match or a stored capability", () => {
    // `gemini-2.5-flash-image` passes the candidate filter and is stored with an
    // imageGenerate capability, but no allowlist entry adapts it.
    const candidate = configuredModel(model("gemini-2.5-flash-image"), "gemini");
    expect(candidate.adapted).toBe(false);
    expect(candidate.availabilityMessage).toBeTruthy();
    expect(candidate.operationConfigs).toEqual({});

    const adapted = configuredModel(model("gemini-3.1-flash-image-preview"), "gemini");
    expect(adapted.adapted).toBe(true);
    expect(adapted.availabilityMessage).toBeUndefined();
    expect(adapted.operationConfigs.imageGenerate?.parameters.map((parameter) => parameter.key))
      .toContain("outputCount");
  });

  it("derives no operation configuration for an operation the model does not expose", () => {
    const dto: ModelDto = { ...model("gemini-3.1-flash-image"), capabilities: [] };
    expect(configuredModel(dto, "gemini").operationConfigs).toEqual({});
  });
});
