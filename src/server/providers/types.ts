import { z } from "zod";
import type { Capability, ModelOperationConfigDto, ProviderId } from "../../shared/contracts.js";

export type Attachment = { mimeType: string; base64: string; byteSize: number };
export type OperationParameters = Record<string, string | number | boolean>;
export type ImageInput = { model: string; prompt: string; size?: string; attachments?: Attachment[]; parameters?: OperationParameters };
export type VideoInput = { model: string; prompt: string; durationSeconds?: number; size?: string };
export type ImageResult = { assets: { bytes: Buffer; mimeType: string }[]; inspector: Record<string, unknown> };
export type VideoSubmission = { remoteId: string; inspector: Record<string, unknown> };
export type VideoPoll = { state: "pending" | "success" | "error"; assets?: { bytes: Buffer; mimeType: string }[]; error?: string; inspector: Record<string, unknown> };

export type ProviderProfile = { id: string; pluginId: ProviderId; baseUrl: string; config: Record<string, unknown>; apiKey: string };
export type DiscoveredModel = { providerModelId: string; label?: string; capabilities: Capability[] };
export type ProviderModelOperationConfig = {
  dto: ModelOperationConfigDto;
  parseParameters: (value: unknown) => OperationParameters;
};
export type ProviderPlugin = {
  id: ProviderId;
  label: string;
  profileSchema: z.ZodType<{ baseUrl: string; config?: Record<string, unknown> }>;
  fields: { name: string; label: string; type: "url" | "text" | "number"; placeholder?: string; required?: boolean }[];
  discoverModels?: (profile: ProviderProfile) => Promise<DiscoveredModel[]>;
  modelAvailability?: (providerModelId: string) => { adapted: boolean; message?: string };
  modelOperationConfig?: (providerModelId: string, operation: Capability) => ProviderModelOperationConfig | undefined;
  testConnection: (profile: ProviderProfile) => Promise<{ detail: string }>;
  operations: {
    imageGenerate?: (profile: ProviderProfile, input: ImageInput) => Promise<ImageResult>;
    imageEdit?: (profile: ProviderProfile, input: ImageInput) => Promise<ImageResult>;
    videoGenerate?: { submit: (profile: ProviderProfile, input: VideoInput) => Promise<VideoSubmission>; poll: (profile: ProviderProfile, remoteId: string) => Promise<VideoPoll>; cancel?: (profile: ProviderProfile, remoteId: string) => Promise<void> };
  };
};
