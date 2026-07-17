# AGENTS.md — Solaris

Solaris is a local-first React UI backed by a Fastify BFF. The server binds to `127.0.0.1`; Vite builds the client into `dist/client`, which Fastify serves.

## Commands

- `npm run dev`: build the client, then start the production-mode server.
- `npm run build`: build the Vite client into `dist/client`.
- `npm start`: start the server; requires an existing client build.
- `npm test`: run Vitest unit tests; `e2e/**` is excluded.
- `npm run test:e2e`: run Playwright tests.
- `npm run lint`: run ESLint.
- `npm run typecheck`: run TypeScript without emitting.
- `npm run smoke`: check the running server's health endpoint.

Use Node.js 20.19 or newer. Before finishing code changes, run the narrowest relevant tests, then `npm run typecheck` and `npm run lint`.

## Architecture

- `src/shared/contracts.ts`: client/server DTOs and closed provider, operation, capability, and status unions.
- `src/client/`: React UI; `api.ts` owns typed HTTP calls.
- `src/server/http/app.ts`: Fastify composition, route schemas, error envelope, and static client serving.
- `src/server/repository.ts`: raw SQLite persistence and DTO mapping.
- `src/server/services.ts`: domain validation and provider orchestration.
- `src/server/runner.ts`: asynchronous video submission and polling.
- `src/server/providers/`: provider plugin contracts, adapters, and registry; Gemini is currently the only registered provider.
- `src/server/vault.ts`: credential encryption and inspector redaction.
- `e2e/`: Playwright behavior and local-boundary specifications.

Keep client/server contracts in `src/shared/contracts.ts`. Keep provider-specific behavior behind `ProviderPlugin`; register new providers in `src/server/providers/index.ts` and update the closed provider IDs and route validation.

## TypeScript and API Conventions

- This is strict ESM. Use `.js` extensions in relative imports and `import type` for type-only imports.
- Respect `strict`, `noUncheckedIndexedAccess`, and `isolatedModules`; do not introduce `any`.
- Validate route input with Zod and preserve the canonical response envelope `{ error: { code, message, details? } }` through `AppError`.
- Treat error-code strings and DTO union values as API contracts; update client and tests with intentional changes.
- `ModelDto.operationConfigs`, availability, and adaptation are derived by provider adapters at read time; do not persist them. An operation is runnable only when the model is adapted and exposes its operation configuration.
- API keys are write-only. DTOs expose only `hasKey`.

## Security Invariants

Do not weaken these controls:

- Bind to loopback and retain `assertLoopbackHost` on every request.
- Retain exact same-origin checks for mutating requests.
- Require HTTPS provider URLs without credentials, query strings, or fragments.
- Encrypt credentials with the existing AES-256-GCM vault format and profile ID as AAD.
- Pass provider request/response inspectors through `redact()` before persistence.
- Preserve multipart and per-asset limits and the asset MIME allowlist.

Add or update focused tests when changing security boundaries.

## Run and Provider Semantics

- Image generation is synchronous; video generation uses queued jobs and polling.
- Preserve `uncertain` as distinct from `error`: an unknown video-submission outcome must not be automatically resubmitted.
- Runtime capabilities and operation configurations come from provider adapters. Do not infer support solely from a stored operation or model name.
- Manual models survive discovery refreshes; discovery replaces only non-manual model rows.
- Keep provider parameter Zod schemas strict so unsupported keys fail before a provider call.

## Environment and Testing

- `CREDENTIALS_MASTER_KEY` must be a base64-encoded 32-byte key. Optional values include `SOLARIS_DATA_DIR` (default `.solaris-data`) and `PORT` (default `3210`). `.env.local` is loaded once during module initialization.
- Tests that set environment variables before importing server modules should use dynamic imports; environment configuration is module-scoped.
- Database tests use isolated temporary directories and must close SQLite and remove temporary data.
- Stub provider calls with Vitest globals and restore them in cleanup.
- `npm start` requires `dist/client/index.html`; run `npm run build` first. `npm run dev` already builds, but it runs with `NODE_ENV=production`.
