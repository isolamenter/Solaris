import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "./db/index.js";
import { AppError } from "./errors.js";
import { SqliteRepository } from "./repository.js";

/**
 * Storage-level proof for the frozen contract (B02, CONTRACTS §3/§5/§6/§8).
 *
 * Every test here runs against a real SQLite file in a temporary directory, so
 * the transaction, the UNIQUE/CHECK constraints and the conditional UPDATE are
 * genuinely exercised rather than mocked. B05 owns the orchestration suite;
 * this file owns claim/dedup/ownership/state and pagination at the storage
 * boundary.
 */

let root: string;
let sqlite: SqliteDatabase;
let repo: SqliteRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "solaris-repo-"));
  sqlite = openDatabase(root).sqlite;
  repo = new SqliteRepository(sqlite);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

const uuid = () => randomUUID();
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

/** Runs a call that must fail and hands back the typed error for assertions. */
function thrownBy(call: () => unknown): AppError {
  try {
    call();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

function createUser(subject: string): string {
  return repo.createUserWithIdentity({ issuer: "https://idp.test", subject }).id;
}

function createConnection(userId: string, name = "gateway"): string {
  const id = uuid();
  repo.createConnection({ userId, id, name, adapterId: "gemini", baseUrl: "https://gateway.test", config: { region: "eu" }, keyEncrypted: "vault-ciphertext" });
  return id;
}

function createModel(userId: string, connectionId: string, providerModelId = "gemini-3.1-flash-image"): string {
  return repo.upsertModel({ userId, connectionId, providerModelId, capabilities: ["imageGenerate"], manual: true }).id;
}

/** A user with one connection, and nothing else. */
function catalog(subject: string) {
  const userId = createUser(subject);
  return { userId, connectionId: createConnection(userId) };
}

/** A user with one connection and one manual model, ready to claim runs. */
function account(subject: string) {
  const { userId, connectionId } = catalog(subject);
  return { userId, connectionId, modelId: createModel(userId, connectionId) };
}

function claimRun(userId: string, connectionId: string, modelId: string, submissionId: string, contentDigest: string, id = uuid()) {
  return repo.claimRun({
    userId, id, submissionId, contentDigest, connectionId, connectionName: "gateway", modelId,
    providerModelId: "gemini-3.1-flash-image", prompt: "draw a lighthouse", parameters: { quality: "high" }, referenceCount: 2,
  });
}

function finish(runId: string, userId: string, status: "success" | "error" | "uncertain" = "success") {
  return repo.finishRun(userId, runId, {
    status, images: [{ mimeType: "image/png", byteSize: 512 }], returnedImageCount: 1, retainedImageCount: 1,
  });
}

const runRows = (userId: string, submissionId: string) =>
  (sqlite.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_id = ? AND submission_id = ?").get(userId, submissionId) as { count: number }).count;

describe("run claim", () => {
  it("claims a submission exactly once when two callers race with the same digest", async () => {
    const { userId, connectionId, modelId } = account("user-a");
    const submissionId = uuid();
    const contentDigest = digest("a");
    const firstId = uuid();
    const secondId = uuid();

    // One process owns the data directory and the driver is synchronous, so the
    // two calls are serialized around the single (user, submission) transaction:
    // the second caller always observes the committed receipt and cannot claim.
    const [first, second] = await Promise.all([
      (async () => claimRun(userId, connectionId, modelId, submissionId, contentDigest, firstId))(),
      (async () => claimRun(userId, connectionId, modelId, submissionId, contentDigest, secondId))(),
    ]);

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    const winner = first.claimed ? first : second;
    const loser = first.claimed ? second : first;
    expect(winner.claimed).toBe(true);
    expect(loser.claimed).toBe(false);
    // The loser is handed the winner's run and must not create a second one.
    expect(loser.run?.id).toBe(winner.run?.id);
    expect(loser.receipt.runId).toBe(winner.run?.id);
    expect(loser.receipt.status).toBe("running");
    expect(runRows(userId, submissionId)).toBe(1);
  });

  it("rejects the same submission id with a different digest atomically", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const submissionId = uuid();
    claimRun(userId, connectionId, modelId, submissionId, digest("a"));

    const error = thrownBy(() => claimRun(userId, connectionId, modelId, submissionId, digest("b")));
    expect(error.code).toBe("SUBMISSION_CONFLICT");
    expect(error.statusCode).toBe(409);
    // Atomic: the rejected call leaves neither an extra run nor a rewritten receipt.
    expect(runRows(userId, submissionId)).toBe(1);
    expect(repo.getReceipt(userId, submissionId)?.contentDigest).toBe(digest("a"));
  });

  it("keeps identical submission ids independent across users", () => {
    const a = account("user-a");
    const b = account("user-b");
    const submissionId = uuid();

    const claimA = claimRun(a.userId, a.connectionId, a.modelId, submissionId, digest("a"));
    const claimB = claimRun(b.userId, b.connectionId, b.modelId, submissionId, digest("b"));

    expect([claimA.claimed, claimB.claimed]).toEqual([true, true]);
    expect(claimA.run?.id).not.toBe(claimB.run?.id);
    expect(repo.getReceipt(a.userId, submissionId)?.runId).toBe(claimA.run?.id);
    expect(repo.getReceipt(b.userId, submissionId)?.runId).toBe(claimB.run?.id);
    expect(repo.getReceipt(a.userId, submissionId)?.contentDigest).toBe(digest("a"));
  });

  it("records the execution snapshot the caller supplied", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const run = claimRun(userId, connectionId, modelId, uuid(), digest("a")).run;
    expect(run).toMatchObject({
      userId, connectionId, connectionName: "gateway", modelId, providerModelId: "gemini-3.1-flash-image",
      operation: "imageGenerate", status: "running", prompt: "draw a lighthouse", parameters: { quality: "high" },
      referenceCount: 2, returnedImageCount: null, retainedImageCount: null, images: [], error: null,
    });
  });
});

describe("ownership isolation", () => {
  it("never reaches another user's connection, model, run or receipt", () => {
    const a = account("user-a");
    const b = account("user-b");
    const submissionId = uuid();
    const claim = claimRun(a.userId, a.connectionId, a.modelId, submissionId, digest("a"));

    // Every business method carries the caller's userId and answers NOT_FOUND.
    const attempts: [string, () => unknown][] = [
      ["getConnection", () => repo.getConnection(b.userId, a.connectionId)],
      ["updateConnection", () => repo.updateConnection(b.userId, a.connectionId, { name: "stolen", baseUrl: "https://attacker.test", config: {}, enabled: true })],
      ["deleteConnection", () => repo.deleteConnection(b.userId, a.connectionId)],
      ["recordConnectionTest", () => repo.recordConnectionTest(b.userId, a.connectionId, { ok: true, at: new Date().toISOString() })],
      ["listModels", () => repo.listModels(b.userId, a.connectionId)],
      ["getModelForConnection", () => repo.getModelForConnection(b.userId, a.connectionId, a.modelId)],
      ["getModelById", () => repo.getModelById(b.userId, a.modelId)],
      ["upsertModel", () => repo.upsertModel({ userId: b.userId, connectionId: a.connectionId, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true })],
      ["replaceDiscoveredModels", () => repo.replaceDiscoveredModels(b.userId, a.connectionId, [])],
      ["deleteModel", () => repo.deleteModel(b.userId, a.connectionId, a.modelId)],
      ["getRun", () => repo.getRun(b.userId, claim.run!.id)],
      ["finishRun", () => finish(claim.run!.id, b.userId, "success")],
      ["deleteRun", () => repo.deleteRun(b.userId, claim.run!.id)],
    ];
    for (const [name, call] of attempts) {
      const error = thrownBy(call);
      expect(error.code, `${name} must not resolve for a non-owner`).toBe("NOT_FOUND");
      expect(error.statusCode).toBe(404);
    }

    // Nothing of A's was changed, and B has no partial view of it.
    expect(repo.getConnection(a.userId, a.connectionId).name).toBe("gateway");
    expect(repo.getModelById(a.userId, a.modelId).connectionId).toBe(a.connectionId);
    expect(repo.getRun(a.userId, claim.run!.id).status).toBe("running");
    expect(repo.listConnections(b.userId).map((row) => row.id)).toEqual([b.connectionId]);
    expect(repo.listModels(b.userId, b.connectionId).map((row) => row.id)).toEqual([b.modelId]);
    expect(repo.listRuns(b.userId, { limit: 10 }).items).toEqual([]);
    expect(repo.getReceipt(b.userId, submissionId)).toBeUndefined();
  });
});

describe("identity and sessions", () => {
  it("maps one external identity to exactly one user", () => {
    const issuer = "https://idp.test";
    const first = repo.createUserWithIdentity({ issuer, subject: "user-a" });
    const second = repo.createUserWithIdentity({ issuer, subject: "user-a", displayName: "Changed name" });

    expect(second.id).toBe(first.id);
    expect(repo.findUserByExternalIdentity(issuer, "user-a")).toEqual(first);
    // A different subject stays a different user, and a display name is never a key.
    expect(repo.createUserWithIdentity({ issuer, subject: "user-b" }).id).not.toBe(first.id);
    expect(repo.findUserByExternalIdentity(issuer, "nobody")).toBeUndefined();
    expect(thrownBy(() => repo.getUser(uuid())).code).toBe("NOT_FOUND");
  });

  it("only lets the owning user revoke a session", () => {
    const { userId } = catalog("user-a");
    const sessionId = uuid();
    repo.createSession({ id: sessionId, userId, tokenHash: "hash-a", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const stranger = createUser("user-b");
    repo.revokeSession(sessionId, stranger);
    expect(repo.findSessionByTokenHash("hash-a")?.id).toBe(sessionId);

    repo.revokeSession(sessionId, userId);
    expect(repo.findSessionByTokenHash("hash-a")).toBeUndefined();
  });
});

describe("dedup receipt", () => {
  it("survives history deletion and keeps blocking the same submission", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const submissionId = uuid();
    const contentDigest = digest("a");
    const claim = claimRun(userId, connectionId, modelId, submissionId, contentDigest);
    finish(claim.run!.id, userId, "success");

    expect(repo.deleteRun(userId, claim.run!.id)).toEqual({ submissionId });
    expect(thrownBy(() => repo.getRun(userId, claim.run!.id)).code).toBe("NOT_FOUND");

    const receipt = repo.getReceipt(userId, submissionId);
    expect(receipt).toMatchObject({ userId, submissionId, contentDigest, runId: claim.run!.id, status: "success", historyDeleted: true });

    // Same content: no new claim, no run, and the caller learns the history is gone.
    const replay = claimRun(userId, connectionId, modelId, submissionId, contentDigest);
    expect(replay.claimed).toBe(false);
    expect(replay.run).toBeNull();
    expect(replay.receipt.historyDeleted).toBe(true);
    expect(runRows(userId, submissionId)).toBe(0);

    // Changed content is still a conflict.
    expect(thrownBy(() => claimRun(userId, connectionId, modelId, submissionId, digest("b"))).code).toBe("SUBMISSION_CONFLICT");
  });

  it("refuses to delete a run that is still in progress", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const claim = claimRun(userId, connectionId, modelId, uuid(), digest("a"));
    const error = thrownBy(() => repo.deleteRun(userId, claim.run!.id));
    expect(error.code).toBe("RUN_ACTIVE");
    expect(repo.getRun(userId, claim.run!.id).status).toBe("running");
  });
});

describe("conditional terminal update", () => {
  it("moves a running row to a terminal state once and never overwrites it", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const submissionId = uuid();
    const claim = claimRun(userId, connectionId, modelId, submissionId, digest("a"));

    const succeeded = finish(claim.run!.id, userId, "success");
    expect(succeeded.status).toBe("success");
    expect(succeeded.images).toEqual([{ mimeType: "image/png", byteSize: 512 }]);

    // A late "unknown outcome" must not downgrade a proven success.
    const late = finish(claim.run!.id, userId, "uncertain");
    expect(late.status).toBe("success");
    expect(late.images).toEqual([{ mimeType: "image/png", byteSize: 512 }]);
    expect(late.updatedAt).toBe(succeeded.updatedAt);
    expect(repo.getReceipt(userId, submissionId)?.status).toBe("success");

    // And the sweeps leave a terminal row alone.
    expect(repo.recoverAbandonedRuns()).toEqual([]);
    expect(repo.reapStaleRuns({ before: new Date(Date.now() + 60_000).toISOString(), excludeRunIds: [] })).toEqual([]);
    expect(repo.getRun(userId, claim.run!.id).status).toBe("success");
  });

  it("reports NOT_FOUND for a run the caller does not own", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const claim = claimRun(userId, connectionId, modelId, uuid(), digest("a"));
    expect(thrownBy(() => finish(uuid(), userId)).code).toBe("NOT_FOUND");
    expect(repo.getRun(userId, claim.run!.id).status).toBe("running");
  });
});

