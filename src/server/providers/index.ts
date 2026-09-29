import { AppError } from "../errors.js";
import type { AdapterDto, AdapterId, ModelDto, Operation } from "../../shared/contracts.js";
import { gemini } from "./gemini.js";
import type { ProviderPlugin } from "./types.js";

export const plugins: ProviderPlugin[] = [gemini];

export function pluginFor(id: AdapterId): ProviderPlugin {
  const plugin = plugins.find((item) => item.id === id);
  if (!plugin) throw new AppError("NOT_FOUND", "Unknown model adapter", 404);
  return plugin;
}

/** Static adapter form configuration, used by the connection editor. */
export function adapterDtos(): AdapterDto[] {
  return plugins.map((plugin) => ({ id: plugin.id, label: plugin.label, fields: plugin.fields }));
}

/**
 * Fills the read-time-derived model fields. These are never persisted: the
 * adapter's curated allowlist decides `adapted`, and `operationConfigs` is
 * derived per request.
 */
export function configuredModel(model: ModelDto, adapterId: AdapterId): ModelDto {
  const plugin = pluginFor(adapterId);
  const availability = plugin.modelAvailability?.(model.providerModelId) ?? { adapted: true };
  const operationConfigs: Partial<Record<Operation, ModelDto["operationConfigs"][Operation]>> = {};
  for (const operation of model.capabilities) {
    const config = plugin.modelOperationConfig?.(model.providerModelId, operation);
    if (config) operationConfigs[operation] = config.dto;
  }
  // The adapter names its side of the availability result `message`; the DTO
  // field is `availabilityMessage`, and it is what tells a client why a model
  // cannot be used. Map it explicitly so it is not dropped.
  return { ...model, adapted: availability.adapted, availabilityMessage: availability.message, operationConfigs };
}
