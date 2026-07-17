import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

const VERSION = "v1";

function keyFrom(masterKey: string | undefined) {
  if (!masterKey) throw new AppError("MASTER_KEY_MISSING", "CREDENTIALS_MASTER_KEY must be set before creating connections", 503);
  const key = Buffer.from(masterKey, "base64");
  if (key.byteLength !== 32) throw new AppError("MASTER_KEY_INVALID", "CREDENTIALS_MASTER_KEY must be a base64-encoded 32-byte key", 503);
  return key;
}

export function encryptSecret(plainText: string, profileId: string, masterKey: string | undefined) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(masterKey), iv);
  cipher.setAAD(Buffer.from(profileId));
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, profileId: string, masterKey: string | undefined) {
  const [version, ivText, tagText, ciphertextText] = payload.split(".");
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) throw new AppError("CREDENTIAL_CORRUPT", "Saved credential cannot be read", 500);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(masterKey), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(profileId));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("CREDENTIAL_CORRUPT", "Saved credential cannot be read with this master key", 500);
  }
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(authorization|api[_-]?key|x-api-key)\s*[:=]\s*[^\s,]+/gi, "$1: [REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|authorization|token|secret/i.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}
