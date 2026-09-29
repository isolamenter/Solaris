/**
 * Canonical content digest — CONTRACTS §6.1.
 *
 * Shared by Client and Server so both compute byte-identical input. Lives in
 * `src/shared` and must stay environment-agnostic: hashing uses Web Crypto
 * (`globalThis.crypto.subtle`), available in Node 20+ and in the Tauri webview,
 * so this module must not import `node:crypto`.
 *
 * Fixed test vectors are asserted by the contract tests; changing any rule here
 * is a contract change and breaks every stored `contentDigest`.
 */

import type { ParameterValues } from "./contracts.js";

export type DigestReference = { mimeType: string; sha256: string };

/**
 * The digest object is fixed. No other field may enter it: `providerModelId`
 * and connection `config` are server-resolved and must never be client-declared.
 */
export type DigestInput = {
  connectionId: string;
  modelId: string;
  prompt: string;
  /** null when the request omitted parameters — never omitted from the input. */
  parameters: ParameterValues | null;
  /** In multipart order. */
  references: DigestReference[];
};

/** Compare by Unicode code point, not UTF-16 code unit. */
function byCodePoint(a: string, b: string): number {
  const ax = Array.from(a);
  const bx = Array.from(b);
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const ac = ax[i]?.codePointAt(0) ?? 0;
    const bc = bx[i]?.codePointAt(0) ?? 0;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  return ax.length - bx.length;
}

/**
 * Deterministic JSON: object keys sorted by code point, arrays keep order, no
 * whitespace, `JSON.stringify` string semantics, and non-finite numbers
 * rejected rather than silently serialized as `null`.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Digest input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(byCodePoint);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`Digest input contains an unsupported value: ${typeof value}`);
}

/** The exact string that is hashed. Frozen by test vectors. */
export function canonicalDigestInput(input: DigestInput): string {
  return stableStringify({
    connectionId: input.connectionId,
    modelId: input.modelId,
    prompt: input.prompt,
    parameters: input.parameters,
    references: input.references.map((reference) => ({ mimeType: reference.mimeType, sha256: reference.sha256 })),
  });
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function sha256(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable; cannot compute a digest");
  const view = new Uint8Array(data.byteLength);
  view.set(data);
  return toHex(new Uint8Array(await subtle.digest("SHA-256", view.buffer)));
}

/** Lowercase hex SHA-256 of raw bytes. Used per reference image. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

/** Lowercase hex SHA-256 of the canonical string, UTF-8 encoded. */
export async function contentDigest(input: DigestInput): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalDigestInput(input)));
}
