import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SqliteDatabase = Database.Database;
export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, "solaris.sqlite"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, plugin_id TEXT NOT NULL, base_url TEXT NOT NULL, config_json TEXT NOT NULL, key_encrypted TEXT NOT NULL, enabled INTEGER NOT NULL, last_test_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, label TEXT NOT NULL, capabilities_json TEXT NOT NULL, manual INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id, provider_model_id));
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, model_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, asset_ids_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, model_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, inspector_json TEXT, error_json TEXT, conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, remote_id TEXT, attempts INTEGER NOT NULL, next_poll_at TEXT, lease_token TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_assets (run_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(run_id, asset_id, kind));
  `);
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}
