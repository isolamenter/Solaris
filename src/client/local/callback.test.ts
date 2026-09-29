import { describe, expect, it } from "vitest";
import { parseLoopbackCallback, parseLoopbackRedirectUri } from "./callback.js";

const REDIRECT = "http://127.0.0.1:53124/callback";
const STATE = "client-state";

function callback(requestTarget: string, redirectUri = REDIRECT, expectedState = STATE): string {
  return parseLoopbackCallback({ requestTarget, redirectUri, expectedState });
}

describe("parseLoopbackRedirectUri", () => {
  it("accepts the listener's own redirect URI", () => {
    expect(parseLoopbackRedirectUri(REDIRECT)).toEqual({ port: 53124, url: REDIRECT });
  });

  it("refuses a host or path the listener would not have reported", () => {
    expect(() => parseLoopbackRedirectUri("http://localhost:53124/callback")).toThrow();
    expect(() => parseLoopbackRedirectUri("https://127.0.0.1:53124/callback")).toThrow();
    expect(() => parseLoopbackRedirectUri("http://127.0.0.1:53124/callback/extra")).toThrow();
    expect(() => parseLoopbackRedirectUri("http://127.0.0.1/callback")).toThrow();
    expect(() => parseLoopbackRedirectUri("not a url")).toThrow();
  });
});

describe("parseLoopbackCallback", () => {
  it("returns the code of a matching callback", () => {
    expect(callback(`/callback?code=abc123&state=${STATE}`)).toBe("abc123");
  });

  it("requires the exact callback path", () => {
    expect(() => callback(`/callback/extra?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`//callback?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`/callback?code=abc&state=${STATE}&path=/callback`)).not.toThrow();
    expect(() => callback(`/other?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`/callback?code=abc&state=${STATE}`, "http://127.0.0.1:53124/other")).toThrow();
  });

  it("requires the state this attempt created", () => {
    expect(() => callback(`/callback?code=abc&state=other`)).toThrow();
    expect(() => callback(`/callback?code=abc`)).toThrow();
    expect(() => callback(`/callback?code=abc&state=`)).toThrow();
  });

  it("refuses a callback that did not arrive on this listener", () => {
    expect(() => callback(`http://evil.example/callback?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`//evil.example/callback?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`http://127.0.0.1:53125/callback?code=abc&state=${STATE}`)).toThrow();
    expect(() => callback(`backup/callback?code=abc&state=${STATE}`)).toThrow();
  });

  it("requires a code and reports a refusal", () => {
    expect(() => callback(`/callback?state=${STATE}`)).toThrow();
    expect(() => callback(`/callback?code=&state=${STATE}`)).toThrow();
    expect(() => callback(`/callback?error=access_denied&state=${STATE}`)).toThrow(/access_denied/);
  });
});
