/**
 * Record documents for the scoped native store.
 *
 * Every document is validated on the way in and on the way out. A record that
 * does not match its shape is reported, never silently dropped and never
 * silently repaired: for a local-first client, quietly discarding a draft is
 * worse than refusing to list it.
 */

import type { ParameterValues, SessionDto, UserDto } from "../../shared/contracts.js";
import type { DraftRecord, LocalImageRecord, LocalRunRecord, ReferenceRecord } from "../../shared/local.js";

const IMAGE_STATES = ["unsaved", "saved", "missing"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`The stored ${label} is not an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`The stored ${label} is not a string`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text === "") throw new Error(`The stored ${label} is empty`);
  return text;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (Number.isNaN(Date.parse(text))) throw new Error(`The stored ${label} is not a timestamp`);
  return text;
}

function requireSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`The stored ${label} is not a byte size`);
  }
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function requireParameters(value: unknown): ParameterValues {
  const record = requireObject(value, "parameters");
  const parameters: ParameterValues = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`The stored parameter ${JSON.stringify(key)} is not a parameter value`);
    }
    parameters[key] = entry;
  }
  return parameters;
}

function requireImageState(value: unknown): LocalImageRecord["state"] {
  for (const state of IMAGE_STATES) {
    if (value === state) return state;
  }
  throw new Error(`The stored image state ${JSON.stringify(value)} is not a known state`);
}

function parseUser(value: unknown): UserDto {
  const record = requireObject(value, "session user");
  return {
    id: requireNonEmptyString(record.id, "session user id"),
    displayName: requireNullableString(record.displayName, "session display name"),
    createdAt: requireTimestamp(record.createdAt, "session user creation time"),
  };
}

function parseReference(value: unknown, index: number): ReferenceRecord {
  const record = requireObject(value, `draft reference ${index}`);
  return {
    id: requireNonEmptyString(record.id, `draft reference id ${index}`),
    filePath: requireNonEmptyString(record.filePath, `draft reference path ${index}`),
    mimeType: requireNonEmptyString(record.mimeType, `draft reference MIME type ${index}`),
    sha256: requireNonEmptyString(record.sha256, `draft reference digest ${index}`),
    byteSize: requireSize(record.byteSize, `draft reference size ${index}`),
  };
}

function parseImage(value: unknown, index: number): LocalImageRecord {
  const record = requireObject(value, `run image ${index}`);
  const position = requireSize(record.index, `run image index ${index}`);
  return {
    index: position,
    filePath: requireNullableString(record.filePath, `run image path ${index}`),
    state: requireImageState(record.state),
    byteSize: requireSize(record.byteSize, `run image size ${index}`),
    mimeType: requireNonEmptyString(record.mimeType, `run image MIME type ${index}`),
  };
}

export function serializeSession(session: SessionDto): string {
  return JSON.stringify(session);
}

export function parseSession(document: string): SessionDto {
  const record = requireObject(JSON.parse(document), "session");
  return {
    token: requireNonEmptyString(record.token, "session token"),
    expiresAt: requireTimestamp(record.expiresAt, "session expiry"),
    user: parseUser(record.user),
  };
}

export function serializeDraft(draft: DraftRecord): string {
  return JSON.stringify(draft);
}

export function parseDraft(document: string): DraftRecord {
  const record = requireObject(JSON.parse(document), "draft");
  const references = record.references;
  if (!Array.isArray(references)) throw new Error("The stored draft references are not a list");
  return {
    id: requireNonEmptyString(record.id, "draft id"),
    connectionId: requireNullableString(record.connectionId, "draft connection id"),
    modelId: requireNullableString(record.modelId, "draft model id"),
    prompt: requireString(record.prompt, "draft prompt"),
    parameters: requireParameters(record.parameters),
    references: references.map((entry, index) => parseReference(entry, index)),
    updatedAt: requireTimestamp(record.updatedAt, "draft update time"),
  };
}

export function serializeLocalRun(record: LocalRunRecord): string {
  return JSON.stringify(record);
}

export function parseLocalRun(document: string): LocalRunRecord {
  const record = requireObject(JSON.parse(document), "local run");
  const images = record.images;
  if (!Array.isArray(images)) throw new Error("The stored run images are not a list");
  return {
    runId: requireNonEmptyString(record.runId, "run id"),
    submissionId: requireNonEmptyString(record.submissionId, "submission id"),
    images: images.map((entry, index) => parseImage(entry, index)),
    updatedAt: requireTimestamp(record.updatedAt, "run update time"),
  };
}
