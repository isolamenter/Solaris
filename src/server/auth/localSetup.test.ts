import { describe, expect, it } from "vitest";
import { createTestDeployment } from "../http/testSupport.js";
import { AesCredentialVault } from "../credentials/index.js";
import { TEST_MASTER_KEY } from "../http/testSupport.js";
import { configureLocalAccount } from "./localSetup.js";
import { MOCK_SUBJECT } from "./mockOidc.js";

const input = { publicOrigin: "http://127.0.0.1:3210", apiKey: "env-key-one", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.1-flash-image" };
it("seeds the mock user's encrypted key and adapted model; restart updates without duplication", async () => {
  const deployment = await createTestDeployment();
  try {
    await configureLocalAccount(deployment.repository, deployment.service, input);
    const user = deployment.repository.findUserByExternalIdentity(`${input.publicOrigin}/mock-oidc`, MOCK_SUBJECT);
    expect(user).toBeDefined();
    if (!user) throw new Error("missing user");
    const before = deployment.repository.listConnections(user.id)[0];
    if (!before) throw new Error("missing connection");
    expect(before.keyEncrypted).not.toContain(input.apiKey);
    expect((await deployment.service.listModels(user.id, before.id))[0]?.adapted).toBe(true);
    await configureLocalAccount(deployment.repository, deployment.service, { ...input, apiKey: "env-key-two" });
    const after = deployment.repository.listConnections(user.id);
    expect(after).toHaveLength(1);
    expect(await deployment.service.listModels(user.id, before.id)).toHaveLength(1);
    expect(new AesCredentialVault(TEST_MASTER_KEY).decrypt(after[0]?.keyEncrypted ?? "", user.id, before.id)).toBe("env-key-two");
    expect(JSON.stringify(deployment.service.listConnections(user.id))).not.toContain("env-key");
    const other = await deployment.signIn();
    expect(deployment.service.listConnections(other.userId)).toEqual([]);
    await expect(deployment.service.listModels(other.userId, before.id)).rejects.toThrow();
  } finally { await deployment.close(); }
});

describe("local startup validation", () => {
  it("requires an env key and an adapted model", async () => {
    const deployment = await createTestDeployment();
    try {
      await expect(configureLocalAccount(deployment.repository, deployment.service, { ...input, apiKey: "" })).rejects.toThrow("SOLARIS_GEMINI_API_KEY");
      await expect(configureLocalAccount(deployment.repository, deployment.service, { ...input, model: "unsupported" })).rejects.toThrow("SOLARIS_GEMINI_MODEL");
    } finally { await deployment.close(); }
  });
});
