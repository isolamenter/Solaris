import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerationResponseDto } from "../shared/contracts.js";
import { contentDigest } from "../shared/digest.js";
import { AesCredentialVault, UserKeyCredentialSource } from "./credentials/index.js";
import { openDatabase, type SqliteDatabase } from "./db/index.js";
import { gemini } from "./providers/gemini.js";
import { ProviderCallError } from "./providers/types.js";
import type { Repository } from "./interfaces.js";
import { SqliteRepository } from "./repository.js";
import { ResultCache } from "./resultCache.js";
import { SolarisService } from "./services.js";

/**
 * B05 — idempotent submission and replay (CONTRACTS §4.2, §6).
 *
 * The invariant under test is the number of upstream calls. A retry may be
 * answered from the receipt, from the delivery cache, or not at all — but a
 * submission id that has already been claimed must never reach upstream twice,
 * and a deleted or disabled connection must not turn a replay into a new call.
 * Every assertion here is on the real repository (temporary database) and the
 * real credential boundary, with only the model service stubbed.
 */

const API_KEY = "upstream-api-key-value";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const IMAGE_BUDGET = 4 * 1024 * 1024;

let root: string;
let sqlite: SqliteDatabase;
let repo: SqliteRepository;
let vault: AesCredentialVault;
let cache: ResultCache;
let service: SolarisService;
let upstreamCalls: number;

/** Restored after each test; `vi.spyOn` cannot type an optional method. */
const realImageGenerate = gemini.operations.imageGenerate;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "solaris-replay-"));
  sqlite = openDatabase(root).sqlite;
  repo = new SqliteRepository(sqlite);
  vault = new AesCredentialVault(MASTER_KEY);
  cache = new ResultCache(10 * 60_000, 8 * 1024 * 1024);
  service = new SolarisService(repo, new UserKeyCredentialSource(repo, vault), vault, cache, { imageResultMaxBytes: IMAGE_BUDGET });
  upstreamCalls = 0;
});

