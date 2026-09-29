import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

const VERSION = "v1";

/** CONTRACTS §3: owner ids are UUIDs, so the AAD cannot be ambiguous. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keyFrom(masterKey: string | undefined) {
  if (!masterKey) throw new AppError("MASTER_KEY_MISSING", "CREDENTIALS_MASTER_KEY must be set before creating connections", 503);
  const key = Buffer.from(masterKey, "base64");
  if (key.byteLength !== 32) throw new AppError("MASTER_KEY_INVALID", "CREDENTIALS_MASTER_KEY must be a base64-encoded 32-byte key", 503);
  return key;
}

/**
 * CONTRACTS §3: the authenticated data binds one ciphertext to one user AND one
 * connection. There is no second accepted form and no fallback — a ciphertext
 * written under any other AAD (a bare profile id from the previous format, or
 * another user's `userId:connectionId`) fails authentication in `decryptSecret`.
 */
export function credentialAad(userId: string, connectionId: string): string {
  if (!UUID.test(userId) || !UUID.test(connectionId)) {
    throw new AppError("VALIDATION", "Credential owner ids must be UUIDs", 400);
  }
  return `${userId}:${connectionId}`;
}

/**
 * AES-256-GCM, format `v1.<iv>.<tag>.<ciphertext>` (base64url), unchanged.
 * `aad` is mandatory: every caller must name the owner it binds to, so a
 * credential can never be written or read without an authenticated owner.
 */
export function encryptSecret(plainText: string, aad: string, masterKey: string | undefined) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(masterKey), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, aad: string, masterKey: string | undefined) {
  const [version, ivText, tagText, ciphertextText] = payload.split(".");
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) throw new AppError("CREDENTIAL_CORRUPT", "Saved credential cannot be read", 500);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(masterKey), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("CREDENTIAL_CORRUPT", "Saved credential cannot be read with this master key", 500);
  }
}

// ---------------------------------------------------------------------------
// Redaction (CONTRACTS §7)
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

/**
 * A key whose whole value is a secret by convention. This is the *first* line of
 * defense only; see `BASE64_RUN` for why it cannot be the only one.
 */
const SECRET_KEY = /key|authorization|token|secret|password|credential|cookie|nonce|verifier|payload|base64|^data$|inline[_-]?data$/i;
/**
 * `authorization: Bearer …`, `api_key=…`, `?key=…` inside an otherwise harmless
 * string. `\b` keeps ordinary words such as `monkey=` from matching.
 */
const SECRET_ASSIGNMENT = /\b(authorization|key|token|secret|password|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:bearer\s+)?[^\s,;&]+/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;
/**
 * 200+ characters of the base64/base64url alphabet: image payloads, encoded
 * JWTs, exported keys. Key-name matching demonstrably does not catch these — the
 * 2.2 MB reference-image base64 that was persisted under `runs.inspector_json`
 * sat under `inlineData.data`, a name that matches none of `key`, `authorization`
 * or `token`. Content is therefore redacted independently of the key it sits
 * under. Prose never contains a 200-character run of this alphabet, so the rule
 * only fires on encoded binary or blob-shaped text.
 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{200,}={0,2}/g;

function redactString(value: string): string {
  return value.replace(SECRET_ASSIGNMENT, `$1: ${REDACTED}`).replace(BEARER, `$1 ${REDACTED}`).replace(BASE64_RUN, REDACTED);
}

/**
 * Generic secret redaction for anything that may reach a log or an error.
 * Returns a structurally equal value where every secret-shaped leaf, and every
 * base64-shaped run inside any string, is replaced by `[REDACTED]`.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? REDACTED : redact(item)]));
  }
  return value;
}
