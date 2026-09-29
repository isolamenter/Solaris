import { defineConfig } from "@playwright/test";

const port = Number.parseInt(process.env.SOLARIS_E2E_PORT ?? "3210", 10);
/**
 * The harness runs the real server, so it needs the same required configuration
 * a deployment does — including the public origin, which is what the boundary
 * compares `Host` against. The IdP is deliberately an unroutable loopback port:
 * the e2e run proves the login flow is reachable and fails closed, and it never
 * makes a real upstream or IdP call.
 */
const origin = `http://127.0.0.1:${port}`;
const environment = [
  "CREDENTIALS_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "SOLARIS_DATA_DIR=/tmp/solaris-e2e",
  `PORT=${port}`,
  `SOLARIS_PUBLIC_ORIGIN=${origin}`,
  "SOLARIS_AUTH_ADAPTER=oidc",
  "SOLARIS_CREDENTIAL_SOURCE=user-key",
  "SOLARIS_OIDC_ISSUER=http://127.0.0.1:9",
  "SOLARIS_OIDC_CLIENT_ID=solaris-e2e",
  "SOLARIS_OIDC_CLIENT_SECRET=e2e-placeholder",
].join(" ");

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: origin },
  webServer: { command: `${environment} npm run dev`, url: `${origin}/api/health`, reuseExistingServer: !process.env.CI },
});
