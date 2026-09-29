/**
 * The device boundary.
 *
 * Everything above this line is ordinary TypeScript that runs (and is tested) in
 * Node. Everything below it needs a real machine: a TCP listener, the OS secure
 * store, file dialogs, the filesystem. `LocalStore` and `DesktopLogin` are
 * written against this interface so their rules can be exercised without a
 * device; `tauriBackend.ts` is the only implementation that talks to the shell.
 *
 * The backend never receives a code verifier, a Server authorization code, or a
 * destination path of its own choosing.
 */

/** Record kinds the native store exposes. A closed set, never a path. */
export type RecordKind = "drafts" | "runs";

export type SavedImageResult = { filePath: string; byteSize: number };
export type FileContents = { dataBase64: string };

export interface LocalBackend {
  /**
   * Bind a loopback listener on a random free port and report its redirect URI.
   * The deadline is enforced by the native side, so an abandoned attempt closes
   * its port by itself.
   */
  beginLogin(input: { timeoutMs: number }): Promise<{ redirectUri: string }>;
  /** Resolve with the raw request target of the single callback request. */
  awaitLoginCallback(): Promise<{ requestTarget: string }>;
  /** Close the listener of the attempt in progress. Safe to call twice. */
  cancelLogin(): Promise<void>;
  /** Hand a validated http(s) URL to the system browser. */
  openExternalUrl(url: string): Promise<void>;

  /** Session document for a normalized Server origin, or null. */
  readSession(serverOrigin: string): Promise<string | null>;
  /** Replace the session of that Server. Exactly one session per Server. */
  writeSession(serverOrigin: string, document: string): Promise<void>;
  /** Remove the session of that Server. */
  clearSession(serverOrigin: string): Promise<void>;

  listRecords(kind: RecordKind, scopeKey: string): Promise<string[]>;
  readRecord(kind: RecordKind, scopeKey: string, recordId: string): Promise<string | null>;
  writeRecord(kind: RecordKind, scopeKey: string, recordId: string, document: string): Promise<void>;
  deleteRecord(kind: RecordKind, scopeKey: string, recordId: string): Promise<void>;

  /** Ask the user for reference images; returns the paths, which become readable. */
  chooseReferenceFiles(scopeKey: string): Promise<string[]>;
  /** Bytes of a reference file the user chose for this scope. */
  readReferenceFile(scopeKey: string, filePath: string): Promise<FileContents>;
  /** Ask the user where this scope's images should be written. */
  chooseSaveDirectory(scopeKey: string): Promise<string | null>;
  /** Write one image atomically; resolves only once it is on disk. */
  saveImage(input: { scopeKey: string; fileName: string; dataBase64: string }): Promise<SavedImageResult>;
  /** Whether a saved image of this scope is still on disk. */
  imageExists(scopeKey: string, filePath: string): Promise<boolean>;
  /** Bytes of a saved image of this scope. */
  readSavedImage(scopeKey: string, filePath: string): Promise<FileContents>;
  /** Show a saved image of this scope in the file manager. */
  revealInFileManager(scopeKey: string, filePath: string): Promise<void>;
}
