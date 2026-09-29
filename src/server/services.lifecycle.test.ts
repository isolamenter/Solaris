import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentDigest } from "../shared/digest.js";
import { AesCredentialVault, UserKeyCredentialSource } from "./credentials/index.js";
import { openDatabase, type SqliteDatabase } from "./db/index.js";
import { gemini } from "./providers/gemini.js";
import { ProviderCallError } from "./providers/types.js";
import { SqliteRepository } from "./repository.js";
import { ResultCache } from "./resultCache.js";
import { SolarisService } from "./services.js";

/**
 * B05 — active runs, in-flight protection and failure classification
 * (CONTRACTS §4.2, §5, §7), plus the two properties that must hold for the
 * Server as a whole: it stores no image bytes and no credential anywhere, and
 * the removed video/Batch/asset surface never comes back.
 */

const API_KEY = "upstream-api-key-value";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const IMAGE_BUDGET = 4 * 1024 * 1024;

let root: string;
let sqlite: SqliteDatabase;
let repo: SqliteRepository;
let vault: AesCredentialVault;
let service: SolarisService;
let upstreamCalls: number;

const realImageGenerate = gemini.operations.imageGenerate;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "solaris-lifecycle-"));
  sqlite = openDatabase(root).sqlite;
  repo = new SqliteRepository(sqlite);
  vault = new AesCredentialVault(MASTER_KEY);
  service = new SolarisService(
    repo, new UserKeyCredentialSource(repo, vault), vault, new ResultCache(10 * 60_000, 8 * 1024 * 1024), { imageResultMaxBytes: IMAGE_BUDGET },
  );
  upstreamCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
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

function stubUpstream(payload: string | Error) {
  gemini.operations.imageGenerate = async () => {
    upstreamCalls += 1;
    if (payload instanceof Error) throw payload;
    return {
      images: [{ bytes: Buffer.from(payload), mimeType: "image/png" }],
      returnedImageCount: 1,
      diagnostics: { durationMs: 1, returnedImageCount: 1 },
    };
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const digestFor = (connectionId: string, modelId: string, prompt: string) =>
  contentDigest({ connectionId, modelId, prompt, parameters: null, references: [] });

const runIdOf = (userId: string) => {
  const run = service.listRuns(userId, { limit: 10 }).items[0];
  if (!run) throw new Error("expected a run");
  return run.id;
};

/** A request the tests can reuse verbatim. */
async function requestFor(target: { connectionId: string; modelId: string }, prompt = "draw", submissionId = randomUUID()) {
  return { connectionId: target.connectionId, modelId: target.modelId, prompt, submissionId, contentDigest: await digestFor(target.connectionId, target.modelId, prompt), references: [] };
}

describe("in-flight protection", () => {
  it("does not reap a run whose call is still in flight, however old the row looks", async () => {
    const { userId, connectionId, modelId } = fixture();
    const gate = deferred();
    const entered = deferred();
    gemini.operations.imageGenerate = async () => {
      upstreamCalls += 1;
      entered.resolve();
      await gate.promise;
      return { images: [{ bytes: Buffer.from("image-one"), mimeType: "image/png" }], returnedImageCount: 1, diagnostics: { durationMs: 1, returnedImageCount: 1 } };
    };
    const input = await requestFor({ connectionId, modelId });

    const inFlight = service.generate(userId, input);
    await entered.promise;
    const runId = runIdOf(userId);
    // The row is genuinely older than the sweep's cutoff: age alone would reap it.
    const before = new Date(Date.now() + 60_000).toISOString();
    expect(repo.getRun(userId, runId).updatedAt < before).toBe(true);

    expect(service.reapStaleRuns(before)).toEqual([]);
    expect(repo.getRun(userId, runId).status).toBe("running");
    expect(repo.getReceipt(userId, input.submissionId)?.status).toBe("running");

    gate.resolve();
    const response = await inFlight;
    expect(response.status).toBe("success");
    expect(upstreamCalls).toBe(1);
  });

  it("reaps a stale run that is not in flight", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const input = await requestFor({ connectionId, modelId });
    const runId = randomUUID();
    // Left `running` by a process that died before it could finish the call.
    repo.claimRun({ userId, id: runId, submissionId: input.submissionId, contentDigest: input.contentDigest, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0 });

    expect(service.reapStaleRuns(new Date(Date.now() + 60_000).toISOString())).toEqual([runId]);
    expect(repo.getRun(userId, runId).status).toBe("uncertain");
  });

  it("makes no upstream call in the startup sweep", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const input = await requestFor({ connectionId, modelId });
    const runId = randomUUID();
    repo.claimRun({ userId, id: runId, submissionId: input.submissionId, contentDigest: input.contentDigest, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0 });

    expect(service.recoverAbandonedRuns()).toEqual([runId]);
    expect(upstreamCalls).toBe(0);
  });

  it("makes no upstream call in the periodic reaper", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    const input = await requestFor({ connectionId, modelId });
    const runId = randomUUID();
    repo.claimRun({ userId, id: runId, submissionId: input.submissionId, contentDigest: input.contentDigest, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0 });

    expect(service.reapStaleRuns(new Date(Date.now() + 60_000).toISOString())).toEqual([runId]);
    expect(upstreamCalls).toBe(0);
  });
});