afterEach(() => {
  gemini.operations.imageGenerate = realImageGenerate;
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture(subject = "user-a") {
  const user = repo.createUserWithIdentity({ issuer: "https://idp.test", subject });
  const connection = service.createConnection(user.id, { name: "gateway", adapterId: "gemini", baseUrl: "https://gateway.test", apiKey: API_KEY });
  const model = repo.upsertModel({ userId: user.id, connectionId: connection.id, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true });
  return { userId: user.id, connectionId: connection.id, modelId: model.id };
}

/** Each call returns the next payload, so a replay can be traced to the call that produced it. */
function stubUpstream(...payloads: (string | Error)[]) {
  gemini.operations.imageGenerate = async () => {
    upstreamCalls += 1;
    const payload = payloads[Math.min(upstreamCalls, payloads.length) - 1];
    if (payload instanceof Error) throw payload;
    return {
      images: [{ bytes: Buffer.from(payload ?? "image"), mimeType: "image/png" }],
      returnedImageCount: 1,
      diagnostics: { durationMs: 1, returnedImageCount: 1 },
    };
  };
}

const digestFor = (connectionId: string, modelId: string, prompt: string) =>
  contentDigest({ connectionId, modelId, prompt, parameters: null, references: [] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deliveredBytes(response: GenerationResponseDto): string {
  const { result } = response;
  if (result.kind !== "delivered") throw new Error(`expected a delivered result, got ${result.kind}`);
  const first = result.images[0];
  if (!first) throw new Error("expected at least one delivered image");
  return Buffer.from(first.dataBase64, "base64").toString();
}

const runIdOf = (userId: string) => {
  const run = service.listRuns(userId, { limit: 10 }).items[0];
  if (!run) throw new Error("expected a run");
  return run.id;
};

/**
 * Watches the in-process handoff between the delivery cache and the run record.
 * CONTRACTS §4.3 requires those to be coordinated: a replay running right after
 * a success must find the bytes already published.
 */
class HandoffRepository extends SqliteRepository {
  successes = 0;
  successWithoutBytes = false;
  private claimedSubmissionId: string | null = null;

  override claimRun(...args: Parameters<Repository["claimRun"]>): ReturnType<Repository["claimRun"]> {
    const result = super.claimRun(...args);
    this.claimedSubmissionId = result.receipt.submissionId;
    return result;
  }

  override finishRun(...args: Parameters<Repository["finishRun"]>): ReturnType<Repository["finishRun"]> {
    const [userId, , input] = args;
    if (input.status === "success") {
      this.successes += 1;
      const submissionId = this.claimedSubmissionId;
      if (submissionId === null || cache.get(userId, submissionId) === null) this.successWithoutBytes = true;
    }
    return super.finishRun(...args);
  }
}

describe("idempotent submission", () => {
  it("calls upstream once per submission, however often it is replayed", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const contentDigest = await digestFor(connectionId, modelId, "draw");
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] };

    const first = await service.generate(userId, input);
    expect(first.status).toBe("success");
    expect(deliveredBytes(first)).toBe("image-one");

    const second = await service.generate(userId, input);
    const third = await service.generate(userId, input);
    expect(deliveredBytes(second)).toBe("image-one");
    expect(deliveredBytes(third)).toBe("image-one");
    expect(upstreamCalls).toBe(1);
  });

  it("runs one upstream call for two concurrent duplicates of the same submission", async () => {
    const { userId, connectionId, modelId } = fixture();
    const gate = deferred();
    gemini.operations.imageGenerate = async () => {
      upstreamCalls += 1;
      await gate.promise;
      return { images: [{ bytes: Buffer.from("image-one"), mimeType: "image/png" }], returnedImageCount: 1, diagnostics: { durationMs: 1, returnedImageCount: 1 } };
    };
    const submissionId = "12121212-1212-4212-8212-121212121212";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };

    const owner = service.generate(userId, input);
    const duplicate = service.generate(userId, input);
    // The duplicate loses the claim and is answered while the call is in flight.
    const pending = await duplicate;
    expect(pending.status).toBe("running");
    expect(pending.result).toEqual({ kind: "pending" });
    expect(upstreamCalls).toBe(1);

    gate.resolve();
    const winner = await owner;
    expect(winner.status).toBe("success");
    expect(deliveredBytes(winner)).toBe("image-one");
    expect(upstreamCalls).toBe(1);
  });

  it("treats a new submission id for the same content as a deliberate new run", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one", "image-two");
    const contentDigest = await digestFor(connectionId, modelId, "draw");

    const first = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId: "13131313-1313-4313-8313-131313131313", contentDigest, references: [] });
    const second = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId: "14141414-1414-4414-8414-141414141414", contentDigest, references: [] });

    // Dedup is per submission id: a new id is a new run and may be billed again.
    expect(deliveredBytes(first)).toBe("image-one");
    expect(deliveredBytes(second)).toBe("image-two");
    expect(upstreamCalls).toBe(2);
  });

  it("keeps the same submission id independent per user, with no byte crossover", async () => {
    const a = fixture("user-a");
    const b = fixture("user-b");
    stubUpstream("image-one", "image-two");
    const submissionId = "15151515-1515-4515-8515-151515151515";

    await service.generate(a.userId, { connectionId: a.connectionId, modelId: a.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(a.connectionId, a.modelId, "draw"), references: [] });
    await service.generate(b.userId, { connectionId: b.connectionId, modelId: b.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(b.connectionId, b.modelId, "draw"), references: [] });
    expect(upstreamCalls).toBe(2);

    // Each replay resolves through its own receipt, so neither user can be
    // handed the other's bytes even though the submission id is identical.
    const replayA = await service.generate(a.userId, { connectionId: a.connectionId, modelId: a.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(a.connectionId, a.modelId, "draw"), references: [] });
    const replayB = await service.generate(b.userId, { connectionId: b.connectionId, modelId: b.modelId, prompt: "draw", submissionId, contentDigest: await digestFor(b.connectionId, b.modelId, "draw"), references: [] });
    expect(deliveredBytes(replayA)).toBe("image-one");
    expect(deliveredBytes(replayB)).toBe("image-two");
    expect(upstreamCalls).toBe(2);
  });
});

