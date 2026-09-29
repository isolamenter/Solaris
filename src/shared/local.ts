/**
 * Client-local interface — CONTRACTS §10.
 *
 * Owned by B01 (types), implemented by B06, consumed by B07. Every local record
 * is keyed by a LocalScope so two accounts or two Servers never mix drafts,
 * file links or sessions. No server secret or Buffer type may appear here.
 */

import type { ParameterValues, SessionDto } from "./contracts.js";

/** Normalized Server origin plus Solaris user id. */
export type LocalScope = { serverOrigin: string; userId: string };

export type ReferenceRecord = {
  id: string;
  filePath: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
};

export type DraftRecord = {
  id: string;
  connectionId: string | null;
  modelId: string | null;
  prompt: string;
  parameters: ParameterValues;
  references: ReferenceRecord[];
  updatedAt: string;
};

/**
 * `missing` is device-local: the file this device recorded is gone. It never
 * changes the remote run status.
 */
export type LocalImageRecord = {
  index: number;
  filePath: string | null;
  state: "unsaved" | "saved" | "missing";
  byteSize: number;
  mimeType: string;
};

export type LocalRunRecord = {
  runId: string;
  submissionId: string;
  images: LocalImageRecord[];
  updatedAt: string;
};

export interface LocalStore {
  readSession(serverOrigin: string): Promise<SessionDto | null>;
  writeSession(serverOrigin: string, session: SessionDto): Promise<void>;
  clearSession(serverOrigin: string): Promise<void>;

  listDrafts(scope: LocalScope): Promise<DraftRecord[]>;
  saveDraft(scope: LocalScope, draft: DraftRecord): Promise<void>;
  deleteDraft(scope: LocalScope, draftId: string): Promise<void>;

  listLocalRuns(scope: LocalScope): Promise<LocalRunRecord[]>;
  upsertLocalRun(scope: LocalScope, record: LocalRunRecord): Promise<void>;

  /**
   * Temp file then atomic rename. Only after this resolves may the caller record
   * `saved`. The path and name are device-chosen; never derived from a remote
   * response.
   */
  saveImage(scope: LocalScope, input: { runId: string; index: number; mimeType: string; dataBase64: string }): Promise<{ filePath: string; byteSize: number }>;
  imageExists(scope: LocalScope, filePath: string): Promise<boolean>;
  readSavedImage(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
  revealInFileManager(scope: LocalScope, filePath: string): Promise<void>;

  chooseSaveDirectory(scope: LocalScope): Promise<string | null>;
  chooseReferenceFiles(scope: LocalScope): Promise<string[]>;
  readReferenceFile(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
}

/**
 * Native loopback-listener login. The verifier is returned to the caller, sent
 * only to the Server token endpoint, and never written to SQLite or logs.
 */
export interface DesktopLogin {
  authorize(input: { authorizationEndpoint: string; signal?: AbortSignal }): Promise<{ code: string; codeVerifier: string }>;
}
