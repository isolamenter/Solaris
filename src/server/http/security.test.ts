import { describe, expect, it } from "vitest";
import { deploymentBoundary, parseTrustProxy, type DeploymentBoundary } from "./security.js";

/**
 * The deployment boundary (CONTRACTS §1, §9, §13). The unit-level rules: what is
 * accepted, what is refused, and what refuses to start.
 */

const ORIGIN = "https://solaris.example.test";

function boundary(overrides: { publicOrigin?: string; allowedOrigins?: string[]; trustProxy?: string } = {}): DeploymentBoundary {
  return deploymentBoundary({
    publicOrigin: overrides.publicOrigin ?? ORIGIN,
    allowedOrigins: overrides.allowedOrigins ?? [],
    trustProxy: overrides.trustProxy,
  });
}

const reject = (b: DeploymentBoundary, headers: Record<string, string | undefined>) =>
  b.rejectionFor({ headers: headers as { host?: string; origin?: string } })?.code ?? null;

describe("deployment boundary configuration", () => {
  it("refuses to start without a public origin", () => {
    expect(() => deploymentBoundary({ publicOrigin: undefined, allowedOrigins: [], trustProxy: undefined })).toThrow(/SOLARIS_PUBLIC_ORIGIN is required/);
    expect(() => deploymentBoundary({ publicOrigin: "  ", allowedOrigins: [], trustProxy: undefined })).toThrow(/SOLARIS_PUBLIC_ORIGIN is required/);
  });

  it("refuses a public origin that is not a bare origin", () => {
    expect(() => boundary({ publicOrigin: "https://solaris.example.test/app" })).toThrow(/origin only/);
    expect(() => boundary({ publicOrigin: "https://solaris.example.test/?x=1" })).toThrow(/origin only/);
    expect(() => boundary({ publicOrigin: "https://user:pass@solaris.example.test" })).toThrow(/credentials/);
    expect(() => boundary({ publicOrigin: "not a url" })).toThrow(/absolute origin/);
  });

  it("requires https, except for a literal loopback host", () => {
    expect(() => boundary({ publicOrigin: "http://solaris.example.test" })).toThrow(/must use https/);
    expect(() => boundary({ publicOrigin: "http://localhost:3210" })).toThrow(/must use https/);
    expect(boundary({ publicOrigin: "http://127.0.0.1:3210" }).publicOrigin).toBe("http://127.0.0.1:3210");
    expect(boundary({ publicOrigin: "http://[::1]:3210" }).publicOrigin).toBe("http://[::1]:3210");
  });

  it("refuses a malformed trusted-proxy or allowlist entry at startup", () => {
    expect(() => boundary({ trustProxy: "true" })).toThrow(/hop count/);
    expect(() => boundary({ trustProxy: "-1" })).toThrow(/hop count/);
    expect(() => boundary({ trustProxy: "1.5" })).toThrow(/hop count/);
    expect(() => boundary({ allowedOrigins: ["https://app.example.test/with/a/path"] })).toThrow(/origin only/);
  });

  it("treats the trusted-proxy value as a hop count, never as a flag", () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy("")).toBe(0);
    expect(parseTrustProxy("0")).toBe(0);
    expect(parseTrustProxy("2")).toBe(2);
  });
});

describe("Host enforcement", () => {
  it("accepts the configured authority and its default-port spelling", () => {
    const b = boundary();
    expect(reject(b, { host: ORIGIN.slice("https://".length) })).toBeNull();
    expect(reject(b, { host: "solaris.example.test:443" })).toBeNull();
    expect(reject(b, { host: "SOLARIS.EXAMPLE.TEST" })).toBeNull();
  });

  it("refuses every other authority, including a lookalike and an absent Host", () => {
    const b = boundary();
    for (const host of ["attacker.example", "solaris.example.test.attacker.example", "solaris.example.test:8443", "127.0.0.1:3210", "solaris.example.test, attacker.example", undefined]) {
      expect(reject(b, { host }), `host=${String(host)}`).toBe("HOST_REJECTED");
    }
  });

  it("keeps a non-default port part of the authority", () => {
    const b = boundary({ publicOrigin: "https://solaris.example.test:8443" });
    expect(reject(b, { host: "solaris.example.test:8443" })).toBeNull();
    expect(reject(b, { host: "solaris.example.test" })).toBe("HOST_REJECTED");
  });

  it("refuses a duplicated Host header rather than picking one", () => {
    const b = boundary();
    expect(b.rejectionFor({ headers: { host: ["solaris.example.test", "attacker.example"] } })?.code).toBe("HOST_REJECTED");
  });
});

describe("Origin enforcement", () => {
  it("accepts the public origin and treats an absent Origin as a non-browser client", () => {
    const b = boundary();
    expect(reject(b, { host: "solaris.example.test", origin: ORIGIN })).toBeNull();
    expect(reject(b, { host: "solaris.example.test" })).toBeNull();
  });

  it("refuses any other origin, including a malformed or duplicated one", () => {
    const b = boundary();
    for (const origin of ["https://attacker.example", "http://solaris.example.test", "https://solaris.example.test:8443", "null", "solaris.example.test", "https://solaris.example.test, https://attacker.example"]) {
      expect(reject(b, { host: "solaris.example.test", origin }), `origin=${origin}`).toBe("ORIGIN_REJECTED");
    }
  });

  it("accepts only what the allowlist names, not every origin of the right shape", () => {
    const b = boundary({ allowedOrigins: ["tauri://localhost", "https://app.example.test"] });
    expect(b.allowedOrigins).toEqual(new Set([ORIGIN, "tauri://localhost", "https://app.example.test"]));
    expect(reject(b, { host: "solaris.example.test", origin: "tauri://localhost" })).toBeNull();
    expect(reject(b, { host: "solaris.example.test", origin: "tauri://other" })).toBe("ORIGIN_REJECTED");
  });

  it("checks the Host before the Origin, so a forged Host is never reported as a good origin", () => {
    const b = boundary();
    expect(reject(b, { host: "attacker.example", origin: ORIGIN })).toBe("HOST_REJECTED");
  });
});