describe("delivery cache handoff", () => {
  it("never marks a run success before its bytes are published", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const handoff = new HandoffRepository(sqlite);
    const ordered = new SolarisService(handoff, new UserKeyCredentialSource(handoff, vault), vault, cache, { imageResultMaxBytes: IMAGE_BUDGET });
    const submissionId = "1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d";

    const response = await ordered.generate(userId, {
      connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [],
    });

    expect(response.result.kind).toBe("delivered");
    expect(handoff.successes).toBe(1);
    // At the instant the row became `success`, the entry was already readable.
    expect(handoff.successWithoutBytes).toBe(false);
    expect(cache.get(userId, submissionId)).not.toBeNull();
  });
});

describe("digest conflicts", () => {
  it("rejects different content under an already claimed submission id", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "16161616-1616-4616-8616-161616161616";

    await service.generate(userId, { connectionId, modelId, prompt: "draw a cat", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw a cat"), references: [] });

    await expect(service.generate(userId, { connectionId, modelId, prompt: "draw a dog", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw a dog"), references: [] }))
      .rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(upstreamCalls).toBe(1);
  });

  it("detects changed content even when the client re-sends the digest of the old content", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "17171717-1717-4717-8717-171717171717";
    const staleDigest = await digestFor(connectionId, modelId, "draw a cat");

    await service.generate(userId, { connectionId, modelId, prompt: "draw a cat", submissionId, contentDigest: staleDigest, references: [] });

    // The client's declared digest is a claim, not evidence: the server recomputes
    // from the bytes it received, so reusing the id for different content is the
    // conflict §6.3 requires rather than a silent replay of the old result.
    await expect(service.generate(userId, { connectionId, modelId, prompt: "draw a dog", submissionId, contentDigest: staleDigest, references: [] }))
      .rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(upstreamCalls).toBe(1);
  });

  it("refuses a declared digest that does not describe the received content", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    await expect(service.generate(userId, {
      connectionId, modelId, prompt: "draw", submissionId: "18181818-1818-4818-8818-181818181818", contentDigest: "0".repeat(64), references: [],
    })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    expect(upstreamCalls).toBe(0);
    expect(service.listRuns(userId, { limit: 10 }).items).toEqual([]);
  });
});

describe("replay is resolved before current resources are consulted", () => {
  it("replays a successful submission whose connection has since been disabled", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "19191919-1919-4919-8919-191919191919";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };
    await service.generate(userId, input);

    service.updateConnection(userId, connectionId, { name: "gateway", baseUrl: "https://gateway.test", config: {}, enabled: false });

    const replay = await service.generate(userId, input);
    expect(replay.status).toBe("success");
    expect(deliveredBytes(replay)).toBe("image-one");
    expect(upstreamCalls).toBe(1);

    // A disabled connection still refuses new work — only the replay is served.
    await expect(service.generate(userId, { ...input, submissionId: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a", contentDigest: await digestFor(connectionId, modelId, "draw") }))
      .rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    expect(upstreamCalls).toBe(1);
  });

  it("replays a successful submission whose model and connection have been deleted", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };
    await service.generate(userId, input);

    service.deleteModel(userId, connectionId, modelId);
    service.deleteConnection(userId, connectionId);

    const replay = await service.generate(userId, input);
    expect(replay.status).toBe("success");
    expect(deliveredBytes(replay)).toBe("image-one");
    expect(upstreamCalls).toBe(1);
  });

  it("keeps the run readable from history after the connection is deleted", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";
    await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] });
    service.deleteConnection(userId, connectionId);

    const run = service.getRun(userId, runIdOf(userId));
    expect(run.connectionName).toBe("gateway");
    expect(run.providerModelId).toBe("gemini-3.1-flash-image");
  });
});

