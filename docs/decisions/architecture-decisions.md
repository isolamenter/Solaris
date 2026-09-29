# Architecture decisions

This is a compact record of durable choices confirmed by current source or historical maintainer decisions. It is not a completed-work plan. Historical `.docs/DECISIONS.md` D1–D7 and D15 corroborate the choices below but are not required to use this checkout. Unconfirmed historical recommendations are not promoted to approved decisions.

## 1. Desktop Client and self-hostable Server

**Status:** Accepted; historical D1, D2, D3 and D6, reflected in code.

Use Tauri v2 with React, macOS first. The Server authenticates users and owns account/run metadata and encrypted model credentials. The Client owns local records and image files. OIDC authentication, credential resolution and model protocol adaptation have separate interfaces; the public implementations are `oidc`, `user-key` and `gemini`.

**Consequences:** Full native login and file operations require the shell. Remote history is per user; it does not synchronize image files. Windows runtime acceptance is not established.

**Evidence:** [Tauri configuration](../../src-tauri/tauri.conf.json), [Server interfaces](../../src/server/interfaces.ts), [Client-local interfaces](../../src/shared/local.ts), [Client composition](../../src/client/main.tsx).

**Rationale:** The ownership boundary is explicit in the design record. A detailed comparative reason for choosing Tauri over Electron is **Unknown / Needs confirmation**; the available record confirms the choice, not a full tradeoff analysis.

## 2. Synchronous image generation only

**Status:** Accepted; historical D4, D5 and D15, reflected in the closed operation union.

Keep Gemini `generateContent` for a single synchronous generation request, with optional references. Remove video and Batch; do not keep asynchronous job, polling or cancellation paths.

**Rationale:** Historical decisions explicitly reduce scope. The recorded gateway investigation did not establish a usable Batch chain on the tested instance; this is not a claim about every gateway or Gemini deployment.

**Consequences:** In-flight requests still require deduplication and determinate/uncertain outcomes. A new user run may be billed again; Solaris does not automatically resubmit unknown results.

**Evidence:** [contracts.ts](../../src/shared/contracts.ts), [Gemini provider](../../src/server/providers/gemini.ts), [generation service](../../src/server/services.ts). Historical upstream observations have not been repeated in this documentation task.

## 3. Metadata persistence and temporary image delivery

**Status:** Implemented; confirmed by code and the prior Agent constraints.

Use raw SQLite for Server records and dedup receipts. Keep image delivery in a bounded process-memory cache; never persist image bytes on the Server. Deleting run history retains a receipt. One process owns each data directory.

**Rationale:** Receipts prevent duplicate upstream calls even after deletion; the temporary cache enables best-effort transport replay within the no-image-persistence boundary. Single-process ownership matches the process-local cache and active-run bookkeeping; a separate maintainer approval of historical recommendation D9 is **Unknown / Needs confirmation**.

**Consequences:** Restart/eviction loses delivery bytes. History success is not download availability. Multiple workers sharing a directory are outside the implemented architecture.

**Evidence:** [schema](../../src/server/db/index.ts), [repository](../../src/server/repository.ts), [cache](../../src/server/resultCache.ts), [Server lifecycle](../../src/server/main.ts).

## 4. No legacy data migration or compatibility path

**Status:** Accepted; historical D7, enforced in storage and credential code.

Use a fresh Server data directory. Refuse pre-refactor schema before writing to it; never auto-delete old data or try legacy credential AAD. Keep one executable schema definition rather than an ORM mirror.

**Rationale:** The maintainer explicitly chose not to migrate the former local-only data. Current code binds credentials to both user and connection; changing ownership cannot silently reuse the old binding.

**Consequences:** Operators keep old files separately and configure a new directory. Losing the master key makes saved credentials unreadable.

**Evidence:** [db/index.ts](../../src/server/db/index.ts), [credential vault](../../src/server/credentials/vault.ts), [vault format](../../src/server/vault.ts).

## 5. Explicit adapters and derived capabilities

**Status:** Implemented; confirmed by code and prior Agent constraints.

Keep closed identifiers and static registries for authentication, credentials and providers. Derive usable model capabilities from the curated adapter allowlist; reject unsupported parameters before generation. Do not build a dynamic plugin loader or trust model-name discovery as proof of support.

**Rationale:** Candidate discovery is weaker evidence than an implemented request/response adapter, especially when gateways omit capability metadata. The broader comparative rationale for static rather than dynamic plugins is **Unknown / Needs confirmation**.

**Consequences:** A new protocol requires explicit contracts, validation, registry and test changes. Discovered models may remain unavailable.

**Evidence:** [shared identifiers](../../src/shared/contracts.ts), [provider registry](../../src/server/providers/index.ts), [Gemini adaptation](../../src/server/providers/geminiAdapter.ts), [auth registry](../../src/server/auth/index.ts), [credential registry](../../src/server/credentials/index.ts).
