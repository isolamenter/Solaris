import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "./db/index.js";
import type { CredentialSource, CredentialVault } from "./interfaces.js";
import { gemini } from "./providers/gemini.js";
import { ProviderCallError } from "./providers/types.js";
import { SqliteRepository } from "./repository.js";
import { ResultCache } from "./resultCache.js";
import { SolarisService } from "./services.js";
import { contentDigest } from "../shared/digest.js";

/**
 * Gate-level invariants for the frozen contract: idempotent submission,
 * ownership isolation, digest verification, reference limits, and the
 * terminal-uncertain rule. Runs against the real repository on a temporary
 * database so the claim path is genuinely exercised.
 *
 * B05 owns the broader service suite; this covers the invariants the shared
 * baseline must already satisfy.
 */

let sqlite: SqliteDatabase;
let root: string;
let service: SolarisService;
let repo: SqliteRepository;
let upstreamCalls: number;

/** Restored after each test; `vi.spyOn` cannot type an optional method. */
const realImageGenerate = gemini.operations.imageGenerate;

const vault: CredentialVault = {
  encrypt: (plainText, userId, connectionId) => `test.${userId}.${connectionId}.${plainText}`,
  decrypt: (payload) => payload,
};
const credentials: CredentialSource = {
  id: "user-key",
  resolve: async () => ({ apiKey: "test-key", expiresAt: null }),
  hasCredential: async () => true,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "solaris-gate-"));
  sqlite = openDatabase(root).sqlite;
  repo = new SqliteRepository(sqlite);
  service = new SolarisService(repo, credentials, vault, new ResultCache(60_000, 8 * 1024 * 1024), { imageResultMaxBytes: 4 * 1024 * 1024 });
  upstreamCalls = 0;
});

afterEach(() => {
  gemini.operations.imageGenerate = realImageGenerate;
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture(subject = "user-a") {
  const user = repo.createUserWithIdentity({ issuer: "https://idp.test", subject });
  const connection = service.createConnection(user.id, { name: "gateway", adapterId: "gemini", baseUrl: "https://gateway.test", apiKey: "test-key" });
  const model = repo.upsertModel({ userId: user.id, connectionId: connection.id, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true });
  return { userId: user.id, connectionId: connection.id, modelId: model.id };
}

function stubUpstream(result: { bytes: string; mimeType?: string } | Error) {
  gemini.operations.imageGenerate = async () => {
    upstreamCalls += 1;
    if (result instanceof Error) throw result;
    return {
      images: [{ bytes: Buffer.from(result.bytes), mimeType: result.mimeType ?? "image/png" }],
      returnedImageCount: 1,
      diagnostics: { durationMs: 1, returnedImageCount: 1 },
    };
  };
}

const digestFor = (connectionId: string, modelId: string, prompt: string) =>
  contentDigest({ connectionId, modelId, prompt, parameters: null, references: [] });

describe("generation submission invariants", () => {
  it("calls upstream once for a repeated submission and replays the bytes", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream({ bytes: "image-one" });
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const contentDigest = await digestFor(connectionId, modelId, "draw");

    const first = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(first.status).toBe("success");
    expect(first.result.kind).toBe("delivered");
    expect(upstreamCalls).toBe(1);

    const second = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(second.result.kind).toBe("delivered");
    if (second.result.kind !== "delivered") throw new Error("unreachable");
    expect(Buffer.from(second.result.images[0]!.dataBase64, "base64").toString()).toBe("image-one");
    // The whole point: a retry after a dropped response must not bill again.
    expect(upstreamCalls).toBe(1);
  });

  it("rejects the same submission id carrying different content", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream({ bytes: "image-one" });
    const submissionId = "22222222-2222-4222-8222-222222222222";

    await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] });
    await expect(service.generate(userId, { connectionId, modelId, prompt: "something else", submissionId, contentDigest: await digestFor(connectionId, modelId, "something else"), references: [] }))
      .rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(upstreamCalls).toBe(1);
  });

  it("keeps identical submission ids independent across users", async () => {
    const a = fixture("user-a");
    const b = fixture("user-b");
    stubUpstream({ bytes: "image-one" });
    const submissionId = "33333333-3333-4333-8333-333333333333";

    await service.generate(a.userId, { connectionId: a.connectionId, modelId: a.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(a.connectionId, a.modelId, "draw"), references: [] });
    await service.generate(b.userId, { connectionId: b.connectionId, modelId: b.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(b.connectionId, b.modelId, "draw"), references: [] });
    expect(upstreamCalls).toBe(2);

    // And a user cannot reach another user's run.
    const runsA = service.listRuns(a.userId, { limit: 10 });
    expect(() => service.getRun(b.userId, runsA.items[0]!.id)).toThrowError(/not found/i);
  });

  it("refuses a digest that does not match the received content", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream({ bytes: "image-one" });
    await expect(service.generate(userId, {
      connectionId, modelId, prompt: "draw",
      submissionId: "44444444-4444-4444-8444-444444444444",
      contentDigest: "0".repeat(64), references: [],
    })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    expect(upstreamCalls).toBe(0);
  });

  it("treats an unknown upstream outcome as terminal uncertain and never resubmits", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "could not be reached"));
    const submissionId = "55555555-5555-4555-8555-555555555555";
    const contentDigest = await digestFor(connectionId, modelId, "draw");

    const first = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(first.status).toBe("uncertain");
    expect(first.result).toEqual({ kind: "unavailable", reason: "submission-unknown" });
    expect(upstreamCalls).toBe(1);

    // Terminal: a replay must report the same state and must not call upstream.
    const second = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(second.status).toBe("uncertain");
    expect(upstreamCalls).toBe(1);
  });

  it("validates reference limits before calling upstream", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream({ bytes: "image-one" });
    const references = Array.from({ length: 15 }, () => ({ mimeType: "image/png", bytes: Buffer.from("x") }));
    await expect(service.generate(userId, {
      connectionId, modelId, prompt: "draw",
      submissionId: "66666666-6666-4666-8666-666666666666",
      contentDigest: "0".repeat(64), references,
    })).rejects.toMatchObject({ code: "REFERENCE_COUNT" });
    expect(upstreamCalls).toBe(0);
  });

  it("marks a run left running by a previous process as uncertain without resubmitting", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream({ bytes: "image-one" });
    const submissionId = "77777777-7777-4777-8777-777777777777";
    const contentDigest = await digestFor(connectionId, modelId, "draw");
    // Claim without finishing, as a crash mid-call would leave it.
    repo.claimRun({ userId, id: "88888888-8888-4888-8888-888888888888", submissionId, contentDigest, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0 });

    expect(service.recoverAbandonedRuns()).toEqual(["88888888-8888-4888-8888-888888888888"]);
    const replay = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(replay.status).toBe("uncertain");
    expect(upstreamCalls).toBe(0);
  });

  it("refuses to open a data directory that still holds the legacy schema", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "solaris-legacy-"));
    try {
      const legacy = openDatabase(legacyRoot).sqlite;
      legacy.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY)");
      legacy.close();
      expect(() => openDatabase(legacyRoot)).toThrow(/pre-refactor schema/);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});