describe("delivery versus history (CONTRACTS §6.2)", () => {
  it("reports success with a cache miss once the in-process cache is gone", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "21212121-2121-4121-8121-212121212121";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };
    await service.generate(userId, input);

    // A restart: same database, fresh process, empty cache.
    const restarted = new SolarisService(repo, new UserKeyCredentialSource(repo, vault), vault, new ResultCache(10 * 60_000, 8 * 1024 * 1024), { imageResultMaxBytes: IMAGE_BUDGET });
    const replay = await restarted.generate(userId, input);
    expect(replay.status).toBe("success");
    expect(replay.run?.status).toBe("success");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "cache-miss" });
    // A miss is never a reason to call upstream again.
    expect(upstreamCalls).toBe(1);
  });

  it("reports success with a cache miss once the entry has been evicted", async () => {
    const { userId, connectionId, modelId } = fixture();
    // Five bytes each, twelve bytes of budget: three results cannot all fit, so
    // the least recently used one is squeezed out while the run stays success.
    stubUpstream("aaaaa", "bbbbb", "ccccc");
    const tiny = new ResultCache(10 * 60_000, 12);
    const evicting = new SolarisService(repo, new UserKeyCredentialSource(repo, vault), vault, tiny, { imageResultMaxBytes: IMAGE_BUDGET });
    const first = "22222222-2222-4222-8222-222222222222";
    const second = "23232323-2323-4323-8323-232323232323";
    const third = "24242424-2424-4424-8424-242424242424";
    const request = async (submissionId: string, prompt: string) =>
      evicting.generate(userId, { connectionId, modelId, prompt, submissionId, contentDigest: await digestFor(connectionId, modelId, prompt), references: [] });

    expect(deliveredBytes(await request(first, "one"))).toBe("aaaaa");
    expect(deliveredBytes(await request(second, "two"))).toBe("bbbbb");
    // The third result does not fit, so the oldest entry is squeezed out.
    expect(deliveredBytes(await request(third, "three"))).toBe("ccccc");
    expect(tiny.get(userId, first)).toBeNull();
    expect(tiny.get(userId, second)).not.toBeNull();
    expect(tiny.get(userId, third)).not.toBeNull();

    const replay = await request(first, "one");
    expect(replay.status).toBe("success");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "cache-miss" });
    expect(upstreamCalls).toBe(3);
  });

  it("reports success with a cache miss once the entry's TTL has passed", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    let now = 1_000_000;
    const expiring = new ResultCache(1_000, 8 * 1024 * 1024, () => now);
    const withTtl = new SolarisService(repo, new UserKeyCredentialSource(repo, vault), vault, expiring, { imageResultMaxBytes: IMAGE_BUDGET });
    const input = { connectionId, modelId, prompt: "draw", submissionId: "2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d", contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };
    expect(deliveredBytes(await withTtl.generate(userId, input))).toBe("image-one");

    now += 1_001;
    const replay = await withTtl.generate(userId, input);
    expect(replay.status).toBe("success");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "cache-miss" });
    expect(upstreamCalls).toBe(1);
  });

  it("reports an error run as unavailable/not-generated and never resubmits it", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("rejected", "UPSTREAM_FAILED", "The model service refused the request (HTTP 400)"));
    const submissionId = "25252525-2525-4525-8525-252525252525";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };

    const first = await service.generate(userId, input);
    expect(first.status).toBe("error");
    expect(first.result).toEqual({ kind: "unavailable", reason: "not-generated" });
    expect(first.run?.error?.code).toBe("UPSTREAM_FAILED");

    const replay = await service.generate(userId, input);
    expect(replay.status).toBe("error");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "not-generated" });
    expect(upstreamCalls).toBe(1);
  });

  it("reports an uncertain run as unavailable/submission-unknown", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "The model service could not be reached"));
    const submissionId = "26262626-2626-4626-8626-262626262626";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };

    const first = await service.generate(userId, input);
    expect(first.status).toBe("uncertain");
    expect(first.result).toEqual({ kind: "unavailable", reason: "submission-unknown" });

    const replay = await service.generate(userId, input);
    expect(replay.status).toBe("uncertain");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "submission-unknown" });
    expect(upstreamCalls).toBe(1);
  });

  it("keeps a generation that is too large to deliver as success, never error", async () => {
    const { userId, connectionId, modelId } = fixture();
    const payload = "x".repeat(IMAGE_BUDGET + 1);
    stubUpstream(payload);
    const submissionId = "27272727-2727-4727-8727-272727272727";
    const input = { connectionId, modelId, prompt: "draw", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };

    const response = await service.generate(userId, input);
    expect(response.status).toBe("success");
    expect(response.result).toEqual({ kind: "unavailable", reason: "result-too-large" });
    // The metadata stays available even though the bytes cannot be handed back.
    expect(response.run?.status).toBe("success");
    expect(response.run?.images).toEqual([{ mimeType: "image/png", byteSize: IMAGE_BUDGET + 1 }]);
    expect(response.run?.retainedImageCount).toBe(1);
    expect(upstreamCalls).toBe(1);
  });

  it("returns history-deleted with the original status and no run after deletion", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one", new ProviderCallError("rejected", "UPSTREAM_FAILED", "refused"));
    const successId = "28282828-2828-4828-8828-282828282828";
    const errorId = "29292929-2929-4929-8929-292929292929";
    const successInput = { connectionId, modelId, prompt: "draw", submissionId: successId, contentDigest: await digestFor(connectionId, modelId, "draw"), references: [] };
    const errorInput = { connectionId, modelId, prompt: "fail", submissionId: errorId, contentDigest: await digestFor(connectionId, modelId, "fail"), references: [] };
    await service.generate(userId, successInput);
    await service.generate(userId, errorInput);
    expect(upstreamCalls).toBe(2);

    const runs = service.listRuns(userId, { limit: 10 }).items;
    const successRun = runs.find((run) => run.prompt === "draw");
    const errorRun = runs.find((run) => run.prompt === "fail");
    if (!successRun || !errorRun) throw new Error("expected both runs");
    service.deleteRun(userId, successRun.id);
    service.deleteRun(userId, errorRun.id);

    const successReplay = await service.generate(userId, successInput);
    expect(successReplay).toEqual({ submissionId: successId, status: "success", run: null, result: { kind: "unavailable", reason: "history-deleted" } });
    const errorReplay = await service.generate(userId, errorInput);
    expect(errorReplay).toEqual({ submissionId: errorId, status: "error", run: null, result: { kind: "unavailable", reason: "history-deleted" } });

    // Deleting history clears the delivery cache too.
    expect(cache.get(userId, successId)).toBeNull();
    expect(upstreamCalls).toBe(2);
  });

  it("still refuses changed content after the history was deleted", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a";
    await service.generate(userId, { connectionId, modelId, prompt: "draw a cat", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw a cat"), references: [] });
    service.deleteRun(userId, runIdOf(userId));

    await expect(service.generate(userId, { connectionId, modelId, prompt: "draw a dog", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw a dog"), references: [] }))
      .rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(upstreamCalls).toBe(1);

    // The receipt survives deletion: the same content is still never re-sent.
    const replay = await service.generate(userId, { connectionId, modelId, prompt: "draw a cat", submissionId, contentDigest: await digestFor(connectionId, modelId, "draw a cat"), references: [] });
    expect(replay.result).toEqual({ kind: "unavailable", reason: "history-deleted" });
    expect(upstreamCalls).toBe(1);
  });

  it("converges a run left running by a previous process and replays it without upstream", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const submissionId = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b";
    const runId = "2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c";
    const contentDigest = await digestFor(connectionId, modelId, "draw");
    // Claimed but never finished, as a crash mid-call leaves it.
    repo.claimRun({ userId, id: runId, submissionId, contentDigest, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0 });

    // Before the sweep it is still in flight as far as a replay knows.
    const inFlight = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(inFlight.status).toBe("running");
    expect(inFlight.result).toEqual({ kind: "pending" });
    expect(upstreamCalls).toBe(0);

    expect(service.recoverAbandonedRuns()).toEqual([runId]);
    const replay = await service.generate(userId, { connectionId, modelId, prompt: "draw", submissionId, contentDigest, references: [] });
    expect(replay.status).toBe("uncertain");
    expect(replay.result).toEqual({ kind: "unavailable", reason: "submission-unknown" });
    expect(upstreamCalls).toBe(0);
  });
});
