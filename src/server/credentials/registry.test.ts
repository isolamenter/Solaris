import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { ConnectionRow } from "../interfaces.js";
import { AesCredentialVault, createCredentialSource, UserKeyCredentialSource, type ConnectionLookup } from "./index.js";

class FakeConnections implements ConnectionLookup {
  getConnection(): ConnectionRow {
    throw new AppError("NOT_FOUND", "Connection not found", 404);
  }
}

describe("credential source registry", () => {
  const vault = new AesCredentialVault(randomBytes(32).toString("base64"));

  it("builds the user-key source named by the configuration", () => {
    const source = createCredentialSource("user-key", new FakeConnections(), vault);
    expect(source).toBeInstanceOf(UserKeyCredentialSource);
    expect(source.id).toBe("user-key");
  });

  it("refuses an unset or unsupported source instead of falling back", () => {
    for (const id of [undefined, "", "sso", "User-Key"]) {
      expect(() => createCredentialSource(id, new FakeConnections(), vault), String(id)).toThrow("SOLARIS_CREDENTIAL_SOURCE must be one of user-key");
    }
  });
});
