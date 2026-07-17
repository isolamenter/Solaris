import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, redact } from "./vault.js";

describe("credential vault", () => {
  const key = randomBytes(32).toString("base64");
  it("encrypts with profile-bound authenticated data", () => {
    const encrypted = encryptSecret("secret-value", "profile-a", key);
    expect(encrypted).not.toContain("secret-value");
    expect(decryptSecret(encrypted, "profile-a", key)).toBe("secret-value");
    expect(() => decryptSecret(encrypted, "profile-b", key)).toThrow("Saved credential cannot be read");
  });
  it("redacts credential-shaped fields recursively", () => {
    expect(redact({ apiKey: "sk-live", nested: { authorization: "Bearer secret" }, harmless: "ok" })).toEqual({ apiKey: "[REDACTED]", nested: { authorization: "[REDACTED]" }, harmless: "ok" });
  });
});
