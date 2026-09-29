/**
 * One deliberate generation run: a stable `submissionId` plus the canonical
 * `contentDigest` over the exact bytes that will be uploaded (CONTRACTS §6.1).
 *
 * A draft is created once, when the user starts a run, and is reused unchanged
 * for every transport retry of that run — same submission id, same digest, same
 * bytes. A new user-initiated run always gets a new submission id, because a new
 * id means a new upstream call.
 */

import type { GenerationRequestDto, ParameterValues } from "../shared/contracts.js";
import { contentDigest, sha256Hex } from "../shared/digest.js";
import type { LocalScope, LocalStore } from "../shared/local.js";

/** Reference bytes held in memory for one run. Nothing here is persisted. */
export type ResolvedReference = {
  /** Device-local path the bytes were read from; used for display and removal only. */
  filePath: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  bytes: Uint8Array;
};

export type DraftRun = {
  submissionId: string;
  contentDigest: string;
  /** The DTO serialized into the multipart `request` field. */
  request: GenerationRequestDto;
  /** In multipart order; the digest covers the same order. */
  references: ResolvedReference[];
};

/** Reads a chosen reference file and hashes the raw bytes. */
export async function resolveReference(store: LocalStore, scope: LocalScope, filePath: string): Promise<ResolvedReference> {
  const file = await store.readReferenceFile(scope, filePath);
  if (file.bytes.byteLength === 0) throw new Error(`${baseName(filePath)} is empty.`);
  return {
    filePath,
    mimeType: file.mimeType,
    bytes: file.bytes,
    byteSize: file.bytes.byteLength,
    sha256: await sha256Hex(file.bytes),
  };
}

/**
 * Builds the request and its digest together so they can never disagree: the
 * digest covers exactly `{connectionId, modelId, prompt, parameters, references}`
 * with references in file order and absent parameters as null (§6.1).
 */
export async function createDraftRun(input: {
  connectionId: string;
  modelId: string;
  prompt: string;
  parameters: ParameterValues | null;
  references: ResolvedReference[];
}): Promise<DraftRun> {
  const submissionId = crypto.randomUUID();
  const digest = await contentDigest({
    connectionId: input.connectionId,
    modelId: input.modelId,
    prompt: input.prompt,
    parameters: input.parameters,
    references: input.references.map((reference) => ({ mimeType: reference.mimeType, sha256: reference.sha256 })),
  });
  return {
    submissionId,
    contentDigest: digest,
    request: {
      connectionId: input.connectionId,
      modelId: input.modelId,
      prompt: input.prompt,
      ...(input.parameters === null ? {} : { parameters: input.parameters }),
      submissionId,
      contentDigest: digest,
    },
    references: input.references,
  };
}

export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}
