import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../vault.js";
import { AesCredentialVault } from "./vault.js";

describe("AesCredentialVault", () => {
  const masterKey = randomBytes(32).toString("base64");
  const userId = randomUUID();
  const otherUser = randomUUID();
  const connectionId = randomUUID();
  const otherConnection = randomUUID();
  let vault: AesCredentialVault;

  beforeEach(() => {
    vault = new AesCredentialVault(masterKey);
  });

  it("round-trips a key for its owner and keeps the v1 format", () => {
    const payload = vault.encrypt("sk-live-abcdef", userId, connectionId);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain("sk-live-abcdef");
    expect(vault.decrypt(payload, userId, connectionId)).toBe("sk-live-abcdef");
  });

  it("refuses a ciphertext copied to another user or another connection", () => {
    const payload = vault.encrypt("sk-live-abcdef", userId, connectionId);
    expect(() => vault.decrypt(payload, otherUser, connectionId)).toThrow("Saved credential cannot be read");
    expect(() => vault.decrypt(payload, userId, otherConnection)).toThrow("Saved credential cannot be read");
  });

  it("refuses a ciphertext written under the old profile-id AAD", () => {
    // The previous binding. Nothing retries with it, so this credential is
    // simply unreadable and the user must re-enter the key.
    const legacy = encryptSecret("sk-live-abcdef", "profile-3f14c8", masterKey);
    expect(() => vault.decrypt(legacy, userId, connectionId)).toThrow("Saved credential cannot be read");
  });

  it("refuses a corrupt payload rather than returning something", () => {
    const payload = vault.encrypt("sk-live-abcdef", userId, connectionId);
    for (const broken of ["", "v1", "v2.a.b.c", `${payload}x`, payload.slice(0, -3)]) {
      expect(() => vault.decrypt(broken, userId, connectionId), broken).toThrow("Saved credential cannot be read");
    }
  });

  it("refuses ids that are not UUIDs", () => {
    expect(() => vault.encrypt("sk-live-abcdef", "user-1", connectionId)).toThrow("Credential owner ids must be UUIDs");
    expect(() => vault.encrypt("sk-live-abcdef", userId, "connection-1")).toThrow("Credential owner ids must be UUIDs");
  });

  it("fails closed when the master key is missing or malformed", () => {
    expect(() => new AesCredentialVault(undefined).encrypt("sk-live", userId, connectionId)).toThrow("CREDENTIALS_MASTER_KEY must be set");
    expect(() => new AesCredentialVault("dG9vLXNob3J0").encrypt("sk-live", userId, connectionId)).toThrow("base64-encoded 32-byte key");
  });
});
