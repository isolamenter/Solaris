/**
 * Server-side interfaces — CONTRACTS §2.2, §3.1, §8.
 *
 * Owned by B01; implemented by B02 (repository), B03 (auth/credentials).
 * Nothing here may be imported by the Client.
 *
 * Note on the documented private Row types: CONTRACTS §8 says DTO mapping must
 * pick fields explicitly and never spread a Row, so `keyEncrypted` and
 * `tokenHash` cannot leak into a DTO by construction.
 */

import type {
  AdapterId,
  AuthAdapterId,
  ConnectionTestDto,
  CredentialSourceId,
  Operation,
  ParameterValues,
  RunImageRefDto,
  RunStatus,
  UserDto,
} from "../shared/contracts.js";
import type { DiscoveredModel } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Rows (private to the Server)
// ---------------------------------------------------------------------------

/** Mirrors UserDto. External identity is stored separately. */
export type UserRow = { id: string; displayName: string | null; createdAt: string };

export type SessionRow = {
  id: string;
  userId: string;
  /** Only the hash is persisted; the bearer token is never stored. */
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
};

/** ConnectionDto metadata plus the owning user and the ciphertext (never plaintext). */
export type ConnectionRow = {
  id: string;
  userId: string;
  name: string;
  adapterId: AdapterId;
  baseUrl: string;
  config: Record<string, unknown>;
  keyEncrypted: string | null;
  enabled: boolean;
  lastTest: ConnectionTestDto | null;
  createdAt: string;
  updatedAt: string;
};

