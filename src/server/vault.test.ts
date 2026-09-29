import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { credentialAad, decryptSecret, encryptSecret, redact } from "./vault.js";

describe("credential vault", () => {
  const key = randomBytes(32).toString("base64");
  const userA = randomUUID();
  const userB = randomUUID();
  const connectionA = randomUUID();
  const connectionB = randomUUID();
  const aadA = credentialAad(userA, connectionA);

  it("keeps the v1 AES-256-GCM format with no plaintext in the payload", () => {
    const payload = encryptSecret("plain-text-value".repeat(200), aadA, key);
    expect(payload.split(".")).toHaveLength(4);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain("plain-text-value");
    expect(decryptSecret(payload, aadA, key)).toBe("plain-text-value".repeat(200));
  });

  it("binds a ciphertext to one user and one connection", () => {
    const payload = encryptSecret("sk-live-secret", aadA, key);
    expect(decryptSecret(payload, aadA, key)).toBe("sk-live-secret");
    // Copied to another user, or to another connection of the same user: the
    // authenticated data no longer matches, so authentication fails.
    expect(() => decryptSecret(payload, credentialAad(userB, connectionA), key)).toThrow("Saved credential cannot be read");
    expect(() => decryptSecret(payload, credentialAad(userA, connectionB), key)).toThrow("Saved credential cannot be read");
  });

  it("has no AAD fallback: a ciphertext written under the old profile-id AAD stays unreadable", () => {
    // This is the previous format's binding. It must not be decrypted by the
    // current one, and nothing retries with the old AAD.
    const legacy = encryptSecret("sk-live-secret", "profile-7f3a", key);
    expect(decryptSecret(legacy, "profile-7f3a", key)).toBe("sk-live-secret");
    expect(() => decryptSecret(legacy, aadA, key)).toThrow("Saved credential cannot be read");
  });

  it("refuses a non-UUID owner id instead of building an ambiguous AAD", () => {
    expect(() => credentialAad("profile-7f3a", connectionA)).toThrow("Credential owner ids must be UUIDs");
    expect(() => credentialAad(userA, "not-a-uuid")).toThrow("Credential owner ids must be UUIDs");
    expect(() => credentialAad("", "")).toThrow("Credential owner ids must be UUIDs");
  });
});

describe("redact", () => {
  const imageBase64 = randomBytes(2_200_000).toString("base64");

  it("redacts credential-shaped fields recursively", () => {
    expect(redact({ apiKey: "sk-live", nested: { authorization: "Bearer secret" }, harmless: "ok" })).toEqual({ apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]" }, harmless: "ok" });
  });

  it("redacts a base64 image payload whose key matches no secret-shaped name", () => {
    // The measured leak: `inlineData.data` holds the reference image and its key
    // matches none of key/authorization/token/secret.
    const leaked = { inlineData: { mimeType: "image/png", data: imageBase64 } };
    const redacted = redact(leaked);
    expect(redacted).toEqual({ inlineData: "[REDACTED]" });
    expect(JSON.stringify(redacted)).not.toContain(imageBase64.slice(0, 64));
    // Same payload under keys that match nothing at all: content decides.
    expect(redact({ mimeType: "image/png", content: imageBase64 })).toEqual({ mimeType: "image/png", content: "[REDACTED]" });
  });

  it("redacts a bare base64 payload under a key that matches no secret pattern", () => {
    expect(redact({ body: imageBase64 })).toEqual({ body: "[REDACTED]" });
    expect(redact(imageBase64)).toBe("[REDACTED]");
  });

  it("redacts a base64 run embedded in a longer string", () => {
    const text = `upstream returned inline image ${imageBase64} end of part`;
    const redacted = redact(text) as string;
    expect(redacted).toBe("upstream returned inline image [REDACTED] end of part");
    expect(redacted).not.toContain(imageBase64.slice(0, 64));
  });

  it("redacts credential-shaped assignments and bearer headers inside strings", () => {
    expect(redact("POST /v1beta?key=sk-live-12345 done")).toContain("key: [REDACTED]");
    expect(redact("authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toBe("authorization: [REDACTED]");
    expect(redact("Authorization: Bearer aaaabbbbcccc")).toBe("Authorization: [REDACTED]");
  });

  it("leaves ordinary diagnostics intact and keeps arrays ordered", () => {
    expect(redact({ durationMs: 9812, returnedImageCount: 2, note: "no images returned" })).toEqual({ durationMs: 9812, returnedImageCount: 2, note: "no images returned" });
    expect(redact([{ token: "x" }, "plain"])).toEqual([{ token: "[REDACTED]" }, "plain"]);
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
  });
});
