import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { SqliteRepository } from "../repository.js";

/**
 * The process lifecycle (CONTRACTS §9, §13): a Server that is not configured
 * refuses to start, a started Server serves the boundary over a real socket and
 * stops cleanly on a signal, and a restart converges what the previous process
 * left behind.
 *
 * Each case runs `src/server/main.ts` as its own process, in a throwaway working
 * directory with its own data directory, so nothing here can disturb a real
 * deployment — and nothing here reaches an IdP or an upstream.
 */

const MAIN = resolve("src/server/main.ts");
/** What `npm start` runs: the `tsx` CLI, which is a wrapper around this. */
const TSX = resolve("node_modules/.bin/tsx");
/** The same loader the wrapper installs, so the server is the direct child. */
const TSX_LOADER = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const TSX_PREFLIGHT = resolve("node_modules/tsx/dist/preflight.cjs");
const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const IDP_ISSUER = "http://127.0.0.1:9";

const roots: string[] = [];
const children: ServerProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid === undefined) continue;
    // The whole group: the direct child is the server, the wrapper has one too.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await delay(50);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A deployment directory: the built UI the server serves, and its own data. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "solaris-lifecycle-"));
  roots.push(root);
  mkdirSync(join(root, "dist/client"), { recursive: true });
  writeFileSync(join(root, "dist/client/index.html"), "<!doctype html><title>Solaris</title>\n");
  return root;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** `stdio: ["ignore", "pipe", "pipe"]` — stdout and stderr are read, stdin is not. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

type ServerEnvironment = Record<string, string>;
type Outcome = { code: number | null; stdout: string; stderr: string };

/**
 * `direct: true` runs the server as this process's own child, so a signal and
 * an exit code belong to it. `direct: false` runs the `tsx` CLI, which is what
 * `npm start` actually executes and which sits between the two.
 */
function launch(root: string, environment: ServerEnvironment, direct = true): ServerProcess {
  const command = direct ? process.execPath : TSX;
  const args = direct ? ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, MAIN] : [MAIN];
  const child = spawn(command, args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a test can never leave a server behind.
    detached: true,
  });
  children.push(child);
  return child;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Whether something is still listening on the port. */
function accepting(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => socket.end(() => done(true)));
    socket.once("error", () => done(false));
  });
}

/** The listener is gone: the deployment has really stopped. */
async function waitForPortClosed(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await accepting(port)) {
    if (Date.now() > deadline) throw new Error(`Something is still listening on ${port}`);
    await delay(100);
  }
}

/**
 * A raw HTTP request, because `fetch` will not send a `Host` header that
 * disagrees with the connection target — and a forged `Host` is exactly what
 * the boundary exists to refuse.
 */
function httpGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const call = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => done({ status: response.statusCode ?? 0, body }));
    });
    call.on("error", fail);
    call.end();
  });
}

/** Runs the server to completion — used for the configurations that must refuse. */
async function runToExit(root: string, environment: ServerEnvironment): Promise<Outcome> {
  const child = launch(root, environment);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.on("exit", (value) => done(value)));
  return { code, stdout, stderr };
}

type RunningServer = { child: ServerProcess; origin: string; stdout: () => string };

async function startServer(root: string, environment: ServerEnvironment, port: number, direct = true): Promise<RunningServer> {
  const child = launch(root, environment, direct);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const origin = environment.SOLARIS_PUBLIC_ORIGIN ?? "";
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The server never started listening.\nstdout: ${stdout}\nstderr: ${stderr}`)), 20_000);
    const watch = () => {
      if (stdout.includes("Solaris is listening")) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on("data", watch);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`The server exited with ${String(code)}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
  expect(origin).toContain(`:${port}`);
  return { child, origin, stdout: () => stdout };
}

/** SIGTERM, and the exit code the process chose. */
async function stop(child: ServerProcess): Promise<number | null> {
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  child.kill("SIGTERM");
  return exited;
}

function deployment(root: string, port: number, overrides: ServerEnvironment = {}): ServerEnvironment {
  return {
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    SOLARIS_DATA_DIR: join(root, "data"),
    SOLARIS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    SOLARIS_AUTH_ADAPTER: "oidc",
    SOLARIS_CREDENTIAL_SOURCE: "user-key",
    SOLARIS_OIDC_ISSUER: IDP_ISSUER,
    SOLARIS_OIDC_CLIENT_ID: "solaris-lifecycle",
    SOLARIS_OIDC_CLIENT_SECRET: "lifecycle-placeholder",
    PORT: String(port),
    ...overrides,
  };
}