describe("abandoned run convergence", () => {
  it("converges a previous process's running rows without overwriting another user's receipt", () => {
    const a = account("user-a");
    const b = account("user-b");
    const sharedSubmission = uuid();

    // A is left running; B already finished the same submission id.
    const claimA = claimRun(a.userId, a.connectionId, a.modelId, sharedSubmission, digest("a"));
    const claimB = claimRun(b.userId, b.connectionId, b.modelId, sharedSubmission, digest("b"));
    finish(claimB.run!.id, b.userId, "success");

    expect(repo.recoverAbandonedRuns()).toEqual([claimA.run!.id]);
    expect(repo.getRun(a.userId, claimA.run!.id).status).toBe("uncertain");
    expect(repo.getReceipt(a.userId, sharedSubmission)?.status).toBe("uncertain");
    // Submission ids are unique per user, so converging A must not touch B.
    expect(repo.getReceipt(b.userId, sharedSubmission)?.status).toBe("success");
    expect(repo.getRun(b.userId, claimB.run!.id).status).toBe("success");
  });

  it("reaps only stale rows outside the active set and makes no upstream call", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const stale = claimRun(userId, connectionId, modelId, uuid(), digest("a"));
    const active = claimRun(userId, connectionId, modelId, uuid(), digest("b"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(repo.reapStaleRuns({ before: new Date(Date.now() + 60_000).toISOString(), excludeRunIds: [active.run!.id] })).toEqual([stale.run!.id]);
    expect(repo.getRun(userId, stale.run!.id).status).toBe("uncertain");
    expect(repo.getRun(userId, active.run!.id).status).toBe("running");

    // Convergence is local state only: neither sweep may reach the network.
    repo.reapStaleRuns({ before: new Date(Date.now() + 60_000).toISOString(), excludeRunIds: [] });
    repo.recoverAbandonedRuns();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves rows newer than the cutoff running", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const fresh = claimRun(userId, connectionId, modelId, uuid(), digest("a"));
    expect(repo.reapStaleRuns({ before: new Date(Date.now() - 60_000).toISOString(), excludeRunIds: [] })).toEqual([]);
    expect(repo.getRun(userId, fresh.run!.id).status).toBe("running");
  });
});

describe("in-flight resource guards", () => {
  it("refuses to delete a connection, model or discovery refresh an active run depends on", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const claim = claimRun(userId, connectionId, modelId, uuid(), digest("a"));

    for (const call of [
      () => repo.deleteModel(userId, connectionId, modelId),
      () => repo.deleteConnection(userId, connectionId),
      () => repo.replaceDiscoveredModels(userId, connectionId, []),
    ]) {
      const error = thrownBy(call);
      expect(error.code).toBe("RESOURCE_IN_USE");
      expect(error.statusCode).toBe(409);
    }
    // The dependency is still there while the run is in flight.
    expect(repo.getConnection(userId, connectionId).id).toBe(connectionId);
    expect(repo.getModelById(userId, modelId).id).toBe(modelId);

    finish(claim.run!.id, userId, "success");
    repo.deleteModel(userId, connectionId, modelId);
    expect(thrownBy(() => repo.getModelById(userId, modelId)).code).toBe("NOT_FOUND");
    repo.deleteConnection(userId, connectionId);
    expect(thrownBy(() => repo.getConnection(userId, connectionId)).code).toBe("NOT_FOUND");

    // History keeps the execution snapshot of the deleted resources.
    const run = repo.getRun(userId, claim.run!.id);
    expect(run).toMatchObject({ connectionName: "gateway", providerModelId: "gemini-3.1-flash-image", connectionId });
  });
});

