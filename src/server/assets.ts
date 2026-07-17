import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "./db/index.js";
import { AppError } from "./errors.js";
import type { AssetDto } from "../shared/contracts.js";

type AssetRow = { id: string; mime_type: string; byte_size: number; storage_key: string; created_at: string };
export class AssetStore {
  private readonly root: string;
  constructor(private readonly sqlite: SqliteDatabase, dataDir: string) { this.root = join(dataDir, "assets"); mkdirSync(this.root, { recursive: true }); }
  save(bytes: Buffer, mimeType: string): AssetDto {
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/") && !mimeType.startsWith("audio/") && !mimeType.startsWith("text/")) throw new AppError("ASSET_TYPE", "This file type is not supported", 415);
    if (bytes.byteLength > 30 * 1024 * 1024) throw new AppError("ASSET_SIZE", "Assets must be 30 MB or smaller", 413);
    const hash = createHash("sha256").update(bytes).digest("hex"); const storageKey = `${hash.slice(0, 2)}/${hash}`; const file = join(this.root, storageKey);
    const previous = this.sqlite.prepare("SELECT * FROM assets WHERE sha256 = ?").get(hash) as AssetRow | undefined;
    if (previous) return this.dto(previous);
    mkdirSync(join(this.root, hash.slice(0, 2)), { recursive: true }); writeFileSync(file, bytes, { flag: "wx" });
    const row = { id: randomUUID(), mime_type: mimeType, byte_size: bytes.byteLength, storage_key: storageKey, created_at: new Date().toISOString() };
    this.sqlite.prepare("INSERT INTO assets (id,sha256,storage_key,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?)").run(row.id, hash, row.storage_key, row.mime_type, row.byte_size, row.created_at);
    return this.dto(row);
  }
  read(id: string) { const row = this.find(id); const file = join(this.root, row.storage_key); if (!existsSync(file)) throw new AppError("ASSET_MISSING", "Local asset content is missing", 404); return { row, bytes: readFileSync(file) }; }
  find(id: string) { const row = this.sqlite.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | undefined; if (!row) throw new AppError("ASSET_NOT_FOUND", "Asset not found", 404); return row; }
  dto(row: AssetRow): AssetDto { return { id: row.id, mimeType: row.mime_type, byteSize: row.byte_size, url: `/api/assets/${row.id}`, createdAt: row.created_at }; }
  clear() { this.sqlite.prepare("DELETE FROM assets").run(); rmSync(this.root, { recursive: true, force: true }); mkdirSync(this.root, { recursive: true }); }
}
