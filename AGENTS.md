# AGENTS.md — Solaris

Solaris is a **desktop Client + self-hostable Server**. The Client is a Tauri v2 app (macOS first)
holding the React UI, local database and image files. The Server authenticates users, resolves
per-user model credentials, and forwards single image generations to a model service. **The Server
never persists images.**

Read `.docs/CONTRACTS.md` (the frozen interface) and `.docs/DECISIONS.md` (confirmed decisions)
before architectural work. `.docs/` is gitignored but authoritative — see "Where the design lives".

## Scope

One operation: **synchronous single image generation**, with optional reference images (edit).
There is no asynchronous work anywhere — no video, no Batch, no upstream job polling, no
cancellation, no JSONL transfer, and no Server-side asset library. These were removed by decisions
D5 and D15; there are no placeholders for them and reopened work must not reintroduce a dual path.

## Commands

- `npm run dev`: build the client, then start the server (`NODE_ENV=production`).
- `npm run build`: build the Vite client into `dist/client`.
- `npm start`: start the server; requires an existing client build.
- `npm test`: run Vitest unit tests; `e2e/**` is excluded.
- `npm run test:e2e`: run Playwright tests.
- `npm run lint`: run ESLint.
- `npm run typecheck`: run TypeScript without emitting.
- `npm run smoke`: check the running server's health endpoint.

Use Node.js 20.19 or newer. Before finishing code changes, run the narrowest relevant tests, then
`npm run typecheck` and `npm run lint`. Native desktop work additionally needs `cargo check` in
`src-tauri/`.

> The Rust `keyring` crate must be declared with a native-store feature per platform
> (`apple-native` / `windows-native`). Without it, version 3 silently falls back to an in-memory
> **mock** store: every token is discarded and tests still pass. There is deliberately no
> un-featured entry, so a platform with no native store fails to compile instead.

## Architecture

- `src/shared/contracts.ts`: client/server DTOs and the closed `AdapterId`, `AuthAdapterId`,
  `CredentialSourceId`, `Operation`, `RunStatus` and error-code unions.
- `src/shared/digest.ts`: canonical JSON + `contentDigest`. Shared by Client and Server, so it must
  stay environment-agnostic — it uses Web Crypto, never `node:crypto`.
- `src/shared/local.ts`: the Client-local `LocalStore` / `DesktopLogin` interfaces. Owned by the
  contract, implemented by the desktop layer, consumed by the React client.
- `src/server/interfaces.ts`: server-only interfaces — private Row types, `AuthAdapter`,
  `AuthTransactionStore`, `SessionService`, `CredentialSource`, `CredentialVault`, `Repository`.
  Nothing here may be imported by the Client.
- `src/server/db/index.ts`: the raw DDL, and the **single executable source of truth** for the
  schema. It refuses to open a data directory holding the pre-refactor schema and modifies nothing.
- `src/server/repository.ts`: raw SQLite persistence and explicit Row→DTO mapping.
- `src/server/services.ts`: validation, digest recomputation, idempotent claim, replay, delivery.
- `src/server/resultCache.ts`: the bounded in-process delivery cache that makes replay work.
- `src/server/auth/`, `credentials/`: OIDC adapter, login transactions, sessions, the `user-key`
  credential source, and the credential vault.
- `src/server/providers/`: the `ProviderPlugin` boundary and the Gemini adapter. Registered in
  `providers/index.ts`; a new protocol needs an adapter plus synchronized updates to the closed
  unions, validation and tests.
- `src/client/`: the React UI; `api.ts` owns typed HTTP calls; `client/local/` is the desktop layer.
- `src-tauri/`: the Rust shell — loopback login listener, OS secure storage, native dialogs, atomic
  file writes. Business logic stays in TypeScript.

## TypeScript and API Conventions

- Strict ESM. Use `.js` extensions in relative imports and `import type` for type-only imports.
- Respect `strict`, `noUncheckedIndexedAccess` and `isolatedModules`; do not introduce `any`.
- Validate route input with strict Zod schemas and preserve the canonical response envelope
  `{ error: { code, message, details? } }` through `AppError`.
- Treat error-code strings and DTO union values as API contracts. Only the codes frozen in
  `CONTRACTS.md` §9 may reach a client; anything else must surface as `INTERNAL` with a generic
  message and **must not echo the original message or stack**.
