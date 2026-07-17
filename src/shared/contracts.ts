export const providerIds = ["gemini"] as const;
export type ProviderId = (typeof providerIds)[number];
export type Operation = "imageGenerate" | "imageEdit" | "videoGenerate";
export type RunStatus = "running" | "queued" | "success" | "error" | "cancelled" | "uncertain";
export type Capability = "imageGenerate" | "videoGenerate";

export type ParameterOptionDto = { label: string; value: string | number | boolean; detail?: string };
export type OperationParameterDto = {
  key: string;
  label: string;
  type: "enum" | "number" | "boolean";
  default?: string | number | boolean;
  options?: ParameterOptionDto[];
  min?: number;
  max?: number;
  step?: number;
  description?: string;
};
export type AttachmentPolicyDto = {
  accept: string[];
  maxCount: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  description?: string;
};
export type ModelOperationConfigDto = {
  parameters: OperationParameterDto[];
  attachments?: AttachmentPolicyDto;
  warning?: string;
};

export type ProfileDto = {
  id: string;
  name: string;
  pluginId: ProviderId;
  baseUrl: string;
  config: Record<string, unknown>;
  enabled: boolean;
  hasKey: boolean;
  lastTest: { ok: boolean; at: string; detail?: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelDto = {
  id: string;
  profileId: string;
  providerModelId: string;
  label: string;
  capabilities: Capability[];
  operationConfigs: Partial<Record<Capability, ModelOperationConfigDto>>;
  adapted: boolean;
  availabilityMessage?: string;
  manual: boolean;
  enabled: boolean;
  createdAt: string;
};

export type AssetDto = { id: string; mimeType: string; byteSize: number; url: string; createdAt: string };
export type MessageDto = { id: string; role: "system" | "user" | "assistant"; content: string; assets: AssetDto[]; createdAt: string };
export type ConversationDto = { id: string; profileId: string; modelId: string; title: string; createdAt: string; updatedAt: string; messages?: MessageDto[] };
export type RunDto = {
  id: string;
  profileId: string;
  modelId: string;
  operation: Operation;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  assets: AssetDto[];
  inspector: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type JobDto = { id: string; runId: string; state: string; remoteId: string | null; attempts: number; nextPollAt: string | null; createdAt: string; updatedAt: string };
export type ApiError = { error: { code: string; message: string; details?: unknown } };
