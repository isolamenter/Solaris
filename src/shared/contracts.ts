/**
 * Shared Client/Server DTOs — CONTRACTS v3.
 *
 * Scope: synchronous single-image generation only. Video, Batch, upstream job
 * polling, cancellation, JSONL transfer and the Server-side asset library are
 * removed with no placeholders.
 *
 * This file must not import server-only types (Buffer, Row types, secrets).
 */

/** Closed identities. Registry, Zod validation and types update together. */
export const adapterIds = ["gemini"] as const;
export type AdapterId = (typeof adapterIds)[number];

export const authAdapterIds = ["oidc"] as const;
export type AuthAdapterId = (typeof authAdapterIds)[number];

export const credentialSourceIds = ["user-key"] as const;
export type CredentialSourceId = (typeof credentialSourceIds)[number];

export const operations = ["imageGenerate"] as const;
export type Operation = (typeof operations)[number];

/**
 * Generation outcome. `uncertain` means the request may have been accepted but
 * no determinate result was obtained; it is terminal and is never resubmitted
 * automatically.
 */
export type RunStatus = "running" | "success" | "error" | "uncertain";

/** Finite parameter values only; non-finite numbers are rejected. */
export type ParameterValues = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Model operation configuration (carried over from the previous contract)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Identity, session, deployment (CONTRACTS §2.1)
// ---------------------------------------------------------------------------

export type UserDto = { id: string; displayName: string | null; createdAt: string };
export type SessionDto = { token: string; expiresAt: string; user: UserDto };
export type DeploymentDto = {
  name: string;
  auth: {
    /** Solaris transport flow, not the external authentication protocol. */
    flow: "desktop-code";
    authorizationEndpoint: string;
    tokenEndpoint: string;
  };
};

// ---------------------------------------------------------------------------
// Connections and models (CONTRACTS §3)
// ---------------------------------------------------------------------------

export type ConnectionTestDto = { ok: boolean; at: string; detail?: string };

export type ConnectionDto = {
  id: string;
  name: string;
  adapterId: AdapterId;
  baseUrl: string;
  config: Record<string, unknown>;
  enabled: boolean;
  /** The only exposed surface of a stored credential. The key is write-only. */
  hasKey: boolean;
  lastTest: ConnectionTestDto | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelDto = {
  id: string;
  connectionId: string;
  providerModelId: string;
  label: string;
  capabilities: Operation[];
  operationConfigs: Partial<Record<Operation, ModelOperationConfigDto>>;
  /**
   * Derived by the adapter at read time from its curated allowlist; upstream
   * capability metadata is unavailable through a gateway, so a model-name
   * filter only narrows candidates and never authorizes a run.
   */
  adapted: boolean;
  availabilityMessage?: string;
  manual: boolean;
  enabled: boolean;
  createdAt: string;
};

/** Static adapter form configuration for the connection editor. */
export type AdapterFieldDto = { name: string; label: string; type: "url" | "text" | "number"; placeholder?: string; required?: boolean };
export type AdapterDto = { id: AdapterId; label: string; fields: AdapterFieldDto[] };

// ---------------------------------------------------------------------------
// Generation request (CONTRACTS §4.1)
// ---------------------------------------------------------------------------

export type GenerationRequestDto = {
  connectionId: string;
  modelId: string;
  prompt: string;
  parameters?: ParameterValues;
  /** Stable per deliberate run; transport retries reuse it. */
  submissionId: string;
  contentDigest: string;
};

// ---------------------------------------------------------------------------
// History and delivery (CONTRACTS §4.2)
// ---------------------------------------------------------------------------

/** Delivery only. The single export path for image bytes. */
export type GeneratedImageDto = { mimeType: string; byteSize: number; dataBase64: string };

/** History only. Dimensions, never bytes. */
export type RunImageRefDto = { mimeType: string; byteSize: number };

export type RunErrorDto = { code: string; message: string };

export type RunDto = {
  id: string;
  connectionId: string;
  /** Snapshot: history stays readable after the connection is renamed or deleted. */
  connectionName: string;
  modelId: string;
  /** Snapshot: history keeps pointing at the target used at claim time. */
  providerModelId: string;
  operation: Operation;
  status: RunStatus;
  prompt: string;
  parameters: ParameterValues;
  referenceCount: number;
  /** null when the upstream response could not be fully parsed within budget. */
  returnedImageCount: number | null;
  retainedImageCount: number | null;
  images: RunImageRefDto[];
  error: RunErrorDto | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerationUnavailableReason =
  | "not-generated"
  | "submission-unknown"
  | "cache-miss"
  | "result-too-large"
  | "history-deleted";

export type GenerationResultDto =
  | { kind: "pending" }
  | { kind: "delivered"; images: GeneratedImageDto[] }
  | { kind: "unavailable"; reason: GenerationUnavailableReason };

/**
 * Every handled generation/replay response uses this shape: HTTP 202 with
 * `pending`, otherwise HTTP 200. Failures that never reached execution
 * (validation, auth, ownership, digest conflict) use the standard error
 * envelope instead.
 */
export type GenerationResponseDto = {
  submissionId: string;
  status: RunStatus;
  /** null only for a replay after the history record was deleted. */
  run: RunDto | null;
  result: GenerationResultDto;
};

// ---------------------------------------------------------------------------
// Errors (CONTRACTS §9)
// ---------------------------------------------------------------------------

/** Frozen public error codes. Anything else must surface as `INTERNAL`. */
export const errorCodes = [
  "AUTH_REQUIRED",
  "AUTH_FLOW_INVALID",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "DIGEST_MISMATCH",
  "SUBMISSION_CONFLICT",
  "RUN_ACTIVE",
  "RESOURCE_IN_USE",
  "CONNECTION_DISABLED",
  "CREDENTIAL_MISSING",
  "MODEL_NOT_ADAPTED",
  "OPERATION_UNAVAILABLE",
  "PARAMETERS_UNAVAILABLE",
  "REFERENCE_COUNT",
  "REFERENCE_TYPE",
  "REFERENCE_SIZE",
  "REFERENCE_TOTAL_SIZE",
  "BASE_URL_INVALID",
  "BASE_URL_INSECURE",
  "UPSTREAM_FAILED",
  "UPSTREAM_NO_IMAGE",
  "UPSTREAM_UNAVAILABLE",
  "RESULT_TOO_LARGE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export type ApiErrorEnvelope = { error: { code: string; message: string; details?: unknown } };

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export type RunPageDto = { items: RunDto[]; nextCursor: string | null };