describe("model discovery", () => {
  const discovered = (providerModelId: string) => ({ providerModelId, label: providerModelId.toUpperCase(), capabilities: ["imageGenerate" as const] });
  const providerIds = (rows: { providerModelId: string }[]) => rows.map((row) => row.providerModelId).sort();

  it("keeps a discovered model's row id stable across a refresh", () => {
    const { userId, connectionId } = catalog("user-a");
    repo.replaceDiscoveredModels(userId, connectionId, [discovered("discovered-a"), discovered("discovered-b")]);
    const originalId = repo.listModels(userId, connectionId).find((row) => row.providerModelId === "discovered-a")!.id;

    // A refresh that still lists a model keeps its row, so a saved modelId never
    // starts pointing at a different providerModelId.
    repo.replaceDiscoveredModels(userId, connectionId, [discovered("discovered-a"), discovered("discovered-c")]);
    const refreshed = repo.listModels(userId, connectionId);
    expect(refreshed.find((row) => row.providerModelId === "discovered-a")!.id).toBe(originalId);
    expect(providerIds(refreshed)).toEqual(["discovered-a", "discovered-c"]);
  });

  it("preserves manual models across refreshes", () => {
    const { userId, connectionId } = catalog("user-a");
    const manual = repo.upsertModel({ userId, connectionId, providerModelId: "hand-picked", label: "Hand picked", capabilities: ["imageGenerate"], manual: true });

    // Discovery lists the same id: the user's own row wins and is not adopted.
    repo.replaceDiscoveredModels(userId, connectionId, [discovered("hand-picked"), discovered("discovered-a")]);
    expect(repo.listModels(userId, connectionId).find((row) => row.providerModelId === "hand-picked"))
      .toMatchObject({ id: manual.id, label: "Hand picked", manual: true });

    // Discovery no longer lists it: it still survives, unlike a discovered row.
    repo.replaceDiscoveredModels(userId, connectionId, []);
    const remaining = repo.listModels(userId, connectionId);
    expect(providerIds(remaining)).toEqual(["hand-picked"]);
    expect(remaining[0]).toMatchObject({ id: manual.id, manual: true });
  });
});

