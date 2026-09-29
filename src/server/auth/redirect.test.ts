import { describe, expect, it } from "vitest";
import { isLoopbackAddress, parseDesktopRedirect, parseRedirectAllowlist } from "./redirect.js";

const allowlist = parseRedirectAllowlist(["127.0.0.1"]);

describe("desktop redirect parsing", () => {
  it("accepts the documented loopback callback and canonicalises it", () => {
    expect(parseDesktopRedirect("http://127.0.0.1:8765/callback", allowlist)).toBe("http://127.0.0.1:8765/callback");
    expect(parseDesktopRedirect("http://127.0.0.1:1/callback", allowlist)).toBe("http://127.0.0.1:1/callback");
    expect(parseDesktopRedirect("http://127.0.0.1:65535/callback", allowlist)).toBe("http://127.0.0.1:65535/callback");
    // 127.0.0.0/8 is loopback, not only the first address.
    expect(parseDesktopRedirect("http://127.9.9.9:8765/callback", parseRedirectAllowlist(["127.9.9.9"]))).toBe("http://127.9.9.9:8765/callback");
  });

  it("rejects every redirect that is not the exact registered loopback callback", () => {
    const rejected = [
      // Not the registered host: aliases, lookalikes, suffix matching, remote hosts.
      "http://localhost:8765/callback",
      "http://LOCALHOST:8765/callback",
      "http://127.0.0.1.nip.io:8765/callback",
      "http://127.0.0.1.evil.example:8765/callback",
      "http://evil.example:8765/callback",
      "http://127.0.0.2:8765/callback",
      "http://[::1]:8765/callback",
      // Not HTTP, or an HTTPS upgrade the client never uses.
      "https://127.0.0.1:8765/callback",
      "ftp://127.0.0.1:8765/callback",
      // Not the exact callback path.
      "http://127.0.0.1:8765/callback/../evil",
      "http://127.0.0.1:8765/callback/extra",
      "http://127.0.0.1:8765/",
      "http://127.0.0.1:8765",
      "http://127.0.0.1:8765/CALLBACK",
      // Credentials, query or fragment.
      "http://user:pass@127.0.0.1:8765/callback",
      "http://127.0.0.1:8765/callback?next=https://evil.example",
      "http://127.0.0.1:8765/callback#fragment",
      // Missing, zero or out-of-range port.
      "http://127.0.0.1/callback",
      "http://127.0.0.1:0/callback",
      "http://127.0.0.1:65536/callback",
      "http://127.0.0.1:-1/callback",
      // Not URLs at all.
      "",
      "not a url",
      "//127.0.0.1:8765/callback",
    ];
    for (const candidate of rejected) {
      expect(() => parseDesktopRedirect(candidate, allowlist), candidate).toThrow("redirect_uri must be a registered loopback");
    }
  });

  it("does not echo the rejected value in the error", () => {
    const error = (() => {
      try {
        parseDesktopRedirect("http://evil.example:8765/callback?token=abc", allowlist);
        return null;
      } catch (thrown) {
        return thrown as Error & { code: string; statusCode: number };
      }
    })();
    expect(error?.code).toBe("AUTH_FLOW_INVALID");
    expect(error?.statusCode).toBe(400);
    expect(error?.message).not.toContain("evil.example");
    expect(error?.message).not.toContain("token=");
  });

  it("accepts ::1 only when it is registered", () => {
    const v6 = parseRedirectAllowlist(["[::1]"]);
    expect(v6).toEqual(["::1"]);
    expect(parseDesktopRedirect("http://[::1]:8765/callback", v6)).toBe("http://[::1]:8765/callback");
    expect(() => parseDesktopRedirect("http://[::1]:8765/callback", allowlist)).toThrow("redirect_uri must be a registered loopback");
  });

  it("refuses a non-loopback allowlist entry instead of becoming an open redirect", () => {
    for (const entry of ["evil.example", "localhost", "10.0.0.5", "0.0.0.0", "::2", "127.0.0.1.evil.example"]) {
      expect(() => parseRedirectAllowlist([entry]), entry).toThrow("loopback IP literals only");
    }
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
  });
});