describe("failure classification (CONTRACTS §5, §7)", () => {
  it("records a rejected call as a determinate error", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("rejected", "UPSTREAM_FAILED", "The model service refused the request (HTTP 400)"));
    const response = await service.generate(userId, await requestFor({ connectionId, modelId }));

    expect(response.status).toBe("error");
    expect(response.result).toEqual({ kind: "unavailable", reason: "not-generated" });
    expect(response.run?.error).toEqual({ code: "UPSTREAM_FAILED", message: "The model service refused the request (HTTP 400)" });
    expect(response.run?.returnedImageCount).toBeNull();
  });

  it("records a 200 with no usable image as an error, never uncertain", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("rejected", "UPSTREAM_NO_IMAGE", "The model service returned no usable image for this request"));
    const response = await service.generate(userId, await requestFor({ connectionId, modelId }));

    // The response arrived in full and held no image: that is determinate.
    expect(response.status).toBe("error");
    expect(response.result).toEqual({ kind: "unavailable", reason: "not-generated" });
    expect(response.run?.error?.code).toBe("UPSTREAM_NO_IMAGE");
  });

  it("records an outcome that may have been accepted as terminal uncertain", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE", "The model service could not be reached"));
    const response = await service.generate(userId, await requestFor({ connectionId, modelId }));

    expect(response.status).toBe("uncertain");
    expect(response.result).toEqual({ kind: "unavailable", reason: "submission-unknown" });
    expect(response.run?.error?.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("keeps an over-budget response uncertain with unknown counts and result-too-large", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream(new ProviderCallError("unknown", "RESULT_TOO_LARGE", "The model service response exceeded the configured limit"));
    const response = await service.generate(userId, await requestFor({ connectionId, modelId }));

    expect(response.status).toBe("uncertain");
    expect(response.result).toEqual({ kind: "unavailable", reason: "result-too-large" });
    // Nothing is claimed about how many images upstream produced.
    expect(response.run?.returnedImageCount).toBeNull();
    expect(response.run?.retainedImageCount).toBeNull();
  });

  it("leaves no run behind when the adapter has no image operation", async () => {
    const { userId, connectionId, modelId } = fixture();
    stubUpstream("image-one");
    gemini.operations.imageGenerate = undefined;

    await expect(service.generate(userId, await requestFor({ connectionId, modelId })))
      .rejects.toMatchObject({ code: "OPERATION_UNAVAILABLE" });
    // A call that was never made must not leave a running row (or receipt) that
    // a client would keep polling.
    expect(upstreamCalls).toBe(0);
    expect(service.listRuns(userId, { limit: 10 }).items).toEqual([]);
  });
});