describe("a server that is not configured refuses to start", () => {
  it("refuses without a public origin", async () => {
    const root = workspace();
    const environment = deployment(root, await freePort());
    delete environment.SOLARIS_PUBLIC_ORIGIN;
    const outcome = await runToExit(root, environment);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("SOLARIS_PUBLIC_ORIGIN is required");
  });

  it("refuses without the credential master key", async () => {
    const root = workspace();
    const environment = deployment(root, await freePort());
    delete environment.CREDENTIALS_MASTER_KEY;
    const outcome = await runToExit(root, environment);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("CREDENTIALS_MASTER_KEY is required");
  });

  it("refuses a master key that is not 32 bytes", async () => {
    const root = workspace();
    const outcome = await runToExit(root, deployment(root, await freePort(), { CREDENTIALS_MASTER_KEY: "c2hvcnQ=" }));
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("must be a base64-encoded 32-byte key");
  });

  it("refuses a trusted-proxy value that is a flag rather than a hop count", async () => {
    const root = workspace();
    const outcome = await runToExit(root, deployment(root, await freePort(), { SOLARIS_TRUST_PROXY: "true" }));
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("hop count");
  });

  it("refuses an auth adapter it cannot serve with", async () => {
    const root = workspace();
    const outcome = await runToExit(root, deployment(root, await freePort(), { SOLARIS_AUTH_ADAPTER: "none" }));
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).not.toBe("");
  });
});

describe("a configured server serves the boundary and stops on a signal", () => {
  it("enforces the deployment boundary over a real socket and exits 0 on SIGTERM", async () => {
    const root = workspace();
    const port = await freePort();
    const server = await startServer(root, deployment(root, port), port);

    const health = await fetch(`${server.origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, bind: "127.0.0.1" });

    // The boundary is enforced on the real listening socket, not only in inject.
    const configuredHost = `127.0.0.1:${port}`;
    const rightHost = await httpGet(port, "/api/health", { host: configuredHost });
    expect(rightHost.status).toBe(200);

    const forgedHost = await httpGet(port, "/api/health", { host: "attacker.example" });
    expect(forgedHost.status).toBe(421);
    expect(JSON.parse(forgedHost.body)).toMatchObject({ error: { code: "HOST_REJECTED" } });

    const forgedOrigin = await httpGet(port, "/api/health", { host: configuredHost, origin: "https://attacker.example" });
    expect(forgedOrigin.status).toBe(403);
    expect(JSON.parse(forgedOrigin.body)).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });

    const unauthenticated = await fetch(`${server.origin}/api/me`);
    expect(unauthenticated.status).toBe(401);

    // The client bundle is served from the deployment's own working directory.
    const client = await fetch(`${server.origin}/`);
    expect(client.status).toBe(200);
    expect(await client.text()).toContain("Solaris");

    const exited = stop(server.child);
    await waitForPortClosed(port);
    expect(await exited).toBe(0);
  });

  it("stops the listener when the `tsx` wrapper that npm start runs is signalled", async () => {
    const root = workspace();
    const port = await freePort();
    const server = await startServer(root, deployment(root, port), port, false);

    expect((await fetch(`${server.origin}/api/health`)).status).toBe(200);
    // The wrapper reports 128+SIGTERM for itself; what a deployment depends on is
    // that the server stops listening and no process is left holding the port.
    server.child.kill("SIGTERM");
    await waitForPortClosed(port);
  });
});

describe("a restart converges what the previous process left behind", () => {
  it("marks an abandoned run uncertain before accepting requests", async () => {
    const root = workspace();
    const dataDir = join(root, "data");

    // A process that died mid-run: the row is still `running` with no owner.
    const database = openDatabase(dataDir);
    const repository = new SqliteRepository(database.sqlite);
    const user = repository.createUserWithIdentity({ issuer: IDP_ISSUER, subject: `lifecycle-${randomUUID()}` });
    const connection = repository.createConnection({
      userId: user.id,
      id: randomUUID(),
      name: "gateway",
      adapterId: "gemini",
      baseUrl: "https://gateway.example.test",
      config: {},
      keyEncrypted: "",
    });
    const model = repository.upsertModel({ userId: user.id, connectionId: connection.id, providerModelId: "gemini-3.1-flash-image", capabilities: ["imageGenerate"], manual: true });
    const runId = randomUUID();
    const claim = repository.claimRun({
      userId: user.id,
      id: runId,
      submissionId: randomUUID(),
      contentDigest: "a".repeat(64),
      connectionId: connection.id,
      connectionName: connection.name,
      modelId: model.id,
      providerModelId: model.providerModelId,
      prompt: "orphaned by a crash",
      parameters: {},
      referenceCount: 0,
    });
    expect(claim.claimed).toBe(true);
    expect(repository.getRun(user.id, runId).status).toBe("running");
    database.sqlite.close();

    const port = await freePort();
    const server = await startServer(root, deployment(root, port), port);
    expect(server.stdout()).toContain("abandoned run(s) marked uncertain");
    expect(await stop(server.child)).toBe(0);

    const reopened = openDatabase(dataDir);
    try {
      const recovered = new SqliteRepository(reopened.sqlite).getRun(user.id, runId);
      expect(recovered.status).toBe("uncertain");
      // It is never resubmitted: the receipt still owns this submission.
      expect(recovered.status).not.toBe("running");
    } finally {
      reopened.sqlite.close();
    }
  });
});
