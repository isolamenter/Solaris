import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { ConnectionRow } from "../interfaces.js";
import { AesCredentialVault } from "./vault.js";
import { UserKeyCredentialSource, requireUsable, type ConnectionLookup } from "./userKey.js";

const KEY = "sk-live-abcdef";

/** The repository's own ownership behaviour: a foreign id is simply not found. */
class FakeConnections implements ConnectionLookup {
  readonly rows = new Map<string, ConnectionRow>();
  getConnection(userId: string, connectionId: string): ConnectionRow {
    const row = this.rows.get(`${userId}:${connectionId}`);
    if (!row) throw new AppError("NOT_FOUND", "Connection not found", 404);
    return row;
  }
}

function connection(userId: string, connectionId: string, keyEncrypted: string | null): ConnectionRow {
  return {
    id: connectionId,
    userId,
    name: "Gateway",
    adapterId: "gemini",
    baseUrl: "https://gateway.example.test",
    config: {},
    keyEncrypted,
    enabled: true,
    lastTest: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("user-key credential source", () => {
  const userId = randomUUID();
  const otherUser = randomUUID();
  const connectionId = randomUUID();
  let repository: FakeConnections;
  let vault: AesCredentialVault;
  let source: UserKeyCredentialSource;

  beforeEach(() => {
    repository = new FakeConnections();
    vault = new AesCredentialVault(randomBytes(32).toString("base64"));
    source = new UserKeyCredentialSource(repository, vault);
    repository.rows.set(`${userId}:${connectionId}`, connection(userId, connectionId, vault.encrypt(KEY, userId, connectionId)));
  });

  it("is the user-key source", () => {
    expect(source.id).toBe("user-key");
  });

  it("resolves the owner's key after the repository has established ownership", async () => {
    await expect(source.resolve({ userId, connectionId })).resolves.toEqual({ apiKey: KEY, expiresAt: null });
    await expect(source.hasCredential({ userId, connectionId })).resolves.toBe(true);
  });

  it("never falls back to another user's key", async () => {
    const decrypt = vi.spyOn(vault, "decrypt");
    await expect(source.resolve({ userId: otherUser, connectionId })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(source.hasCredential({ userId: otherUser, connectionId })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    // Ownership failed before any ciphertext was touched.
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("reports a missing key as CREDENTIAL_MISSING, not as an auth failure", async () => {
    repository.rows.set(`${userId}:${connectionId}`, connection(userId, connectionId, null));
    await expect(source.resolve({ userId, connectionId })).rejects.toMatchObject({ code: "CREDENTIAL_MISSING", statusCode: 409 });
    await expect(source.hasCredential({ userId, connectionId })).resolves.toBe(false);
  });

  it("fails without falling back when the stored ciphertext belongs to someone else", async () => {
    // A row whose ciphertext was written for another owner: this must be a
    // decryption failure, never a read of the other user's secret.
    repository.rows.set(`${userId}:${connectionId}`, connection(userId, connectionId, vault.encrypt(KEY, otherUser, connectionId)));
    await expect(source.resolve({ userId, connectionId })).rejects.toMatchObject({ code: "CREDENTIAL_CORRUPT", statusCode: 500 });
  });

  it("distinguishes a credential failure from an invalid session", async () => {
    const failures: unknown[] = [];
    failures.push(await source.resolve({ userId: otherUser, connectionId }).catch((error: unknown) => error));
    failures.push(await source.resolve({ userId, connectionId: randomUUID() }).catch((error: unknown) => error));
    repository.rows.set(`${userId}:${connectionId}`, connection(userId, connectionId, null));
    failures.push(await source.resolve({ userId, connectionId }).catch((error: unknown) => error));

    const codes = failures.map((failure) => (failure as AppError).code);
    expect(codes).toEqual(["NOT_FOUND", "NOT_FOUND", "CREDENTIAL_MISSING"]);
    // A credential problem is never reported as a missing or expired session,
    // which is what the transport turns into 401 AUTH_REQUIRED.
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).not.toBe("AUTH_REQUIRED");
      expect((failure as AppError).statusCode).not.toBe(401);
    }
  });
});

describe("requireUsable", () => {
  const now = Date.parse("2026-09-29T10:00:00.000Z");

  it("accepts a credential with no expiry or a future one", () => {
    expect(requireUsable({ apiKey: KEY, expiresAt: null }, now).apiKey).toBe(KEY);
    expect(requireUsable({ apiKey: KEY, expiresAt: new Date(now + 1_000).toISOString() }, now).apiKey).toBe(KEY);
  });

  it("refuses an expired or unreadable expiry for a new call", () => {
    for (const expiresAt of [new Date(now - 1).toISOString(), new Date(now).toISOString(), "not-a-date"]) {
      expect(() => requireUsable({ apiKey: KEY, expiresAt }, now), expiresAt).toThrow("has expired");
    }
  });
});
