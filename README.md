# Solaris

A desktop workspace for AI image generation and editing, with a self-hostable Server. The Tauri Client keeps image files on your device; the Server authenticates users, stores account and run metadata, and forwards synchronous image requests through the Gemini adapter. The Server never persists images.

Solaris is under active development. Model requests may incur provider charges.

## Features

- Generate images from prompts, optionally with reference images.
- Configure per-user connections with encrypted, write-only API keys.
- Discover candidate models or add them manually; only explicitly adapted models can run.
- View remote run history and track files saved on this device separately.
- Replay the same submission without another upstream call, with best-effort image delivery from a temporary memory cache.

The current scope is synchronous single-request image generation. Video, Batch, upstream job polling and cancellation are outside the scope.

## Tech Stack

| Area | Technology |
| --- | --- |
| Desktop | Tauri v2, Rust; macOS first |
| Client | React 19, Vite 7, strict TypeScript |
| Server | Fastify 5, TypeScript, Zod |
| Server persistence | SQLite through better-sqlite3 and raw SQL |
| Client persistence | Scoped JSON records, local image files, OS secure storage |
| Checks | Vitest, Playwright, ESLint, TypeScript |

## Requirements

- Node.js **20.19 or newer**, npm.
- For desktop development: Rust/Cargo (crate minimum Rust 1.77) and the native Tauri build prerequisites. On macOS, install Xcode Command Line Tools with `xcode-select --install`.
- An OIDC identity provider and a registered Server client for sign-in.
- A model-service API key and HTTPS endpoint implementing the Gemini protocol for generation.

The current desktop bundle targets macOS (`app` and `dmg`). Windows secure storage is configured, but a Windows release is not established; Linux secure storage is not configured.

## Quick Start

```shell
git clone https://github.com/isolamenter/Solaris.git
cd Solaris
npm ci
cp .env.example .env.local
openssl rand -base64 32
```

Edit `.env.local`, replacing the placeholders:

| Variable | Local development value |
| --- | --- |
| `SOLARIS_PUBLIC_ORIGIN` | `http://127.0.0.1:3210` |
| `CREDENTIALS_MASTER_KEY` | The generated base64-encoded 32-byte key |
| `SOLARIS_AUTH_ADAPTER` | `oidc` |
| `SOLARIS_OIDC_ISSUER` | Your IdP issuer URL |
| `SOLARIS_OIDC_CLIENT_ID` | Your registered Server client ID |
| `SOLARIS_OIDC_CLIENT_SECRET` | Your Server client secret |
| `SOLARIS_CREDENTIAL_SOURCE` | `user-key` |

Register `http://127.0.0.1:3210/api/auth/callback` as the Server client's redirect URI at the IdP. For a remote deployment, use `${SOLARIS_PUBLIC_ORIGIN}/api/auth/callback` instead. The desktop's random loopback callback is a separate leg managed by Solaris.

Keep the master key stable: losing or replacing it makes existing saved model credentials unreadable. Keep `.env.local`, keys and local data out of Git.

Start the Server:

```shell
npm run dev
```

In another terminal, start the desktop Client:

```shell
npx tauri dev
```

Enter `http://127.0.0.1:3210` in the Client, sign in using the system browser, then create a Gemini connection in **Connections**, enter your key and discover models. In **Workspace**, select an adapted model, enter a prompt and optionally select reference files. Choose a local output directory to save delivered images.

The Server also serves the built UI at [http://127.0.0.1:3210](http://127.0.0.1:3210). Full login and file operations require the Tauri shell; this browser page is a development surface.

## Configuration

The Server reads `.env.local` from the working directory at startup; exported environment variables take precedence. See [.env.example](.env.example) for the complete configuration, including upload-independent upstream budgets and delivery-cache limits.

The default bind address is `127.0.0.1`, port `3210`, and data directory `.solaris-data`. One Server process owns each data directory. Pre-refactor databases are refused; select a fresh directory rather than expecting migration.

For a remote Server, configure an HTTPS public origin and TLS proxy or tunnel. Set `SOLARIS_TRUST_PROXY` to the actual trusted proxy hop count. `SOLARIS_ALLOWED_ORIGINS` adds exact origins when needed; Host and Origin checks remain enforced alongside bearer authentication.

## Development and Checks

| Command | Description |
| --- | --- |
| `npm run dev` | Build the Client, then start the Server with `NODE_ENV=production`; no hot reload. |
| `npm run build` | Build the Vite Client into `dist/client`. |
| `npm start` | Start the Server with an existing Client build. |
| `npx tauri dev` | Build the Client and launch the native desktop shell. |
| `npx tauri build` | Build the configured desktop bundles. |
| `npm test` / `npm run test:watch` | Run Vitest unit tests once / in watch mode. |
| `npm run test:e2e` | Run Playwright deployment-boundary tests. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run lint` | Run ESLint. |
| `npm run smoke` | Check health, Host/Origin rejection and unauthenticated API rejection on a running Server. |
| `cd src-tauri && cargo check` | Check the Rust desktop shell. |

`npm start` requires `dist/client/index.html`; build first. The smoke script reads exported variables, not `.env.local`; for a remote Server, run `SOLARIS_PUBLIC_ORIGIN=https://your-server.example npm run smoke`.

For code changes, run the relevant unit tests, then type checking and linting; native changes also need `cargo check`. Playwright currently exercises HTTP deployment boundaries with an unreachable test IdP. Neither these tests nor a Vite build prove a signed-in desktop flow, real model generation, billing or cross-platform behavior.

## Project Structure and Documentation

```text
src/client/       React UI, typed API client and device-local logic
src/server/       HTTP, authentication, credentials, providers and SQLite
src/shared/       Public DTOs, digest and local-device interfaces
src-tauri/        Native shell, secure storage, dialogs and file operations
e2e/             Deployment-boundary tests
scripts/         Running-server smoke check
docs/specs/      Maintained feature behavior and constraints
docs/decisions/  Confirmed architecture choices and evidence
```

- [ARCHITECTURE.md](ARCHITECTURE.md): module responsibilities, dependency direction and data flow.
- [Generation](docs/specs/generation.md), [identity and connections](docs/specs/identity-and-connections.md), [device-local data](docs/specs/local-data.md): maintained feature specifications.
- [Architecture decisions](docs/decisions/architecture-decisions.md): confirmed choices and known evidence limits.
- [AGENTS.md](AGENTS.md): canonical instructions for AI coding agents.

The Git-ignored `.docs/` directory contains historical refactor research and backlogs, including candidate contracts and superseded descriptions. Maintained project documentation lives at the paths above and does not require `.docs/` to be present in a fresh checkout.

## Contributing

Open an issue to discuss substantial changes, keep pull requests focused, and describe the behavior change and verification performed. Keep Client/Server contracts synchronized and preserve the image-ownership and credential boundaries described in the architecture and feature specifications.

Report suspected vulnerabilities privately to the maintainers; do not include credentials or private image data in public issues.

## License

Solaris is available under the [MIT License](LICENSE).
