import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import type { SqliteDatabase } from "./db/index.js";
import type { ConnectionRow, ModelRow, ReceiptRow, Repository, RunRow, SessionRow, UserRow } from "./interfaces.js";
import type { AdapterId, ConnectionTestDto, Operation, ParameterValues, RunImageRefDto, RunStatus } from "../shared/contracts.js";
import type { DiscoveredModel } from "./providers/types.js";

const now = () => new Date().toISOString();
const parse = <T>(value: string | null | undefined, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const supportedOperations = new Set<Operation>(["imageGenerate"]);
const normalizeOperations = (value: unknown): Operation[] =>
  Array.isArray(value) ? value.filter((item): item is Operation => typeof item === "string" && supportedOperations.has(item as Operation)) : [];

type UserDbRow = { id: string; display_name: string | null; created_at: string };
type SessionDbRow = { id: string; user_id: string; token_hash: string; expires_at: string; revoked_at: string | null };
type ConnectionDbRow = {
  id: string; user_id: string; name: string; adapter_id: AdapterId; base_url: string;
  config_json: string; key_encrypted: string | null; enabled: number; last_test_json: string | null;
  created_at: string; updated_at: string;
};
type ModelDbRow = {
  id: string; user_id: string; connection_id: string; provider_model_id: string; label: string;
  capabilities_json: string; manual: number; enabled: number; created_at: string; updated_at: string;
};
type ReceiptDbRow = {
  user_id: string; submission_id: string; content_digest: string; run_id: string;
  status: RunStatus; history_deleted: number; created_at: string;
};
type RunDbRow = {
  id: string; user_id: string; submission_id: string; content_digest: string; connection_id: string;
  connection_name: string; model_id: string; provider_model_id: string; operation: Operation; status: RunStatus;
  prompt: string; parameters_json: string; reference_count: number; returned_image_count: number | null;
  retained_image_count: number | null; images_json: string; error_json: string | null;
  created_at: string; updated_at: string;
};

const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);

export class SqliteRepository implements Repository {
  constructor(private readonly sqlite: SqliteDatabase) {}

