/**
 * Typed HTTP client for the frozen Server API — CONTRACTS §9.
 *
 * Every call goes to an explicit Server base URL. There are no relative URLs and
 * no same-origin assumption: the Server can be remote, so the caller supplies
 * the origin and this module never reads `window.location`.
 *
 * Authentication is a bearer token read from the injected session on each
 * request; the client stores no credential itself.
 */

import type {
  AdapterDto,
  AdapterId,
  ConnectionDto,
  ConnectionTestDto,
  DeploymentDto,
  GenerationRequestDto,
  GenerationResponseDto,
  ModelDto,
  Operation,
  RunDto,
  RunPageDto,
  SessionDto,
  UserDto,
} from "../shared/contracts.js";

type ErrorEnvelope = { error?: { code?: unknown; message?: unknown; details?: unknown } };

/**
 * A failed request. `envelope` distinguishes the two cases the UI must not
 * confuse (CONTRACTS §4.2):
 *
 * - `true` — the Server answered with the canonical error envelope, so the
 *   request was refused before execution (validation, auth, ownership, digest
 *   conflict). Nothing reached the provider.
 * - `false` — the request failed in transport or the response was not an
 *   envelope. Whether the Server accepted it is unknown; the caller must treat
 *   the outcome as uncertain and must not silently resubmit.
 */
export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly envelope: boolean;

  constructor(input: { code: string; message: string; status: number; details?: unknown; envelope: boolean }) {
    super(input.message);
    this.name = "ApiClientError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
    this.envelope = input.envelope;
  }
}

async function toApiClientError(response: Response): Promise<ApiClientError> {
  const payload = (await response.json().catch(() => null)) as ErrorEnvelope | null;
  const envelope = payload?.error;
  return new ApiClientError({
    code: typeof envelope?.code === "string" ? envelope.code : "HTTP_ERROR",
    message: typeof envelope?.message === "string" ? envelope.message : `Request failed (${response.status})`,
    status: response.status,
    details: envelope?.details,
    envelope: envelope !== undefined,
  });
}

/** Request bodies described by CONTRACTS §9; the adapter id is immutable after creation. */
export type ConnectionCreateInput = {
  name: string;
  adapterId: AdapterId;
  baseUrl: string;
  config?: Record<string, unknown>;
  /** Write-only. It is never read back and never displayed. */
  apiKey: string;
};

export type ConnectionUpdateInput = {
  name: string;
  baseUrl: string;
  config?: Record<string, unknown>;
  enabled: boolean;
  /** Omit to keep the stored key. */
  apiKey?: string;
};

export type ManualModelInput = { providerModelId: string; label?: string; capabilities: Operation[] };

/** A reference part of the multipart request. Bytes, not a path. */
export type GenerationReference = { mimeType: string; bytes: Uint8Array };

export type GenerationSubmission = {
  /** One JSON text field named `request` — a field, never a file part (§4.1). */
  request: GenerationRequestDto;
  /** `reference` file parts, in multipart order. */
  references: GenerationReference[];
};

export type SolarisApiOptions = {
  /** Absolute Server base URL, e.g. `http://127.0.0.1:3210`. A relative URL is rejected. */
  baseUrl: string;
  /** Bearer token for the active session, or null when signed out. */
  getToken: () => string | null;
};

export class SolarisApi {
  /** Normalized Server origin; the local-scope key for client-local records (§10). */
  readonly origin: string;
  #baseUrl: string;
  #getToken: () => string | null;

