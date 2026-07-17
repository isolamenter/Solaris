# Solaris

Solaris is a local-first provider playground. It is a single Node process with a React/Vite UI, a Fastify BFF, SQLite WAL, and a local content-addressed asset store. It never exposes provider credentials to the browser.

## Run

1. Use Node 20.19 or newer.
2. Copy `.env.example` to `.env.local` and set a random base64 `CREDENTIALS_MASTER_KEY`.
3. Run `npm install`, then `npm run dev` (it builds the Vite client and starts the local server).
4. Open `http://127.0.0.1:3210`.

The server intentionally listens only on `127.0.0.1`; it is not a LAN or public service. SQLite and assets live in `.solaris-data/` by default. Existing Solaris databases, object storage, and environment files are not imported.

## Providers

Connections are named profiles. Solaris currently supports only the `gemini` provider. A profile supplies its Gemini base URL and API key; the BFF selects the fixed Gemini protocol paths, and provider endpoints must use HTTPS.

Solaris supports Gemini image generation, image editing, and video generation. Chat-only models are excluded from automatic discovery and cannot be added manually. The Gemini adapter accepts native Google model metadata as well as Gemini-compatible gateways that omit generation-method metadata; it infers image/video capabilities from the model record and uses Gemini inline data plus explicit image response modalities for generation and editing.

Gemini 3.1 Flash Image models expose model-driven controls in the workspace for aspect ratio, `512`/`1K`/`2K`/`4K` output, minimal/high thinking, and optional Google Search grounding. Search is off by default and, when enabled, is sent as the fixed Gemini `googleSearch` tool; arbitrary tools are not accepted. Image creation automatically switches from generation to editing when local references are attached. A request can contain up to 14 JPEG, PNG, or WebP references, subject to the displayed per-file and combined payload limits. The retired `gemini-3.1-flash-image-preview` ID remains recognizable for compatible gateways but is flagged in the UI in favor of `gemini-3.1-flash-image`.

## Future providers

OpenAI, OpenAI-compatible endpoints, Volcengine Ark, and Anthropic are planned for future implementation. They are not currently exposed by the API or UI, and their provider adapters will be added only after their model discovery and media-generation flows are fully supported and tested.

## Checks

`npm run test`, `npm run typecheck`, and `npm run lint` validate the project. `npm run build && npm start` runs the built UI. `npm run test:e2e` expects Playwright's Chromium browser to be installed.

## Data and safety

Profile API keys are AES-256-GCM encrypted using `CREDENTIALS_MASTER_KEY`, with the profile ID as authenticated associated data. Keys are omitted from DTOs, logs, stored inspectors and cURL exports. Business history is retained locally until deleted from Settings. The BFF rejects cross-origin writes, sends no CORS headers, and never acts as an arbitrary HTTP proxy.
