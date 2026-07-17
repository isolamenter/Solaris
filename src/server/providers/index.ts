import { AppError } from "../errors.js";
import type { Capability, ModelDto, ProviderId } from "../../shared/contracts.js";
import { gemini } from "./gemini.js";
import type { ProviderPlugin } from "./types.js";

export const plugins: ProviderPlugin[] = [gemini];
export function pluginFor(id: ProviderId) { const plugin = plugins.find((item) => item.id === id); if (!plugin) throw new AppError("PLUGIN_NOT_FOUND", "Provider plugin is not installed", 400); return plugin; }
export function pluginDtos() { return plugins.flatMap((plugin) => { const operations = Object.entries(plugin.operations).filter(([, operation]) => Boolean(operation)).map(([name]) => name); return operations.length ? [{ id: plugin.id, label: plugin.label, fields: plugin.fields, operations }] : []; }); }
export function configuredModel(model: ModelDto, providerId: ProviderId): ModelDto {
  const plugin = pluginFor(providerId);
  const availability = plugin.modelAvailability?.(model.providerModelId) ?? { adapted: true };
  return {
    ...model,
    ...availability,
    operationConfigs: Object.fromEntries(model.capabilities.flatMap((operation) => {
      const config = plugin.modelOperationConfig?.(model.providerModelId, operation);
      return config ? [[operation, config.dto]] : [];
    })) as Partial<Record<Capability, ModelDto["operationConfigs"][Capability]>>,
  };
}
