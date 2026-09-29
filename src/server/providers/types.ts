/**
 * Model-service adapter boundary — CONTRACTS §7.
 *
 * Owned by B01; implemented by B04. The adapter is the only place that speaks a
 * model service's protocol. It never persists images, never manages Solaris
 * sessions or local files, and never decides login state.
 *
 * Video and Batch are removed (D5/D15) with no placeholders.
 */

import type { z } from "zod";
import type { AdapterId, ErrorCode, ModelOperationConfigDto, Operation, ParameterValues } from "../../shared/contracts.js";
import type { ResolvedCredential } from "../interfaces.js";

export type Attachment = { mimeType: string; base64: string; byteSize: number };

export type ImageInput = {
  model: string;
  prompt: string;
  attachments?: Attachment[];
  parameters?: ParameterValues;
};

export type ProviderModelOperationConfig = {
  dto: ModelOperationConfigDto;
  parseParameters: (value: unknown) => ParameterValues;
};

export type DiscoveredModel = { providerModelId: string; label?: string; capabilities: Operation[] };

/** Everything an adapter needs. The credential is already resolved and owned. */
export type ProviderConnection = {
  id: string;
  adapterId: AdapterId;
  baseUrl: string;
  config: Record<string, unknown>;
  credential: ResolvedCredential;
};

export type ImageResult = {
  images: { bytes: Buffer; mimeType: string }[];
  /** How many images upstream returned, before Solaris applied any retention rule. */
  returnedImageCount: number;
  /** Safe whitelist only: duration and counts. Never the raw request/response. */
  diagnostics: { durationMs: number; returnedImageCount: number };
};

/**
 * How a failed upstream call is classified. `rejected` means the upstream
 * verifiably refused the request; `unknown` means the request may have been
 * accepted — a generation POST must never be retried automatically on
 * `unknown`.
 */
export type ProviderCallOutcome = "rejected" | "unknown";

/**
 * Carries only a frozen public error code and a publicly safe message. Raw
 * bodies, query-string keys, redirect targets and the original exception must
 * not be attached.
 */
export class ProviderCallError extends Error {
  constructor(
    readonly outcome: ProviderCallOutcome,
    readonly errorCode: Extract<ErrorCode, "UPSTREAM_FAILED" | "UPSTREAM_NO_IMAGE" | "UPSTREAM_UNAVAILABLE" | "RESULT_TOO_LARGE">,
    message: string,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export type ProviderPlugin = {
  id: AdapterId;
  label: string;
  connectionSchema: z.ZodType<{ baseUrl: string; config?: Record<string, unknown> }>;
  fields: { name: string; label: string; type: "url" | "text" | "number"; placeholder?: string; required?: boolean }[];
  discoverModels?: (connection: ProviderConnection) => Promise<DiscoveredModel[]>;
  /** Curated allowlist. A model-name filter only narrows candidates. */
  modelAvailability?: (providerModelId: string) => { adapted: boolean; message?: string };
  modelOperationConfig?: (providerModelId: string, operation: Operation) => ProviderModelOperationConfig | undefined;
  testConnection: (connection: ProviderConnection) => Promise<{ detail: string }>;
  operations: {
    imageGenerate?: (connection: ProviderConnection, input: ImageInput) => Promise<ImageResult>;
  };
};