  private userRow(row: UserDbRow): UserRow {
    return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
  }
  private sessionRow(row: SessionDbRow): SessionRow {
    return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at, revokedAt: row.revoked_at };
  }
  private connectionRow(row: ConnectionDbRow): ConnectionRow {
    return {
      id: row.id, userId: row.user_id, name: row.name, adapterId: row.adapter_id, baseUrl: row.base_url,
      config: parse<Record<string, unknown>>(row.config_json, {}), keyEncrypted: row.key_encrypted,
      enabled: Boolean(row.enabled), lastTest: parse<ConnectionTestDto | null>(row.last_test_json, null),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  private modelRow(row: ModelDbRow): ModelRow {
    return {
      id: row.id, userId: row.user_id, connectionId: row.connection_id, providerModelId: row.provider_model_id,
      label: row.label, capabilities: normalizeOperations(parse<unknown>(row.capabilities_json, [])),
      manual: Boolean(row.manual), enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  private receiptRow(row: ReceiptDbRow): ReceiptRow {
    return {
      userId: row.user_id, submissionId: row.submission_id, contentDigest: row.content_digest, runId: row.run_id,
      status: row.status, historyDeleted: Boolean(row.history_deleted), createdAt: row.created_at,
    };
  }
  private runRow(row: RunDbRow): RunRow {
    return {
      id: row.id, userId: row.user_id, submissionId: row.submission_id, contentDigest: row.content_digest,
      connectionId: row.connection_id, connectionName: row.connection_name, modelId: row.model_id,
      providerModelId: row.provider_model_id, operation: row.operation, status: row.status, prompt: row.prompt,
      parameters: parse<ParameterValues>(row.parameters_json, {}), referenceCount: row.reference_count,
      returnedImageCount: row.returned_image_count, retainedImageCount: row.retained_image_count,
      images: parse<RunImageRefDto[]>(row.images_json, []), error: parse<{ code: string; message: string } | null>(row.error_json, null),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // -- identity ------------------------------------------------------------

  findUserByExternalIdentity(issuer: string, subject: string): UserRow | undefined {
    const row = this.sqlite
      .prepare("SELECT u.* FROM users u JOIN external_identities e ON e.user_id = u.id WHERE e.issuer = ? AND e.subject = ?")
      .get(issuer, subject) as UserDbRow | undefined;
    return row ? this.userRow(row) : undefined;
  }

  createUserWithIdentity(input: { issuer: string; subject: string; displayName?: string }): UserRow {
    const time = now();
    const userId = randomUUID();
    const transaction = this.sqlite.transaction(() => {
      // A concurrent login for the same identity must resolve to one user.
      const existing = this.sqlite
        .prepare("SELECT u.* FROM users u JOIN external_identities e ON e.user_id = u.id WHERE e.issuer = ? AND e.subject = ?")
        .get(input.issuer, input.subject) as UserDbRow | undefined;
      if (existing) return existing;
      this.sqlite.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)").run(userId, input.displayName ?? null, time);
      this.sqlite
        .prepare("INSERT INTO external_identities (id, user_id, issuer, subject, created_at) VALUES (?,?,?,?,?)")
        .run(randomUUID(), userId, input.issuer, input.subject, time);
      return this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserDbRow;
    });
    return this.userRow(transaction());
  }

  getUser(userId: string): UserRow {
    const row = this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserDbRow | undefined;
    if (!row) throw notFound("User");
    return this.userRow(row);
  }

  // -- sessions ------------------------------------------------------------

  createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): void {
    this.sqlite
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES (?,?,?,?,NULL,?)")
      .run(input.id, input.userId, input.tokenHash, input.expiresAt, now());
  }

  findSessionByTokenHash(tokenHash: string): SessionRow | undefined {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as SessionDbRow | undefined;
    return row ? this.sessionRow(row) : undefined;
  }

  revokeSession(sessionId: string, userId: string): void {
    this.sqlite.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), sessionId, userId);
  }

  // -- connections ---------------------------------------------------------

  listConnections(userId: string): ConnectionRow[] {
    const rows = this.sqlite.prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as ConnectionDbRow[];
    return rows.map((row) => this.connectionRow(row));
  }

  getConnection(userId: string, connectionId: string): ConnectionRow {
    const row = this.sqlite.prepare("SELECT * FROM connections WHERE id = ? AND user_id = ?").get(connectionId, userId) as ConnectionDbRow | undefined;
    if (!row) throw notFound("Connection");
    return this.connectionRow(row);
  }

  createConnection(input: { userId: string; id: string; name: string; adapterId: AdapterId; baseUrl: string; config: Record<string, unknown>; keyEncrypted: string }): ConnectionRow {
    const time = now();
    this.sqlite
      .prepare("INSERT INTO connections (id, user_id, name, adapter_id, base_url, config_json, key_encrypted, enabled, last_test_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,NULL,?,?)")
      .run(input.id, input.userId, input.name, input.adapterId, input.baseUrl, JSON.stringify(input.config), input.keyEncrypted, time, time);
    return this.getConnection(input.userId, input.id);
  }

  updateConnection(userId: string, connectionId: string, input: { name: string; baseUrl: string; config: Record<string, unknown>; enabled: boolean; keyEncrypted?: string }): ConnectionRow {
    this.getConnection(userId, connectionId);
    this.sqlite
      .prepare("UPDATE connections SET name = ?, base_url = ?, config_json = ?, enabled = ?, key_encrypted = COALESCE(?, key_encrypted), updated_at = ? WHERE id = ? AND user_id = ?")
      .run(input.name, input.baseUrl, JSON.stringify(input.config), Number(input.enabled), input.keyEncrypted ?? null, now(), connectionId, userId);
    return this.getConnection(userId, connectionId);
  }

  deleteConnection(userId: string, connectionId: string): void {
    this.getConnection(userId, connectionId);
    this.assertNoActiveRun(userId, "connection_id", connectionId, "Connection");
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM models WHERE connection_id = ? AND user_id = ?").run(connectionId, userId);
      this.sqlite.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").run(connectionId, userId);
    })();
  }

  recordConnectionTest(userId: string, connectionId: string, test: ConnectionTestDto): void {
    this.getConnection(userId, connectionId);
    this.sqlite.prepare("UPDATE connections SET last_test_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(test), now(), connectionId, userId);
  }

  // -- models --------------------------------------------------------------

  listModels(userId: string, connectionId: string): ModelRow[] {
    this.getConnection(userId, connectionId);
    const rows = this.sqlite
      .prepare("SELECT * FROM models WHERE user_id = ? AND connection_id = ? ORDER BY manual DESC, label COLLATE NOCASE")
      .all(userId, connectionId) as ModelDbRow[];
    return rows.map((row) => this.modelRow(row));
  }

  getModelForConnection(userId: string, connectionId: string, modelId: string): ModelRow {
    const row = this.sqlite.prepare("SELECT * FROM models WHERE id = ? AND user_id = ? AND connection_id = ?").get(modelId, userId, connectionId) as ModelDbRow | undefined;
    if (!row) throw notFound("Model");
    return this.modelRow(row);
  }

  getModelById(userId: string, modelId: string): ModelRow {
    const row = this.sqlite.prepare("SELECT * FROM models WHERE id = ? AND user_id = ?").get(modelId, userId) as ModelDbRow | undefined;
    if (!row) throw notFound("Model");
    return this.modelRow(row);
  }

  upsertModel(input: { userId: string; connectionId: string; providerModelId: string; label?: string; capabilities: Operation[]; manual: boolean; enabled?: boolean }): ModelRow {
    this.getConnection(input.userId, input.connectionId);
    const time = now();
    const capabilities = normalizeOperations(input.capabilities);
    const existing = this.sqlite
      .prepare("SELECT id FROM models WHERE user_id = ? AND connection_id = ? AND provider_model_id = ?")
      .get(input.userId, input.connectionId, input.providerModelId) as { id: string } | undefined;
    if (existing) {
      // Keep the row id stable so an id never starts pointing at a different model.
      this.sqlite
        .prepare("UPDATE models SET label = ?, capabilities_json = ?, manual = ?, enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(input.label ?? input.providerModelId, JSON.stringify(capabilities), Number(input.manual), Number(input.enabled ?? true), time, existing.id, input.userId);
      return this.getModelById(input.userId, existing.id);
    }
    const id = randomUUID();
    this.sqlite
      .prepare("INSERT INTO models (id, user_id, connection_id, provider_model_id, label, capabilities_json, manual, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.userId, input.connectionId, input.providerModelId, input.label ?? input.providerModelId, JSON.stringify(capabilities), Number(input.manual), Number(input.enabled ?? true), time, time);
    return this.getModelById(input.userId, id);
  }

  /**
   * Replaces the discovered set without rebuilding it. A model the user added by
   * hand is never touched, and a row that is still discovered keeps its id, so a
   * modelId saved by the client never starts pointing at a different
   * providerModelId. Only a non-manual row that discovery dropped is removed.
   */
  replaceDiscoveredModels(userId: string, connectionId: string, discovered: DiscoveredModel[]): void {
    this.getConnection(userId, connectionId);
    this.assertNoActiveRun(userId, "connection_id", connectionId, "Connection");
    this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT id, provider_model_id, manual FROM models WHERE user_id = ? AND connection_id = ?")
        .all(userId, connectionId) as { id: string; provider_model_id: string; manual: number }[];
      const discoveredIds = new Set(discovered.map((model) => model.providerModelId));
      const manualIds = new Set(existing.filter((row) => row.manual === 1).map((row) => row.provider_model_id));

      for (const row of existing) {
        if (row.manual === 0 && !discoveredIds.has(row.provider_model_id)) {
          this.sqlite.prepare("DELETE FROM models WHERE id = ? AND user_id = ?").run(row.id, userId);
        }
      }
      for (const model of discovered) {
        if (manualIds.has(model.providerModelId)) continue;
        this.upsertModel({ userId, connectionId, providerModelId: model.providerModelId, label: model.label, capabilities: model.capabilities, manual: false });
      }
    })();
  }

  deleteModel(userId: string, connectionId: string, modelId: string): void {
    this.getModelForConnection(userId, connectionId, modelId);
    this.assertNoActiveRun(userId, "model_id", modelId, "Model");
    this.sqlite.prepare("DELETE FROM models WHERE id = ? AND user_id = ?").run(modelId, userId);
  }

  /** Deleting a resource that an in-flight run depends on is refused. */
  private assertNoActiveRun(userId: string, column: "connection_id" | "model_id", value: string, what: string) {
    const row = this.sqlite.prepare(`SELECT id FROM runs WHERE user_id = ? AND ${column} = ? AND status = 'running' LIMIT 1`).get(userId, value);
    if (row) throw new AppError("RESOURCE_IN_USE", `${what} is used by a run that is still in progress`, 409);
  }

  // -- receipts and runs ---------------------------------------------------

  getReceipt(userId: string, submissionId: string): ReceiptRow | undefined {
    const row = this.sqlite.prepare("SELECT * FROM receipts WHERE user_id = ? AND submission_id = ?").get(userId, submissionId) as ReceiptDbRow | undefined;
    return row ? this.receiptRow(row) : undefined;
  }

  claimRun(input: {
    userId: string; id: string; submissionId: string; contentDigest: string; connectionId: string; connectionName: string;
    modelId: string; providerModelId: string; prompt: string; parameters: ParameterValues; referenceCount: number;
  }): { receipt: ReceiptRow; run: RunRow | null; claimed: boolean } {
    const time = now();
    const transaction = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT * FROM receipts WHERE user_id = ? AND submission_id = ?")
        .get(input.userId, input.submissionId) as ReceiptDbRow | undefined;

      if (existing) {
        // Same submission id with different content is an explicit conflict, not a replay.
        if (existing.content_digest !== input.contentDigest) {
          throw new AppError("SUBMISSION_CONFLICT", "This submission id was already used with different content", 409);
        }
        const run = existing.history_deleted
          ? null
          : (this.sqlite.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?").get(existing.run_id, input.userId) as RunDbRow | undefined) ?? null;
        return { receipt: this.receiptRow(existing), run: run ? this.runRow(run) : null, claimed: false };
      }

      this.sqlite
        .prepare("INSERT INTO receipts (user_id, submission_id, content_digest, run_id, status, history_deleted, created_at) VALUES (?,?,?,?,?,0,?)")
        .run(input.userId, input.submissionId, input.contentDigest, input.id, "running", time);
      this.sqlite
        .prepare(`INSERT INTO runs (id, user_id, submission_id, content_digest, connection_id, connection_name, model_id,
          provider_model_id, operation, status, prompt, parameters_json, reference_count, returned_image_count,
          retained_image_count, images_json, error_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'[]',NULL,?,?)`)
        .run(input.id, input.userId, input.submissionId, input.contentDigest, input.connectionId, input.connectionName,
          input.modelId, input.providerModelId, "imageGenerate", "running", input.prompt, JSON.stringify(input.parameters),
          input.referenceCount, time, time);

      const receipt = this.sqlite.prepare("SELECT * FROM receipts WHERE user_id = ? AND submission_id = ?").get(input.userId, input.submissionId) as ReceiptDbRow;
      const run = this.sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(input.id) as RunDbRow;
      return { receipt: this.receiptRow(receipt), run: this.runRow(run), claimed: true };
    });
    return transaction();
  }

  getRun(userId: string, runId: string): RunRow {
    const row = this.sqlite.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?").get(runId, userId) as RunDbRow | undefined;
    if (!row) throw notFound("Run");
    return this.runRow(row);
  }

  /**
   * Keyset pagination on (created_at, id) descending. A bare offset would shift
   * under concurrent inserts; a tie-break on id keeps rows from being skipped
   * when two runs share a millisecond.
   */
  listRuns(userId: string, page: { limit: number; cursor?: string }): { items: RunRow[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(page.limit, 1), 100);
    let rows: RunDbRow[];
    if (page.cursor) {
      const decoded = Buffer.from(page.cursor, "base64url").toString("utf8");
      const separator = decoded.lastIndexOf("\u0000");
      if (separator < 0) throw new AppError("VALIDATION", "Invalid cursor", 400);
      const createdAt = decoded.slice(0, separator);
      const id = decoded.slice(separator + 1);
      rows = this.sqlite
        .prepare("SELECT * FROM runs WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(userId, createdAt, createdAt, id, limit + 1) as RunDbRow[];
    } else {
      rows = this.sqlite
        .prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(userId, limit + 1) as RunDbRow[];
    }
    const page_ = rows.slice(0, limit).map((row) => this.runRow(row));
    const hasMore = rows.length > limit;
    const last = page_[page_.length - 1];
    return { items: page_, nextCursor: hasMore && last ? Buffer.from(`${last.createdAt}\u0000${last.id}`, "utf8").toString("base64url") : null };
  }

  finishRun(userId: string, runId: string, input: {
    status: Extract<RunStatus, "success" | "error" | "uncertain">;
    images: RunImageRefDto[];
    returnedImageCount: number | null;
    retainedImageCount: number | null;
    error?: { code: string; message: string };
  }): RunRow {
    const time = now();
    const transaction = this.sqlite.transaction(() => {
      // Conditional on `running`: a terminal row is returned unchanged and is
      // never overwritten (CONTRACTS §5).
      const updated = this.sqlite
        .prepare(`UPDATE runs SET status = ?, images_json = ?, returned_image_count = ?, retained_image_count = ?,
          error_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`)
        .run(input.status, JSON.stringify(input.images), input.returnedImageCount, input.retainedImageCount,
          input.error ? JSON.stringify(input.error) : null, time, runId, userId);
      const row = this.sqlite.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?").get(runId, userId) as RunDbRow | undefined;
      if (!row) throw notFound("Run");
      if (updated.changes > 0) {
        this.sqlite.prepare("UPDATE receipts SET status = ? WHERE user_id = ? AND submission_id = ?").run(input.status, userId, row.submission_id);
      }
      return this.runRow(row);
    });
    return transaction();
  }

  deleteRun(userId: string, runId: string): { submissionId: string } {
    const run = this.getRun(userId, runId);
    if (run.status === "running") throw new AppError("RUN_ACTIVE", "An in-progress run cannot be deleted", 409);
    this.sqlite.transaction(() => {
      // History goes; the dedup receipt stays so this submission is never
      // delivered upstream twice.
      this.sqlite.prepare("DELETE FROM runs WHERE id = ? AND user_id = ?").run(runId, userId);
      this.sqlite.prepare("UPDATE receipts SET history_deleted = 1 WHERE user_id = ? AND submission_id = ?").run(userId, run.submissionId);
    })();
    return { submissionId: run.submissionId };
  }

  /**
   * Terminal convergence for one row that was left `running`. Both statements
   * are conditional: a run that ended on its own is returned untouched, and the
   * receipt is addressed by (user, submission) because a submission id is only
   * unique within one user's scope — filtering on the submission id alone would
   * rewrite a different user's receipt.
   */
  private markUncertain(row: { id: string; user_id: string; submission_id: string }, time: string) {
    const updated = this.sqlite
      .prepare("UPDATE runs SET status = 'uncertain', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'running'")
      .run(time, row.id, row.user_id);
    if (updated.changes > 0) {
      this.sqlite.prepare("UPDATE receipts SET status = 'uncertain' WHERE user_id = ? AND submission_id = ?").run(row.user_id, row.submission_id);
    }
  }

  /**
   * Startup sweep. A single process owns the data directory, so no `running`
   * row can still be in flight when this runs. Rows become `uncertain`, which
   * is terminal and is never resubmitted. No upstream call is made here or in
   * `reapStaleRuns`: convergence is pure local state.
   */
  recoverAbandonedRuns(): string[] {
    const rows = this.sqlite.prepare("SELECT id, user_id, submission_id FROM runs WHERE status = 'running'").all() as {
      id: string; user_id: string; submission_id: string;
    }[];
    if (rows.length === 0) return [];
    const time = now();
    this.sqlite.transaction(() => {
      for (const row of rows) this.markUncertain(row, time);
    })();
    return rows.map((row) => row.id);
  }

  /** Periodic sweep. `excludeRunIds` protects calls that are still in flight. */
  reapStaleRuns(input: { before: string; excludeRunIds: string[] }): string[] {
    const rows = this.sqlite
      .prepare("SELECT id, user_id, submission_id FROM runs WHERE status = 'running' AND updated_at < ?")
      .all(input.before) as { id: string; user_id: string; submission_id: string }[];
    const excluded = new Set(input.excludeRunIds);
    const stale = rows.filter((row) => !excluded.has(row.id));
    if (stale.length === 0) return [];
    const time = now();
    this.sqlite.transaction(() => {
      for (const row of stale) this.markUncertain(row, time);
    })();
    return stale.map((row) => row.id);
  }
}