  constructor(options: SolarisApiOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error(`Server base URL must be absolute, received ${JSON.stringify(options.baseUrl)}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Server base URL must use http or https, received ${parsed.protocol}`);
    }
    this.origin = parsed.origin;
    this.#baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    this.#getToken = options.getToken;
  }

  // -- deployment, session, account (CONTRACTS §2.1, §9) ---------------------

  getDeployment(): Promise<DeploymentDto> {
    return this.#request<DeploymentDto>("/api/deployment");
  }

  /** Second leg of the desktop authorization-code flow (§2.3 step 6). */
  exchangeDesktopCode(input: { code: string; codeVerifier: string }): Promise<SessionDto> {
    return this.#json<SessionDto>("/api/auth/desktop/token", "POST", {
      code: input.code,
      code_verifier: input.codeVerifier,
    });
  }

  logout(): Promise<void> {
    return this.#json<void>("/api/auth/logout", "POST");
  }

  getMe(): Promise<UserDto> {
    return this.#request<UserDto>("/api/me");
  }

  // -- connections and models (CONTRACTS §3, §9) -----------------------------

  listAdapters(): Promise<AdapterDto[]> {
    return this.#request<AdapterDto[]>("/api/adapters");
  }

  listConnections(): Promise<ConnectionDto[]> {
    return this.#request<ConnectionDto[]>("/api/connections");
  }

  createConnection(input: ConnectionCreateInput): Promise<ConnectionDto> {
    return this.#json<ConnectionDto>("/api/connections", "POST", input);
  }

  updateConnection(connectionId: string, input: ConnectionUpdateInput): Promise<ConnectionDto> {
    return this.#json<ConnectionDto>(`/api/connections/${encodeURIComponent(connectionId)}`, "PUT", input);
  }

  deleteConnection(connectionId: string): Promise<void> {
    return this.#json<void>(`/api/connections/${encodeURIComponent(connectionId)}`, "DELETE");
  }

  testConnection(connectionId: string): Promise<ConnectionTestDto> {
    return this.#json<ConnectionTestDto>(`/api/connections/${encodeURIComponent(connectionId)}/test`, "POST");
  }

  listModels(connectionId: string): Promise<ModelDto[]> {
    return this.#request<ModelDto[]>(`/api/connections/${encodeURIComponent(connectionId)}/models`);
  }

  /** Discovery refresh. Manual models survive; existing model ids are kept. */
  refreshModels(connectionId: string): Promise<ModelDto[]> {
    return this.#json<ModelDto[]>(`/api/connections/${encodeURIComponent(connectionId)}/models/refresh`, "POST");
  }

  addManualModel(connectionId: string, input: ManualModelInput): Promise<ModelDto> {
    return this.#json<ModelDto>(`/api/connections/${encodeURIComponent(connectionId)}/models`, "POST", input);
  }

  deleteModel(modelId: string): Promise<void> {
    return this.#json<void>(`/api/models/${encodeURIComponent(modelId)}`, "DELETE");
  }

  // -- generation (CONTRACTS §4.1) -------------------------------------------

  /**
   * multipart/form-data: one `request` text field plus zero or more `reference`
   * file parts. The browser sets the boundary, so no content-type header here.
   */
  submitGeneration(input: GenerationSubmission): Promise<GenerationResponseDto> {
    const form = new FormData();
    form.append("request", JSON.stringify(input.request));
    input.references.forEach((reference, index) => {
      // A plain copy keeps a stable, non-shared snapshot of the bytes that were
      // hashed, for every retry of this submission.
      const bytes = new Uint8Array(reference.bytes.byteLength);
      bytes.set(reference.bytes);
      form.append("reference", new Blob([bytes], { type: reference.mimeType }), `reference-${index + 1}`);
    });
    return this.#request<GenerationResponseDto>("/api/generations", { method: "POST", body: form });
  }

  // -- history (CONTRACTS §4.2, §9) ------------------------------------------

  listRuns(page: { limit?: number; cursor?: string } = {}): Promise<RunPageDto> {
    return this.#request<RunPageDto>("/api/runs", {}, { limit: page.limit, cursor: page.cursor });
  }

  getRun(runId: string): Promise<RunDto> {
    return this.#request<RunDto>(`/api/runs/${encodeURIComponent(runId)}`);
  }

  deleteRun(runId: string): Promise<void> {
    return this.#json<void>(`/api/runs/${encodeURIComponent(runId)}`, "DELETE");
  }

  // -- transport -------------------------------------------------------------

  async #request<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers(init.headers);
    const token = this.#getToken();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    // A body-less POST must not claim a JSON body.
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");

    const response = await fetch(url.toString(), { ...init, headers });
    if (!response.ok) throw await toApiClientError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  #json<T>(path: string, method: string, body?: unknown): Promise<T> {
    return this.#request<T>(path, body === undefined ? { method } : { method, body: JSON.stringify(body) });
  }
}
