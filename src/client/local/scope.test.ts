import { describe, expect, it } from "vitest";
import type { LocalScope } from "../../shared/local.js";
import { assertRecordId, localScopeKey, normalizeServerOrigin } from "./scope.js";

const scope = (serverOrigin: string, userId: string): LocalScope => ({ serverOrigin, userId });

describe("normalizeServerOrigin", () => {
  it("canonicalises scheme, host and default port", () => {
    expect(normalizeServerOrigin("http://LocalHost:3210")).toBe("http://localhost:3210");
    expect(normalizeServerOrigin("https://Solaris.Example:443/")).toBe("https://solaris.example");
    expect(normalizeServerOrigin("http://127.0.0.1:80/")).toBe("http://127.0.0.1");
    expect(normalizeServerOrigin("https://solaris.example:8443")).toBe("https://solaris.example:8443");
  });

  it("refuses anything that is not a Server origin", () => {
    expect(() => normalizeServerOrigin("solaris.example")).toThrow();
    expect(() => normalizeServerOrigin("ftp://solaris.example")).toThrow();
    expect(() => normalizeServerOrigin("http://user:secret@solaris.example")).toThrow();
    expect(() => normalizeServerOrigin("http://solaris.example/api")).toThrow();
  });
});

describe("localScopeKey", () => {
  it("separates two accounts on one Server", async () => {
    const first = await localScopeKey(scope("http://127.0.0.1:3210", "user-a"));
    const second = await localScopeKey(scope("http://127.0.0.1:3210", "user-b"));
    expect(first).not.toBe(second);
  });

  it("separates two Servers for one account", async () => {
    const first = await localScopeKey(scope("http://127.0.0.1:3210", "user-a"));
    const second = await localScopeKey(scope("https://solaris.example", "user-a"));
    expect(first).not.toBe(second);
  });

  it("is stable across equivalent spellings of the same Server", async () => {
    const canonical = await localScopeKey(scope("http://127.0.0.1:3210", "user-a"));
    const respelled = await localScopeKey(scope("http://127.0.0.1:3210/", "user-a"));
    const shouted = await localScopeKey(scope("HTTP://127.0.0.1:3210", "user-a"));
    expect(respelled).toBe(canonical);
    expect(shouted).toBe(canonical);
  });

  it("is a bounded directory-safe key", async () => {
    const key = await localScopeKey(scope("http://127.0.0.1:3210", "user-a"));
    expect(key).toMatch(/^s-[0-9a-f]{64}$/);
    const hostile = await localScopeKey(scope("http://127.0.0.1:3210", "../../etc/passwd"));
    expect(hostile).toMatch(/^s-[0-9a-f]{64}$/);
    expect(hostile).not.toContain("..");
  });

  it("refuses a scope without a user", async () => {
    await expect(localScopeKey(scope("http://127.0.0.1:3210", ""))).rejects.toThrow();
  });
});

describe("assertRecordId", () => {
  it("accepts the identifiers the contract uses", () => {
    expect(assertRecordId("0f2a1c4e-0000-4000-8000-000000000001", "run id")).toBe(
      "0f2a1c4e-0000-4000-8000-000000000001",
    );
  });

  it("refuses anything that could address another record", () => {
    for (const value of ["", ".", "..", ".hidden", "../escape", "a/b", "a\\b", "a\u0000b", "a".repeat(129)]) {
      expect(() => assertRecordId(value, "run id")).toThrow();
    }
  });
});
