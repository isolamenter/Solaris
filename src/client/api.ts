import type { AssetDto, BatchEntryDto, BatchJobDto, ModelDto, ProfileDto, RunDto } from "../shared/contracts";

type ErrorPayload = { error?: { code?: string; message?: string } };
export class ApiClientError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const response = await fetch(url, { ...init, headers: { ...(hasJsonBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  if (!response.ok) { const body = await response.json().catch(() => ({})) as ErrorPayload; throw new ApiClientError(body.error?.code ?? "HTTP_ERROR", body.error?.message ?? `Request failed (${response.status})`); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const listProfiles = () => api<ProfileDto[]>("/api/profiles");
export const listModels = (profileId: string) => api<ModelDto[]>(`/api/profiles/${profileId}/models`);
export const listRuns = () => api<RunDto[]>("/api/runs");
export async function upload(file: File) { const form = new FormData(); form.append("file", file); return api<AssetDto>("/api/assets", { method: "POST", body: form }); }

export type BatchJobWithEntries = BatchJobDto & { entries: BatchEntryDto[] };
export const listBatches = () => api<BatchJobDto[]>("/api/batches");
export const getBatch = (id: string) => api<BatchJobWithEntries>(`/api/batches/${id}`);
export const createBatch = (input: { profileId: string; modelId: string; displayName?: string }) => api<BatchJobWithEntries>("/api/batches", { method: "POST", body: JSON.stringify(input) });
export const deleteBatch = (id: string) => api<void>(`/api/batches/${id}`, { method: "DELETE" });
export const addBatchEntry = (id: string, input: { prompt: string; parameters?: Record<string, unknown>; assetIds?: string[] }) => api<BatchJobWithEntries>(`/api/batches/${id}/entries`, { method: "POST", body: JSON.stringify(input) });
export const deleteBatchEntry = (id: string, entryId: string) => api<void>(`/api/batches/${id}/entries/${entryId}`, { method: "DELETE" });
export const submitBatch = (id: string) => api<BatchJobWithEntries>(`/api/batches/${id}/submit`, { method: "POST" });
export const cancelBatch = (id: string) => api<BatchJobWithEntries>(`/api/batches/${id}/cancel`, { method: "POST" });
export const previewBatchJsonl = (id: string) => api<string>(`/api/batches/${id}/jsonl`);