describe("history pagination", () => {
  /** Walks every page and returns the ids in the order the pages produced them. */
  function collect(userId: string, limit: number): string[] {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = repo.listRuns(userId, { limit, cursor });
      ids.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) return ids;
      cursor = page.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }

  function seed(userId: string, connectionId: string, modelId: string, count: number): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = uuid();
      claimRun(userId, connectionId, modelId, uuid(), digest(String(index % 10)), id);
      ids.push(id);
    }
    return ids;
  }

  it("pages through every row exactly once without a cursor", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const ids = seed(userId, connectionId, modelId, 25);
    const single = repo.listRuns(userId, { limit: 100 }).items.map((item) => item.id);
    expect(new Set(single).size).toBe(25);
    expect(collect(userId, 7)).toEqual(single);
    expect(new Set(ids)).toEqual(new Set(single));
  });

  it("stays stable when every row shares one millisecond", () => {
    const { userId, connectionId, modelId } = account("user-a");
    const ids = seed(userId, connectionId, modelId, 25);
    // The id tie-break exists for exactly this case: (created_at) alone is not
    // a total order once a burst of runs shares the same millisecond.
    sqlite.prepare("UPDATE runs SET created_at = ?, updated_at = ? WHERE user_id = ?").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", userId);

    const ordered = [...ids].sort().reverse();
    expect(collect(userId, 7)).toEqual(ordered);
    expect(repo.listRuns(userId, { limit: 7 }).nextCursor).not.toBeNull();

    // A full page ends without a cursor.
    expect(repo.listRuns(userId, { limit: 25 }).nextCursor).toBeNull();
  });

  it("rejects a malformed cursor and does not leak another user's rows", () => {
    const a = account("user-a");
    const b = account("user-b");
    const aIds = seed(a.userId, a.connectionId, a.modelId, 25);
    const bIds = seed(b.userId, b.connectionId, b.modelId, 3);

    expect(thrownBy(() => repo.listRuns(a.userId, { limit: 10, cursor: "not-a-cursor" })).code).toBe("VALIDATION");

    const cursor = repo.listRuns(a.userId, { limit: 10 }).nextCursor;
    expect(cursor).not.toBeNull();
    const stolenPage = repo.listRuns(b.userId, { limit: 10, cursor: cursor ?? undefined });
    expect(stolenPage.items.every((item) => item.userId === b.userId)).toBe(true);
    expect(stolenPage.items.map((item) => item.id).filter((id) => aIds.includes(id))).toEqual([]);
    expect(new Set(collect(b.userId, 2))).toEqual(new Set(bIds));
  });
});