/** Persisted model metadata only; derived configuration is never stored. */
export type ModelRow = {
  id: string;
  userId: string;
  connectionId: string;
  providerModelId: string;
  label: string;
  capabilities: Operation[];
  manual: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** RunDto plus the server-only dedup fields. */
export type RunRow = {
  id: string;
  userId: string;
  submissionId: string;
  contentDigest: string;
  connectionId: string;
  connectionName: string;
  modelId: string;
  providerModelId: string;
  operation: Operation;
  status: RunStatus;
  prompt: string;
  parameters: ParameterValues;
  referenceCount: number;
  returnedImageCount: number | null;
  retainedImageCount: number | null;
  images: RunImageRefDto[];
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Minimal dedup receipt (CONTRACTS §6.3). Survives deletion of the run so the
 * same submission never reaches upstream twice, and so a content change is
 * still detectable. Holds no image and no full input.
 */
export type ReceiptRow = {
  userId: string;
  submissionId: string;
  contentDigest: string;
  runId: string;
  status: RunStatus;
  historyDeleted: boolean;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Authentication (CONTRACTS §2.2)
// ---------------------------------------------------------------------------

/** Stable external identity. Email and display name are never keys. */
export type ExternalIdentity = { issuer: string; subject: string; displayName?: string };

/** Short-lived server-side login transaction. */
export type AuthTransaction = { id: string; state: string; expiresAt: string };

/**
 * One authentication boundary. `complete` must perform the selected protocol's
 * verification (OIDC: issuer, audience, expiry, nonce, signature, code
 * exchange) — parsing the callback is not verification.
 */
export interface AuthAdapter {
  id: AuthAdapterId;
  begin(input: { transaction: AuthTransaction; callbackUrl: string }): Promise<{ authorizationUrl: string }>;
  complete(input: { transaction: AuthTransaction; callbackUrl: string; parameters: Record<string, string> }): Promise<ExternalIdentity>;
  discard(transactionId: string): void;
}

export interface SessionService {
  authenticate(token: string): Promise<{ sessionId: string; user: UserDto }>;
  issue(userId: string): Promise<{ token: string; expiresAt: string; user: UserDto }>;
  revoke(sessionId: string, userId: string): Promise<void>;
}

/**
 * Two-stage desktop login state (CONTRACTS §2.3).
 *
 * A login attempt binds the Client's state, its S256 challenge and the exact
 * loopback redirect URI, alongside a separate upstream state. After the IdP
 * callback the Server issues a one-time Solaris authorization code bound to the
 * same challenge and redirect URI; the Client then exchanges code + verifier.
 *
 * Implemented by B03 as a bounded in-memory store: short TTL, atomic
 * single-use consumption, and nothing that survives a restart (a login in
 * progress is simply lost, which is why no database is involved).
 *
 * The upstream PKCE verifier and nonce are deliberately NOT here — CONTRACTS
 * §2.3 requires the auth adapter to generate its own and never reuse the
 * desktop verifier. The adapter keeps those privately, keyed by
 * `AuthTransaction.id`.
 */
export type LoginTransaction = {
  id: string;
  /** The Client's `state`, echoed back on the loopback redirect. */
  clientState: string;
  /** The Client's S256 challenge; the verifier is only ever seen by the Client. */
  clientChallenge: string;
  /** Fully validated loopback redirect URI, bound for the whole transaction. */
  redirectUri: string;
  /** Server-generated state for the upstream IdP leg; distinct from `clientState`. */
  upstreamState: string;
  expiresAt: string;
};

export type IssuedAuthorizationCode = {
  userId: string;
  clientChallenge: string;
  redirectUri: string;
  expiresAt: string;
};

export interface AuthTransactionStore {
  begin(input: { clientState: string; clientChallenge: string; redirectUri: string }): LoginTransaction;
  /** Atomic single consumption by upstream state; null if unknown, spent or expired. */
  consumeByUpstreamState(upstreamState: string): LoginTransaction | null;
  discard(transactionId: string): void;
  issueCode(input: { userId: string; clientChallenge: string; redirectUri: string }): { code: string; expiresAt: string };
  /** Atomic single consumption; null if unknown, spent or expired. */
  consumeCode(code: string): IssuedAuthorizationCode | null;
}

// ---------------------------------------------------------------------------
// Credential source (CONTRACTS §3.1)
// ---------------------------------------------------------------------------

export type ResolvedCredential = { apiKey: string; expiresAt: string | null };

/**
 * Credential encryption boundary — implemented by B03 on top of the existing
 * AES-256-GCM vault. The AAD binds a ciphertext to one user and one connection
 * (`${userId}:${connectionId}`), so a row copied between users cannot be
 * decrypted and there is no fallback to any other AAD.
 */
export interface CredentialVault {
  encrypt(plainText: string, userId: string, connectionId: string): string;
  decrypt(payload: string, userId: string, connectionId: string): string;
}

/**
 * A boundary separate from both the auth adapter and the model adapter.
 * Resolving a credential for a connection the user does not own must fail; a
 * failure never falls back to another source or another user's key.
 */
export interface CredentialSource {
  id: CredentialSourceId;
  resolve(input: { userId: string; connectionId: string }): Promise<ResolvedCredential>;
  hasCredential(input: { userId: string; connectionId: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Repository (CONTRACTS §8) — implemented by B02
// ---------------------------------------------------------------------------

export interface Repository {
  findUserByExternalIdentity(issuer: string, subject: string): UserRow | undefined;
  createUserWithIdentity(input: { issuer: string; subject: string; displayName?: string }): UserRow;
  getUser(userId: string): UserRow;

  createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): void;
  findSessionByTokenHash(tokenHash: string): SessionRow | undefined;
  revokeSession(sessionId: string, userId: string): void;

  listConnections(userId: string): ConnectionRow[];
  getConnection(userId: string, connectionId: string): ConnectionRow;
  createConnection(input: { userId: string; id: string; name: string; adapterId: AdapterId; baseUrl: string; config: Record<string, unknown>; keyEncrypted: string }): ConnectionRow;
  updateConnection(userId: string, connectionId: string, input: { name: string; baseUrl: string; config: Record<string, unknown>; enabled: boolean; keyEncrypted?: string }): ConnectionRow;
  deleteConnection(userId: string, connectionId: string): void;
  recordConnectionTest(userId: string, connectionId: string, test: ConnectionTestDto): void;

  listModels(userId: string, connectionId: string): ModelRow[];
  getModelForConnection(userId: string, connectionId: string, modelId: string): ModelRow;
  getModelById(userId: string, modelId: string): ModelRow;
  upsertModel(input: { userId: string; connectionId: string; providerModelId: string; label?: string; capabilities: Operation[]; manual: boolean; enabled?: boolean }): ModelRow;
  replaceDiscoveredModels(userId: string, connectionId: string, discovered: DiscoveredModel[]): void;
  deleteModel(userId: string, connectionId: string, modelId: string): void;

  getReceipt(userId: string, submissionId: string): ReceiptRow | undefined;

  /**
   * Atomically claims the receipt and creates the run in one transaction.
   * `claimed: false` means another request owns this submission — the caller
   * must not call upstream.
   */
  claimRun(input: {
    userId: string;
    id: string;
    submissionId: string;
    contentDigest: string;
    connectionId: string;
    connectionName: string;
    modelId: string;
    providerModelId: string;
    prompt: string;
    parameters: ParameterValues;
    referenceCount: number;
  }): { receipt: ReceiptRow; run: RunRow | null; claimed: boolean };

  getRun(userId: string, runId: string): RunRow;
  listRuns(userId: string, page: { limit: number; cursor?: string }): { items: RunRow[]; nextCursor: string | null };

  /** Conditional update from `running`; a terminal row is returned unchanged. */
  finishRun(userId: string, runId: string, input: {
    status: Extract<RunStatus, "success" | "error" | "uncertain">;
    images: RunImageRefDto[];
    returnedImageCount: number | null;
    retainedImageCount: number | null;
    error?: { code: string; message: string };
  }): RunRow;

  /** Removes history but keeps the dedup receipt. Returns the submission id. */
  deleteRun(userId: string, runId: string): { submissionId: string };

  /** Startup sweep: rows left `running` by a previous process become `uncertain`. */
  recoverAbandonedRuns(): string[];
  /** Periodic sweep; must exclude currently active runs. */
  reapStaleRuns(input: { before: string; excludeRunIds: string[] }): string[];
}
