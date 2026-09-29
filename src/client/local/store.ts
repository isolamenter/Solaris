/**
 * `LocalStore` over the device boundary — CONTRACTS §10.
 *
 * The rules that matter live here, above the native layer:
 *
 * - every record is addressed by the scope key, so two accounts or two Servers
 *   never share a draft, a run or a session;
 * - `saveImage` writes the file first and returns only once it is on disk. It
 *   records nothing, so a full disk, a permission failure or a crash cannot leave
 *   a `saved` record behind: the caller records `saved` after this resolves, and
 *   only after;
 * - a saved file that later disappears is reported `missing` for this device
 *   only, without rewriting the stored record and without touching the remote
 *   run status.
 */

import type { SessionDto } from "../../shared/contracts.js";
import type { DraftRecord, LocalImageRecord, LocalRunRecord, LocalScope, LocalStore } from "../../shared/local.js";
import { decodeBase64 } from "./base64.js";
import type { LocalBackend } from "./backend.js";
import { createImageFileName } from "./naming.js";
import { mimeForImageFile } from "./mime.js";
import { parseDraft, parseLocalRun, parseSession, serializeDraft, serializeLocalRun, serializeSession } from "./records.js";
import { assertRecordId, localScopeKey, normalizeServerOrigin } from "./scope.js";

function newestFirst<T extends { updatedAt: string }>(records: T[]): T[] {
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function reconcileMissingImages(
  backend: LocalBackend,
  scopeKey: string,
  record: LocalRunRecord,
): Promise<LocalRunRecord> {
  const images: LocalImageRecord[] = [];
  for (const image of record.images) {
    if (image.state !== "saved" || image.filePath === null) {
      images.push(image);
      continue;
    }
    const present = await backend.imageExists(scopeKey, image.filePath);
    images.push(present ? image : { ...image, state: "missing" });
  }
  return { ...record, images };
}

export function createLocalStore(backend: LocalBackend): LocalStore {
  return {
    async readSession(serverOrigin: string): Promise<SessionDto | null> {
      const origin = normalizeServerOrigin(serverOrigin);
      const document = await backend.readSession(origin);
      return document === null ? null : parseSession(document);
    },

    async writeSession(serverOrigin: string, session: SessionDto): Promise<void> {
      await backend.writeSession(normalizeServerOrigin(serverOrigin), serializeSession(session));
    },

    async clearSession(serverOrigin: string): Promise<void> {
      await backend.clearSession(normalizeServerOrigin(serverOrigin));
    },

    async listDrafts(scope: LocalScope): Promise<DraftRecord[]> {
      const key = await localScopeKey(scope);
      const documents = await backend.listRecords("drafts", key);
      return newestFirst(documents.map(parseDraft));
    },

    async saveDraft(scope: LocalScope, draft: DraftRecord): Promise<void> {
      const key = await localScopeKey(scope);
      assertRecordId(draft.id, "draft id");
      await backend.writeRecord("drafts", key, draft.id, serializeDraft(draft));
    },

    async deleteDraft(scope: LocalScope, draftId: string): Promise<void> {
      const key = await localScopeKey(scope);
      assertRecordId(draftId, "draft id");
      await backend.deleteRecord("drafts", key, draftId);
    },

    async listLocalRuns(scope: LocalScope): Promise<LocalRunRecord[]> {
      const key = await localScopeKey(scope);
      const documents = await backend.listRecords("runs", key);
      const records = documents.map(parseLocalRun);
      const reconciled: LocalRunRecord[] = [];
      for (const record of records) reconciled.push(await reconcileMissingImages(backend, key, record));
      return newestFirst(reconciled);
    },

    async upsertLocalRun(scope: LocalScope, record: LocalRunRecord): Promise<void> {
      const key = await localScopeKey(scope);
      assertRecordId(record.runId, "run id");
      await backend.writeRecord("runs", key, record.runId, serializeLocalRun(record));
    },

    async saveImage(
      scope: LocalScope,
      input: { runId: string; index: number; mimeType: string; dataBase64: string },
    ): Promise<{ filePath: string; byteSize: number }> {
      const key = await localScopeKey(scope);
      const fileName = createImageFileName({ mimeType: input.mimeType });
      const saved = await backend.saveImage({ scopeKey: key, fileName, dataBase64: input.dataBase64 });
      return { filePath: saved.filePath, byteSize: saved.byteSize };
    },

    async imageExists(scope: LocalScope, filePath: string): Promise<boolean> {
      return backend.imageExists(await localScopeKey(scope), filePath);
    },

    async readSavedImage(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }> {
      const key = await localScopeKey(scope);
      const contents = await backend.readSavedImage(key, filePath);
      return { mimeType: mimeForImageFile(filePath), bytes: decodeBase64(contents.dataBase64) };
    },

    async revealInFileManager(scope: LocalScope, filePath: string): Promise<void> {
      await backend.revealInFileManager(await localScopeKey(scope), filePath);
    },

    async chooseSaveDirectory(scope: LocalScope): Promise<string | null> {
      return backend.chooseSaveDirectory(await localScopeKey(scope));
    },

    async chooseReferenceFiles(scope: LocalScope): Promise<string[]> {
      return backend.chooseReferenceFiles(await localScopeKey(scope));
    },

    async readReferenceFile(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }> {
      const key = await localScopeKey(scope);
      const contents = await backend.readReferenceFile(key, filePath);
      return { mimeType: mimeForImageFile(filePath), bytes: decodeBase64(contents.dataBase64) };
    },
  };
}
