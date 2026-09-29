import { beforeEach, describe, expect, it } from "vitest";
import { createServerSettings, developmentServerOrigin, isDesktopShell, serverOriginKey, type KeyValueStore } from "./settings.js";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

describe("Server address setting", () => {
  let storage: KeyValueStore;
  let settings: ReturnType<typeof createServerSettings>;

  beforeEach(() => {
    storage = memoryStore();
    settings = createServerSettings(storage);
  });

  it("has no address until one is stored", () => {
    expect(settings.read()).toBeNull();
  });

  it("stores the normalized origin, so a scope key cannot disagree with it", () => {
    settings.write("HTTPS://Example.COM:443/");

    expect(storage.getItem(serverOriginKey)).toBe("https://example.com");
    expect(settings.read()).toBe("https://example.com");
  });

  it("keeps an explicit non-default port and drops a trailing slash", () => {
    settings.write("http://127.0.0.1:3210/");

    expect(settings.read()).toBe("http://127.0.0.1:3210");
  });

  it("refuses anything that is not an absolute http(s) Server origin", () => {
    for (const value of ["/api", "127.0.0.1:3210", "file:///tmp", "https://user:pass@example.com", "https://example.com/path"]) {
      expect(() => settings.write(value), value).toThrow();
    }
    expect(settings.read()).toBeNull();
  });

  it("reports a stored address it can no longer use instead of guessing one", () => {
    storage.setItem(serverOriginKey, "not-an-origin");

    expect(() => settings.read()).toThrow(/absolute/);
  });

  it("forgets the address on clear", () => {
    settings.write("https://solaris.example.com");

    settings.clear();

    expect(settings.read()).toBeNull();
  });
});

describe("the build's own default address", () => {
  it("is the page origin in a browser build, because the Server serves it", () => {
    expect(developmentServerOrigin("http://127.0.0.1:3210/", false)).toBe("http://127.0.0.1:3210");
  });

  it("does not exist in the desktop shell, whose page is not a Server", () => {
    expect(developmentServerOrigin("http://127.0.0.1:3210/", true)).toBeNull();
  });

  it("does not exist when the page origin is not an http(s) Server origin", () => {
    expect(developmentServerOrigin("tauri://localhost", false)).toBeNull();
  });

  it("is detected from the shell's own injected object", () => {
    expect(isDesktopShell({})).toBe(false);
    expect(isDesktopShell({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});