describe("the Server holds no image bytes and no credential", () => {
  const marker = `SOLARIS-IMAGE-PAYLOAD-${randomUUID()}`;
  const base64Marker = Buffer.from(marker).toString("base64");

  function filesIn(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  }

  function expectNothingOnDisk() {
    const files = filesIn(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(file, "latin1");
      expect(contents, `${file} must not hold image bytes`).not.toContain(marker);
      expect(contents, `${file} must not hold encoded image bytes`).not.toContain(base64Marker);
      expect(contents, `${file} must not hold the plaintext credential`).not.toContain(API_KEY);
    }
  }

  function captureConsole(): string[] {
    const captured: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((value) => String(value)).join(" "));
      });
    }
    return captured;
  }

  it("stores only metadata after a delivered generation, and logs nothing sensitive", async () => {
    const { userId, connectionId, modelId } = fixture();
    const logged = captureConsole();
    const payload = Buffer.concat([Buffer.from(marker), randomBytes(2048)]);
    gemini.operations.imageGenerate = async () => {
      upstreamCalls += 1;
      return { images: [{ bytes: payload, mimeType: "image/png" }], returnedImageCount: 1, diagnostics: { durationMs: 1, returnedImageCount: 1 } };
    };

    const response = await service.generate(userId, await requestFor({ connectionId, modelId }));
    expect(response.result.kind).toBe("delivered");

    const run = service.getRun(userId, runIdOf(userId));
    expect(run.images).toEqual([{ mimeType: "image/png", byteSize: payload.byteLength }]);
    for (const image of run.images) expect(Object.keys(image).sort()).toEqual(["byteSize", "mimeType"]);
    expect(JSON.stringify(run)).not.toContain("dataBase64");
    expect(JSON.stringify(service.listRuns(userId, { limit: 10 }))).not.toContain("dataBase64");

    expectNothingOnDisk();
    const output = logged.join("\n");
    expect(output).not.toContain(marker);
    expect(output).not.toContain(base64Marker);
    expect(output).not.toContain(API_KEY);
  });

  it("stores no image bytes for a failed generation either", async () => {
    const { userId, connectionId, modelId } = fixture();
    const logged = captureConsole();
    const payload = Buffer.concat([Buffer.from(marker), randomBytes(2048)]);
    gemini.operations.imageGenerate = async () => {
      upstreamCalls += 1;
      return { images: [{ bytes: payload, mimeType: "image/png" }], returnedImageCount: 1, diagnostics: { durationMs: 1, returnedImageCount: 1 } };
    };
    // First run succeeds and delivers; the second fails, so both paths are on disk.
    await service.generate(userId, await requestFor({ connectionId, modelId }));
    gemini.operations.imageGenerate = async () => {
      upstreamCalls += 1;
      throw new ProviderCallError("rejected", "UPSTREAM_FAILED", "The model service refused the request (HTTP 500)");
    };
    const failed = await service.generate(userId, await requestFor({ connectionId, modelId }));
    expect(failed.status).toBe("error");

    const stored = service.listRuns(userId, { limit: 10 }).items.flatMap((run) => [run.error, run.images]);
    expect(JSON.stringify(stored)).not.toContain(base64Marker);
    expectNothingOnDisk();
    expect(logged.join("\n")).not.toContain(API_KEY);
  });
});

describe("removed surface stays removed", () => {
  it("has no server-side asset store and no video or Batch orchestration", () => {
    // The deleted modules and the removed runner must not come back.
    expect(existsSync("src/server/assets.ts")).toBe(false);
    expect(existsSync("src/server/runner.ts")).toBe(false);
    const sources = readdirSync("src", { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const contents = readFileSync(file, "utf8");
      // A definition, not a comment about the removal.
      expect(contents, `${file} must not define the video runner`).not.toMatch(/\b(?:class|function|const|let)\s+VideoRunner\b/);
    }
  });
});
