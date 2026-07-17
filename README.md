# Solaris

A local-first playground for generating images and videos with AI providers. Solaris combines a React interface with a Fastify backend, keeps application data on your machine, and currently includes a Google Gemini provider integration.

> Solaris is under active development. Provider APIs can change, and generated media may incur charges from the configured provider.

## Features

- **Local-first operation** — the server binds only to `127.0.0.1`, with run history and configuration stored locally in SQLite.
- **Encrypted credentials** — provider API keys are encrypted at rest with AES-256-GCM and are never returned by the API.
- **Image generation and editing** — create images from prompts or attach supported reference images.
- **Model-specific controls** — Solaris exposes only the parameters supported by each adapted model.
- **Asynchronous video runs** — video submissions are queued and polled without blocking the UI.
- **Provider discovery** — discover compatible Gemini models or add model records manually.
- **Run archive** — inspect redacted request metadata, export runs as cURL, cancel active runs, and delete history.
- **Security boundaries** — same-origin checks, HTTPS-only provider URLs, upload limits, and inspector redaction are enforced by the server.

## Tech Stack

| Area | Technology |
| --- | --- |
| Client | React 19, Vite, TypeScript |
| Server | Fastify 5, TypeScript |
| Validation | Zod |
| Persistence | SQLite, Drizzle ORM |
| Unit tests | Vitest |
| End-to-end tests | Playwright |
| Linting | ESLint |

## Requirements

- **Node.js 20.19 or newer**
- npm
- A Google Gemini API key for provider requests

## Quick Start

1. Clone the repository and enter the project directory:

    ````shell
    git clone <repository-url>
    cd Solaris
    ````

2. Install dependencies:

    ````shell
    npm install
    ````

3. Create the local environment file:

    ````shell
    cp .env.example .env.local
    ````

4. Generate a 32-byte encryption key and add it to `.env.local`:

    ````shell
    openssl rand -base64 32
    ````

    Your file should resemble:

    ````dotenv
    CREDENTIALS_MASTER_KEY=<generated-base64-key>
    SOLARIS_DATA_DIR=.solaris-data
    PORT=3210
    ````

    Keep this key stable. Existing encrypted provider credentials cannot be decrypted if it is lost or changed.

5. Build the client and start Solaris:

    ````shell
    npm run dev
    ````

6. Open [http://127.0.0.1:3210](http://127.0.0.1:3210), create a Gemini connection, and enter your provider API key.

## Configuration

Solaris reads `.env.local` during server initialization.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CREDENTIALS_MASTER_KEY` | For saved connections | — | Base64-encoded 32-byte key used to encrypt provider credentials. |
| `SOLARIS_DATA_DIR` | No | `.solaris-data` | Directory containing the SQLite database and local assets. |
| `PORT` | No | `3210` | Local HTTP port. The server always binds to `127.0.0.1`. |

Do not commit `.env.local`, local data directories, API keys, or generated credentials.

## Usage

1. Open **Connections** and create a Google Gemini connection.
2. Test the connection, then discover compatible models or add one manually.
3. Open **Workspace**, select a connection and an adapted model, then enter a prompt.
4. Add reference images when the selected model supports them.
5. Review generated media and redacted inspector data.
6. Use **Run archive** to inspect, cancel, export, or delete runs.

Solaris currently adapts selected Gemini image model families and Gemini Veo-style video models. A discovered model may appear unavailable until an explicit adapter is implemented for it.

## Available Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Build the client, then start the production-mode local server. |
| `npm run build` | Build the Vite client into `dist/client`. |
| `npm start` | Start the server using an existing client build. |
| `npm test` | Run Vitest unit tests. |
| `npm run test:watch` | Run unit tests in watch mode. |
| `npm run test:e2e` | Run Playwright end-to-end tests. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run lint` | Run ESLint. |
| `npm run smoke` | Check the health endpoint of a running server. |

`npm start` requires `dist/client/index.html`; run `npm run build` first. Although named `dev`, `npm run dev` builds the client and starts the server with `NODE_ENV=production`.

## Architecture

````text
src/
├── client/                 React UI and typed API client
├── server/
│   ├── db/                 SQLite setup and schema
│   ├── http/               Fastify app, routes, and security checks
│   ├── providers/          Provider plugins and adapters
│   ├── repository.ts       Persistence and DTO mapping
│   ├── runner.ts           Asynchronous video submission and polling
│   ├── services.ts         Domain validation and orchestration
│   └── vault.ts            Credential encryption and redaction
└── shared/
    └── contracts.ts        Shared client/server API contracts
````

The Vite client is built into `dist/client`, which Fastify serves alongside the API. Provider-specific behavior is isolated behind the provider plugin interface.

## Development

Before submitting changes, run the narrowest relevant tests followed by the full static checks:

````shell
npm test
npm run typecheck
npm run lint
````

For browser-level behavior:

````shell
npm run test:e2e
````

When adding a provider:

- Implement the provider plugin and adapter under `src/server/providers/`.
- Register the provider in `src/server/providers/index.ts`.
- Update the closed provider ID and capability contracts in `src/shared/contracts.ts`.
- Add focused tests for provider requests, responses, validation, and security behavior.

## Security

Solaris is designed for single-user, local execution—not public network deployment.

- It binds only to the loopback interface.
- Mutating requests require an exact same origin.
- Provider base URLs must use HTTPS and cannot include credentials, query strings, or fragments.
- Provider credentials are encrypted with AES-256-GCM using the profile ID as authenticated data.
- Request and response inspectors are redacted before persistence.
- Asset MIME types, individual file sizes, total upload sizes, and multipart limits are validated.

Please report suspected vulnerabilities privately to the project maintainers rather than opening a public issue containing exploit details or credentials.

## Contributing

Contributions are welcome.

1. Open an issue to discuss substantial changes.
2. Fork the repository and create a focused branch.
3. Add or update tests with the implementation.
4. Run unit tests, type checking, linting, and relevant end-to-end tests.
5. Submit a pull request describing the motivation, implementation, and verification steps.

Keep client/server contracts synchronized, preserve local security boundaries, and avoid introducing provider-specific behavior outside the provider plugin layer.

## License

Solaris is available under the [MIT License](LICENSE).