- Resource methods take a `userId`. Ownership failures and missing resources are both `NOT_FOUND`,
  so a client cannot enumerate another user's ids.

## Security Invariants

Do not weaken these controls:

- Only the frozen error codes reach a client; unmapped failures become a generic `INTERNAL`.
- **Credentials are write-only.** No DTO exposes a key; `hasKey` is the only surface. Never log,
  return, or persist a key in plaintext.
- Encrypt credentials with the existing AES-256-GCM vault format with the AAD binding a ciphertext
  to **`${userId}:${connectionId}`**. There is no dual-read path and no AAD fallback: a ciphertext
  copied to another user or connection must fail to decrypt.
- Redaction must be **content-based, not key-name-based**. The previous key-name-only `redact()`
  demonstrably left reference-image base64 intact under keys like `inlineData.data`, and it reached
  the database. Never place image bytes, tokens, codes or verifiers in logs, errors or persisted
  inspector fields.
- The Server stores no image bytes: not in SQLite, not on disk. The delivery cache is in-process,
  bounded, TTL'd and lost on restart.
- Provider URLs must be HTTPS with no credentials, query or fragment. Never fetch an
  upstream-supplied URL as a server-side request target, and do not implicitly follow redirects on
  a generation call.
- Preserve the multipart file/field/parts/total bounds and the MIME allowlist, and map transport
  limit failures to the frozen reference codes rather than `INTERNAL`.

Add or update focused tests when changing a security boundary.

## Run and Provider Semantics

- Generation is synchronous. A run is `running` → `success` | `error` | `uncertain`.
- `uncertain` means the request may have been accepted and no determinate result was obtained. It is
  **terminal and is never resubmitted automatically**. Re-running is a deliberate user action with a
  **new** `submissionId`, and it may be billed twice.
- A `200` with no usable image is a determinate `error`, not `uncertain`.
- Submission is idempotent on `(userId, submissionId)`. The Server **recomputes** `contentDigest`
  from the bytes it received; it never trusts the client's declared digest for the conflict check.
  Same id + same content replays; same id + different content is `SUBMISSION_CONFLICT`.
- Deleting run history removes the prompt, parameters and image metadata but **keeps the dedup
  receipt**, so the same submission still never reaches upstream twice.
- Generation success, delivery to this client, and saving on this device are three separate things.
  A successful history entry is not downloadable — the Server keeps no bytes and there is no
  upstream task to re-query.
- Capabilities come from the adapter's curated allowlist, derived at read time and never persisted.
  Do not infer support from a model name, a stored `operation` value, or upstream metadata: a
  gateway returns no capability metadata at all, so a name match only narrows candidates.
- Keep provider parameter Zod schemas strict so unsupported keys fail before a provider call.

## Environment and Testing

- `CREDENTIALS_MASTER_KEY` must be a base64-encoded 32-byte key. Other configuration is documented
  in `.env.example`; a deployment missing required values must **refuse to start** rather than fall
  back to a weaker mode.
- Tests that set environment variables before importing server modules must use dynamic imports;
  environment configuration is module-scoped.
- Database tests use isolated temporary directories, must close SQLite, and must clean up.
- Stub provider and IdP calls with Vitest globals and restore them in cleanup. A fixture proves
  Solaris-side behaviour only — it is never evidence of real IdP, model-service, billing or
  cross-platform behaviour. Say which environments were not exercised.
- There is no jsdom or testing-library here: browser and desktop integration is **unverified** by
  unit tests. `vite build` proves the bundle compiles, nothing more.
- `npm start` requires `dist/client/index.html`; run `npm run build` first.

## Where the design lives

`.docs/` is gitignored and therefore absent from a fresh checkout, but it is the authoritative
record: `CONTRACTS.md` (frozen interface), `DECISIONS.md` (confirmed decisions, including the
removal of video and Batch), `PROTOCOL_MATRIX.md` (upstream facts, with evidence levels),
`BACKLOG_*.md` (the task plan, dependency gates and each task's verification record), and
`INTEGRATION_MANIFEST.md` (ownership and baseline conditions). Pass the directory along explicitly
when moving work to another machine or worktree.
