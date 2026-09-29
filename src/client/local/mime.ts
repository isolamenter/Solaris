/**
 * Image MIME and file extension mapping.
 *
 * The set is closed and matches the Server's provider allowlist
 * (`src/server/providers/geminiAdapter.ts`): a saved file can only ever carry an
 * extension from this table, so a hostile `mimeType` from a Server response
 * cannot choose a path or an executable extension.
 */

/** Extension used for each accepted image MIME type. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** MIME types the desktop client will write to and read from disk. */
export const IMAGE_MIME_TYPES: readonly string[] = Object.keys(EXTENSIONS);

/** Extensions the native file picker offers for reference images. */
export const IMAGE_FILE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** Extension for an accepted image MIME type; anything else is refused. */
export function extensionForImageMime(mimeType: string): string {
  const extension = EXTENSIONS[mimeType];
  if (extension === undefined) {
    throw new Error(`The desktop client cannot save ${JSON.stringify(mimeType)} to disk`);
  }
  return extension;
}

/** MIME type for a saved or reference file, derived from its own extension. */
export function mimeForImageFile(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      throw new Error(`The desktop client does not recognise the image file ${JSON.stringify(filePath)}`);
  }
}
