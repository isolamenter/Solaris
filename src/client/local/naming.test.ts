import { describe, expect, it } from "vitest";
import { extensionForImageMime, IMAGE_MIME_TYPES, mimeForImageFile } from "./mime.js";
import { createImageFileName, isImageFileName } from "./naming.js";

describe("mime mapping", () => {
  it("saves only the types the pipeline produces", () => {
    expect(IMAGE_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(extensionForImageMime("image/png")).toBe("png");
    expect(extensionForImageMime("image/jpeg")).toBe("jpg");
    expect(extensionForImageMime("image/webp")).toBe("webp");
  });

  it("refuses a MIME type it cannot name a file after", () => {
    for (const mimeType of ["image/gif", "text/html", "image/png; charset=utf-8", "../../png", ""]) {
      expect(() => extensionForImageMime(mimeType)).toThrow();
    }
  });

  it("reads back only extensions it writes", () => {
    expect(mimeForImageFile("/tmp/solaris/a.png")).toBe("image/png");
    expect(mimeForImageFile("C:\\Users\\a\\b.JPEG")).toBe("image/jpeg");
    expect(mimeForImageFile("b.webp")).toBe("image/webp");
    for (const path of ["a.gif", "a", "a.png.exe", "/tmp/a"]) {
      expect(() => mimeForImageFile(path)).toThrow();
    }
  });
});

describe("createImageFileName", () => {
  it("mints a device name from the device's own values", () => {
    const name = createImageFileName({
      mimeType: "image/png",
      unique: "0f2a1c4e-0000-4000-8000-000000000001",
      now: 1758758400000,
    });
    expect(name).toBe("solaris-1758758400000-0f2a1c4e-0000-4000-8000-000000000001.png");
    expect(isImageFileName(name)).toBe(true);
  });

  it("uses a fresh random value by default", () => {
    const first = createImageFileName({ mimeType: "image/webp" });
    const second = createImageFileName({ mimeType: "image/webp" });
    expect(first).not.toBe(second);
    expect(isImageFileName(first)).toBe(true);
    expect(isImageFileName(second)).toBe(true);
  });

  it("cannot be steered by a remote value", () => {
    // The extension comes from the MIME allowlist, so a hostile MIME type is
    // refused rather than carried into the name.
    expect(() => createImageFileName({ mimeType: "../escape.png" })).toThrow();
    expect(() => createImageFileName({ mimeType: "image/png/../../../etc/passwd" })).toThrow();

    // A separator, a traversal or another extension cannot be produced.
    const name = createImageFileName({ mimeType: "image/jpeg", unique: "0f2a1c4e-0000-4000-8000-000000000001" });
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
    expect(name.endsWith(".jpg")).toBe(true);

    for (const hostile of ["../../etc/passwd", "solaris-1-nope.png", "a.png", ".hidden.png", "solaris-1-0f2a1c4e-0000-4000-8000-000000000001.exe"]) {
      expect(isImageFileName(hostile)).toBe(false);
    }
  });
});
