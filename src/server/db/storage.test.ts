import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "./index.js";
import { SqliteRepository } from "../repository.js";

/**
 * Storage-layer proof for the frozen contract (B02, CONTRACTS §4.2/§6/§8.1).
 *
 * Covers what the DDL itself has to guarantee: the legacy directory is refused
 * without being touched, no image bytes can be stored, identifiers are UUIDs,
 * and no table or repository method from the removed video/Batch design
 * survives.
 */

let root: string;
let sqlite: SqliteDatabase;
let repo: SqliteRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "solaris-storage-"));
  sqlite = openDatabase(root).sqlite;
  repo = new SqliteRepository(sqlite);
});

afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

const uuid = () => randomUUID();
const NEW_TABLES = ["connections", "external_identities", "models", "receipts", "runs", "sessions", "users"];
const REMOVED_TABLES = ["profiles", "conversations", "messages", "jobs", "assets", "run_assets", "batch_jobs", "batch_entries"];

/** Every table this schema defines, ignoring SQLite's own bookkeeping tables. */
function tableNames(database: SqliteDatabase): string[] {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return rows.map((row) => row.name).sort();
}

/** Relative path -> content hash for every file under a directory. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const relative of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const full = join(dir, relative);
    if (statSync(full).isFile()) files[relative] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return files;
}

function rejection(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the write to be rejected");
}

function fixture() {
  const userId = repo.createUserWithIdentity({ issuer: "https://idp.test", subject: "user-a" }).id;
  const connectionId = uuid();
  repo.createConnection({ userId, id: connectionId, name: "gateway", adapterId: "gemini", baseUrl: "https://gateway.test", config: {}, keyEncrypted: "vault-ciphertext" });
  const modelId = repo.upsertModel({ userId, connectionId, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true }).id;
  return { userId, connectionId, modelId };
}

describe("new schema", () => {
  it("creates only the synchronous single-generation tables", () => {
    const tables = tableNames(sqlite);
    expect(tables).toEqual(NEW_TABLES);
    for (const removed of REMOVED_TABLES) expect(tables).not.toContain(removed);

    // No repository method still speaks the video/Batch/asset vocabulary.
    const methods = Object.getOwnPropertyNames(SqliteRepository.prototype);
    expect(methods.filter((name) => /job|batch|asset|conversation|message/i.test(name))).toEqual([]);
  });

  it("keeps receipts and runs across a close and reopen", () => {
    const { userId, connectionId, modelId } = fixture();
    const submissionId = uuid();
    const contentDigest = "a".repeat(64);
    const claim = repo.claimRun({
      userId, id: uuid(), submissionId, contentDigest, connectionId, connectionName: "gateway", modelId,
      providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0,
    });
    repo.finishRun(userId, claim.run!.id, { status: "success", images: [], returnedImageCount: 1, retainedImageCount: 1 });

    sqlite.close();
    sqlite = openDatabase(root).sqlite;
    const reopened = new SqliteRepository(sqlite);
    expect(reopened.getReceipt(userId, submissionId)?.runId).toBe(claim.run!.id);
    expect(reopened.getRun(userId, claim.run!.id).status).toBe("success");
    // The dedup guarantee survives the restart: the same submission never re-claims.
    const replay = reopened.claimRun({
      userId, id: uuid(), submissionId, contentDigest, connectionId, connectionName: "gateway", modelId,
      providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0,
    });
    expect(replay.claimed).toBe(false);
  });
});

describe("legacy data directory", () => {
  it("refuses the old schema without modifying or deleting a single byte", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "solaris-legacy-"));
    try {
      const legacyFile = join(legacyRoot, "solaris.sqlite");
      // The old single-user BFF left a rollback-journal database plus an image tree.
      const legacy = new Database(legacyFile);
      legacy.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY)");
      legacy.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY)");
      legacy.exec("CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT)");
      legacy.prepare("INSERT INTO profiles (id) VALUES ('legacy-profile')").run();
      legacy.prepare("INSERT INTO assets (id, path) VALUES ('a1', 'assets/08/legacy.png')").run();
      legacy.close();
      mkdirSync(join(legacyRoot, "assets", "08"), { recursive: true });
      writeFileSync(join(legacyRoot, "assets", "08", "legacy.png"), "legacy-image-bytes");
      const before = snapshot(legacyRoot);

      const error = rejection(() => openDatabase(legacyRoot));
      expect(error.message).toMatch(/pre-refactor schema/);
      // Actionable: it names the offending tables and points at a fresh directory.
      expect(error.message).toContain("jobs");
      expect(error.message).toMatch(/new, empty directory/);

      // Unauthorized cleanup is not part of the refusal (D7: no migration).
      expect(snapshot(legacyRoot)).toEqual(before);
      expect(readFileSync(join(legacyRoot, "assets", "08", "legacy.png"), "utf8")).toBe("legacy-image-bytes");
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  it("leaves a WAL-mode legacy database byte-for-byte intact", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "solaris-legacy-"));
    try {
      const legacy = new Database(join(legacyRoot, "solaris.sqlite"));
      // The deployed old server ran in WAL mode, so the probe must not switch
      // journal modes or recover a WAL before it has decided to refuse.
      legacy.pragma("journal_mode = WAL");
      legacy.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY)");
      legacy.prepare("INSERT INTO jobs (id) VALUES ('legacy-job')").run();
      legacy.close();
      const before = snapshot(legacyRoot);

      expect(rejection(() => openDatabase(legacyRoot)).message).toMatch(/pre-refactor schema/);
      expect(snapshot(legacyRoot)).toEqual(before);
      expect(readdirSync(legacyRoot).sort()).toEqual(Object.keys(before).sort());
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  it("refuses a directory holding only one legacy table", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "solaris-legacy-"));
    try {
      const legacy = new Database(join(legacyRoot, "solaris.sqlite"));
      legacy.exec("CREATE TABLE batch_entries (id TEXT PRIMARY KEY)");
      legacy.close();
      expect(rejection(() => openDatabase(legacyRoot)).message).toMatch(/batch_entries/);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

describe("no image bytes in storage", () => {
  const CANARY = "SOLARIS_IMAGE_PAYLOAD_CANARY_iVBORw0KGgoAAAANSUhEUg";

  it("stores image dimensions only and leaves no payload in the database or the directory", () => {
    const { userId, connectionId, modelId } = fixture();
    const submissionId = uuid();
    const claim = repo.claimRun({
      userId, id: uuid(), submissionId, contentDigest: "a".repeat(64), connectionId, connectionName: "gateway", modelId,
      providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 1,
    });
    const finished = repo.finishRun(userId, claim.run!.id, {
      status: "success", images: [{ mimeType: "image/png", byteSize: CANARY.length }], returnedImageCount: 1, retainedImageCount: 1,
    });

    // A row can carry a MIME type and a size, never a payload.
    for (const image of finished.images) expect(Object.keys(image).sort()).toEqual(["byteSize", "mimeType"]);
    expect(Object.keys(finished).filter((field) => /byte|base64|blob|payload|data/i.test(field))).toEqual([]);

    // Likewise the schema: every column is TEXT or INTEGER, so there is no BLOB
    // that a decoded image could be written into.
    for (const table of NEW_TABLES) {
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) expect(["TEXT", "INTEGER"], `${table}.${column.name}`).toContain(column.type);
    }

    // The stored image list is exactly the two-field reference, and the payload
    // appears nowhere in the rows or in the files of the data directory.
    const stored = sqlite.prepare("SELECT images_json FROM runs WHERE id = ?").get(claim.run!.id) as { images_json: string };
    expect(JSON.parse(stored.images_json)).toEqual([{ mimeType: "image/png", byteSize: CANARY.length }]);

    const dump = NEW_TABLES.flatMap((table) => sqlite.prepare(`SELECT * FROM ${table}`).all()).map((row) => JSON.stringify(row)).join("\n");
    expect(dump).not.toContain(CANARY);
    for (const [name, hash] of Object.entries(snapshot(root))) {
      expect(readFileSync(join(root, name)).includes(CANARY), `${name} (${hash}) must hold no image payload`).toBe(false);
    }
  });
});

describe("UUID constraints", () => {
  it("rejects a non-UUID connection id and user id through the repository", () => {
    const { userId } = fixture();
    expect(rejection(() => repo.createConnection({
      userId, id: "connection-1", name: "gateway", adapterId: "gemini", baseUrl: "https://gateway.test", config: {}, keyEncrypted: "ciphertext",
    })).message).toMatch(/CHECK constraint failed/);

    expect(rejection(() => repo.createSession({ id: uuid(), userId: "user-1", tokenHash: "hash", expiresAt: new Date().toISOString() })).message)
      .toMatch(/CHECK constraint failed/);

    expect(rejection(() => repo.claimRun({
      userId: "user-1", id: uuid(), submissionId: uuid(), contentDigest: "a".repeat(64), connectionId: uuid(),
      connectionName: "gateway", modelId: uuid(), providerModelId: "gemini-3.1-flash-image", prompt: "draw", parameters: {}, referenceCount: 0,
    })).message).toMatch(/CHECK constraint failed/);
  });

  it("constrains every row id and ownership column in the DDL", () => {
    const { userId, connectionId } = fixture();
    const at = new Date().toISOString();
    // Raw writes prove the constraint exists even where the API generates ids.
    expect(rejection(() => sqlite.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)").run("legacy-id", null, at)).message)
      .toMatch(/CHECK constraint failed/);
    expect(rejection(() => sqlite.prepare("INSERT INTO runs (id, user_id, submission_id, content_digest, connection_id, connection_name, model_id, provider_model_id, operation, status, prompt, parameters_json, reference_count, images_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("run-1", userId, uuid(), "a".repeat(64), connectionId, "gateway", uuid(), "gemini-3.1-flash-image", "imageGenerate", "running", "draw", "{}", 0, "[]", at, at)).message)
      .toMatch(/CHECK constraint failed/);
    expect(rejection(() => sqlite.prepare("INSERT INTO models (id, user_id, connection_id, provider_model_id, label, capabilities_json, manual, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(uuid(), userId, "connection-1", "m", "m", "[]", 0, 1, at, at)).message)
      .toMatch(/CHECK constraint failed/);
  });
});
