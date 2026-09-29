# AGENTS.md — Solaris

Canonical instructions for all AI agents. Harness-specific instruction files, if added, should only refer here.

## Entry and documentation routes

Solaris is a Tauri desktop Client plus a self-hostable Fastify Server for synchronous image generation. The Client owns image files; the Server stores metadata and encrypted credentials only.

- [README.md](README.md): setup, environment and developer commands.
- [DESIGN.md](DESIGN.md): Solaris visual identity and UI constraints; read before UI design changes.
- [ARCHITECTURE.md](ARCHITECTURE.md): boundaries, module map and data flow; read before architectural work.
- [docs/specs/](docs/specs/): behavior, API and security invariants; read the relevant specification before changing a feature.
- [docs/decisions/](docs/decisions/): confirmed architecture decisions and evidence limits.

The ignored `.docs/` is historical research, not a required checkout dependency or current implementation guide. Do not treat its candidate contracts, old bug reports or unconfirmed suggestions as current facts. If historical intent conflicts with code or maintained docs, expose the conflict before changing behavior.

## Commands

Use Node.js 20.19 or newer. Commands run from the repository root unless noted.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run dev` | Build Client, start production-mode Server |
| `npm run build` / `npm start` | Build Client / start Server with existing build |
| `npx tauri dev` / `npx tauri build` | Launch desktop / build bundles |
| `npm test -- <test-file>` | Focused Vitest tests (`e2e/` excluded) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run test:e2e` | Playwright HTTP deployment-boundary tests |
| `npm run smoke` | Check an already running Server; reads exported environment |
| `cd src-tauri && cargo check` | Rust check for native changes |

## Core constraints

- Keep implementations simple. Ask about unclear usage before designing abstractions. Preserve unrelated changes; do not add compatibility layers, fallback behavior or dual implementations by default.
- Scope is synchronous `imageGenerate`, including reference images. No video, Batch, upstream job polling, cancellation, JSONL or Server asset library.
- Client code must not import Server modules. Shared code is environment-neutral; digest uses Web Crypto. Use strict ESM, `.js` relative imports and `import type`; no `any`.
- Update closed DTO unions, registries, strict Zod validation and focused tests together. Raw DDL in `src/server/db/index.ts` is the only executable Server schema; no automatic legacy migration/deletion.
- Keep user ownership checks (`NOT_FOUND` for absent or foreign resources), write-only keys, AES-256-GCM AAD `${userId}:${connectionId}`, hashed Server sessions and native secure Client storage. Preserve native keyring features; never allow the mock store.
- Never persist Server image bytes or leak image data, tokens, codes, verifiers or keys in logs/errors. Preserve content-based redaction, upload limits, HTTPS provider URL validation, redirect refusal and configured Host/Origin/proxy boundaries.
- Public API errors use `src/shared/contracts.ts`'s closed codes and generic `INTERNAL` for unmapped failures; transport Host/Origin rejections are the explicit exceptions in `src/server/http/security.ts`.
- Server recomputes submission digests. Replays do not resubmit; deleting history retains receipts. `uncertain` is terminal. Generation, delivery and local saving are distinct; see [generation rules](docs/specs/generation.md).
- Model usability comes from the curated adapter allowlist, not discovery names or stored capabilities. Unsupported parameters must fail before provider calls.

## Workflow

1. **Understand** — Read the request and relevant maintained docs; identify intended behavior and acceptance scope.
2. **Inspect** — Check actual source, configuration, tests and worktree changes; distinguish evidence from assumptions.
3. **Plan** — Choose the smallest change. Clarify material unknowns; write a plan only for complex, multi-stage work.
4. **Execute** — Implement within the authorized scope and preserve the constraints above.
5. **Verify** — Match checks to impact. Code changes need relevant tests, typecheck and lint; native changes also need cargo check. Documentation-only changes need path, command and consistency checks. Tests with fixtures do not prove real IdP/provider, billing, browser or platform behavior.
6. **Update Docs** — Update affected specs/architecture; record only confirmed decisions. Report what changed, verification and remaining risks briefly.
