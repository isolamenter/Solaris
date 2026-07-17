import { defineConfig } from "@playwright/test";

const port = Number.parseInt(process.env.SOLARIS_E2E_PORT ?? "3210", 10);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: { command: `CREDENTIALS_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= SOLARIS_DATA_DIR=/tmp/solaris-e2e PORT=${port} npm run dev`, url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: !process.env.CI },
});
