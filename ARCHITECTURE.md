# Architecture

Solaris separates device-owned files from a network-accessible, authenticated generation Server. Its only model operation is synchronous image generation, optionally using reference images.

## Modules and dependency direction

| Module | Responsibility |
| --- | --- |
| `src/client/` | React workspace, connections and history; session orchestration; typed HTTP calls in `api.ts` |
| `src/client/local/` | Account-scoped records, reference reads, image saving and desktop login; `tauriBackend.ts` bridges to Rust |
| `src/shared/` | Public DTOs (`contracts.ts`), device interfaces (`local.ts`) and canonical digest (`digest.ts`) |
| `src/server/http/` | Strict route validation, bounded multipart input, public error normalization and deployment boundaries |
| `src/server/auth/` | OIDC adapter, temporary login transactions and Solaris sessions |
| `src/server/credentials/` | Credential-source registry, user-key resolution and encrypted vault |
| `src/server/services.ts` | Ownership and operation validation, idempotent generation orchestration and terminal outcomes |
| `src/server/providers/` | Registered provider protocol boundary, Gemini adapter, bounded HTTP calls and response decoding |
| `src/server/repository.ts`, `db/index.ts` | Raw SQLite persistence, ownership filtering, row-to-DTO mapping and executable schema |
| `src/server/resultCache.ts` | Bounded, TTL/LRU process-memory image cache for best-effort replay |
| `src-tauri/` | Loopback listener, native secure storage, dialogs, scoped JSON records and atomic image writes |

Client and Server depend on `shared`; shared code never depends on either runtime. Client accesses the Server through HTTP DTOs and the device through `LocalStore`/`DesktopLogin`. React does not implement OS operations. Server routes call services and authentication boundaries; services use repository, credential-source and provider interfaces. Providers receive resolved credentials and have no responsibility for user ownership or database persistence.

`src/server/main.ts` composes the Server and its lifecycle. `src/client/main.tsx` composes the Client with the real Tauri backend. There is no browser storage fallback for native login or files.

## Key data flows

### Sign-in

The Client listens on a random loopback port and opens the Server authorization URL in the system browser with state and S256 PKCE. The Server performs a separate OIDC flow, verifies identity and maps `(issuer, subject)` to a Solaris user. It returns a short-lived, single-use Solaris code to the desktop callback. The Client exchanges that code plus its verifier for a bearer session, which it stores in the OS secure store. The Server stores only the session-token hash. See [identity and connections](docs/specs/identity-and-connections.md).

### Generate and save

The Client reads selected references, hashes the exact bytes and sends a multipart request with a stable submission ID and digest. The Server authenticates the user, recomputes the digest, checks the dedup receipt, validates new submissions and atomically claims a run. It resolves the connection credential and makes one synchronous provider call. Image bytes remain in memory; SQLite receives run metadata and a dedup receipt. The response distinguishes run outcome from delivery availability. The Client saves delivered bytes atomically and records device-local file status. See [generation](docs/specs/generation.md) and [local data](docs/specs/local-data.md).

### Replay and recovery

A repeated `(userId, submissionId)` checks the recomputed digest and reuses the receipt. A successful receipt can deliver cached bytes; a cache miss does not cause another provider call. Deleting history clears the run and cached bytes but retains its receipt. Startup marks abandoned `running` records `uncertain`; periodic cleanup excludes active calls. This cleanup is state convergence, not upstream job polling.

## Storage and deployment boundaries

- **Server SQLite:** identities, hashed sessions, per-user connections, encrypted keys, model records, run metadata and receipts. `db/index.ts` is the executable schema; no ORM mirror or legacy migration exists.
- **Server memory:** authentication transactions, active calls and bounded delivery cache. Restart loses temporary codes and images.
- **Client device:** normalized Server setting, native secure session storage, JSON draft/run records scoped by Server origin and user, and user-selected image files. There is no Client SQLite implementation.
- **Network:** configurable public origin with Host/Origin enforcement and explicit trusted proxy hops; authenticated account APIs. Provider targets must be HTTPS without URL credentials/query/fragment; generation calls refuse redirects and do not fetch upstream-supplied asset URLs.

The Server defaults to a loopback bind behind a proxy or tunnel, but is self-hostable remotely. One process owns a data directory; the cache and active-run set are process-local. Multi-worker sharing is outside the implemented architecture. Full device behavior requires Tauri; a served browser bundle is only a development surface.

For durable constraints see [feature specifications](docs/specs/) and [architecture decisions](docs/decisions/architecture-decisions.md). Exact DTO fields, schema columns, model lists and budget defaults remain in their source files and [.env.example](.env.example).
