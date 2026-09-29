import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

const DB_FILE = "solaris.sqlite";

/**
 * Tables that only exist in the pre-refactor schema. Their presence means this
 * data directory belongs to the old single-user BFF.
 */
const LEGACY_TABLES = ["profiles", "conversations", "messages", "jobs", "assets", "run_assets", "batch_jobs", "batch_entries"];

/** SQLite GLOB has no `{n}` quantifier, so the UUID pattern is built in JS. */
const HEX = "[0-9a-fA-F]";
const UUID_GLOB = [HEX.repeat(8), HEX.repeat(4), HEX.repeat(4), HEX.repeat(4), HEX.repeat(12)].join("-");
const UUID_CHECK = (column: string) => `CHECK (${column} GLOB '${UUID_GLOB}')`;

/**
 * The executable schema. Every query in `repository.ts` is raw SQL, so this is
 * the single source of truth for the new schema — there is no ORM mirror to
 * keep in sync and no migration tooling in the project (D7: no migration).
 * Every row id and ownership column is constrained to a UUID; `provider_model_id`
 * is deliberately unchecked because it is an upstream identifier, not a Solaris one.
 */
const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS external_identities (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (issuer, subject)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (token_hash)
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    name TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    base_url TEXT NOT NULL,
    config_json TEXT NOT NULL,
    key_encrypted TEXT,
    enabled INTEGER NOT NULL,
    last_test_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connections_user ON connections (user_id);
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    connection_id TEXT NOT NULL ${UUID_CHECK("connection_id")},
    provider_model_id TEXT NOT NULL,
    label TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    manual INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (connection_id, provider_model_id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    submission_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    history_deleted INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, submission_id)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY ${UUID_CHECK("id")},
    user_id TEXT NOT NULL ${UUID_CHECK("user_id")},
    submission_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    connection_id TEXT NOT NULL ${UUID_CHECK("connection_id")},
    connection_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    provider_model_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    reference_count INTEGER NOT NULL,
    returned_image_count INTEGER,
    retained_image_count INTEGER,
    images_json TEXT NOT NULL,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_user_created ON runs (user_id, created_at, id);
`;

/**
 * Refuses to open a data directory that still holds the legacy schema.
 *
 * D7 (no migration) does not authorize deleting anything: this never modifies,
 * truncates or removes the old database, its WAL, or its image directory. It
 * fails with an actionable message so the operator points Solaris at a fresh
 * directory. There is no dual-read path and no AAD fallback.
 */
function assertNotLegacy(sqlite: SqliteDatabase, file: string) {
  const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const present = rows.map((row) => row.name).filter((name) => LEGACY_TABLES.includes(name));
  if (present.length === 0) return;
  sqlite.close();
  throw new Error(
    `Refusing to open ${file}: it holds the pre-refactor schema (found: ${present.join(", ")}). ` +
      "Solaris does not migrate or modify the old database. Point SOLARIS_DATA_DIR at a new, empty directory; " +
      "the existing files are left untouched.",
  );
}

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, DB_FILE);
  const existed = existsSync(file);
  const sqlite = new Database(file);
  try {
    // The legacy probe runs before any pragma that writes. Switching a
    // database into WAL mode rewrites its header, so checking afterwards would
    // mutate the very file the refusal promises to leave alone.
    if (existed) assertNotLegacy(sqlite, file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(SCHEMA_DDL);
  } catch (error) {
    if (sqlite.open) sqlite.close();
    throw error;
  }
  return { sqlite };
}
