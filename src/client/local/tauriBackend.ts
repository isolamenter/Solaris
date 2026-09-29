/**
 * The only implementation of the device boundary: Tauri v2 commands.
 *
 * Each entry is a thin pass-through. No rule is decided here — command
 * arguments are computed by `store.ts` / `login.ts`, and the Rust side validates
 * them again before touching the filesystem or the keychain.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileContents, LocalBackend, RecordKind, SavedImageResult } from "./backend.js";

export function createTauriBackend(): LocalBackend {
  return {
    beginLogin: (input) => invoke<{ redirectUri: string }>("login_begin", { timeoutMs: input.timeoutMs }),
    awaitLoginCallback: () => invoke<{ requestTarget: string }>("login_await"),
    cancelLogin: () => invoke<void>("login_cancel"),
    openExternalUrl: (url) => invoke<void>("open_external_url", { url }),

    readSession: (serverOrigin) => invoke<string | null>("secrets_read", { serverOrigin }),
    writeSession: (serverOrigin, document) => invoke<void>("secrets_write", { serverOrigin, document }),
    clearSession: (serverOrigin) => invoke<void>("secrets_clear", { serverOrigin }),

    listRecords: (kind: RecordKind, scopeKey) => invoke<string[]>("records_list", { kind, scopeKey }),
    readRecord: (kind: RecordKind, scopeKey, recordId) => invoke<string | null>("records_read", { kind, scopeKey, recordId }),
    writeRecord: (kind: RecordKind, scopeKey, recordId, document) =>
      invoke<void>("records_write", { kind, scopeKey, recordId, document }),
    deleteRecord: (kind: RecordKind, scopeKey, recordId) => invoke<void>("records_delete", { kind, scopeKey, recordId }),

    chooseReferenceFiles: (scopeKey) => invoke<string[]>("choose_reference_files", { scopeKey }),
    readReferenceFile: (scopeKey, filePath) => invoke<FileContents>("read_reference_file", { scopeKey, filePath }),
    chooseSaveDirectory: (scopeKey) => invoke<string | null>("choose_save_directory", { scopeKey }),
    saveImage: (input) =>
      invoke<SavedImageResult>("save_image", {
        scopeKey: input.scopeKey,
        fileName: input.fileName,
        dataBase64: input.dataBase64,
      }),
    imageExists: (scopeKey, filePath) => invoke<boolean>("image_exists", { scopeKey, filePath }),
    readSavedImage: (scopeKey, filePath) => invoke<FileContents>("read_saved_image", { scopeKey, filePath }),
    revealInFileManager: (scopeKey, filePath) => invoke<void>("reveal_in_file_manager", { scopeKey, filePath }),
  };
}
