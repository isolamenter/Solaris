/**
 * Device-chosen image file names.
 *
 * `saveImage` accepts only a run id and an index from the caller: the name is
 * minted here from the device's own clock and random source. The remote run id
 * never reaches a file name, so a crafted response cannot choose a path, escape
 * the save directory or overwrite another file. The native layer validates the
 * same shape again before it writes.
 */

import { extensionForImageMime } from "./mime.js";

const FILE_NAME_PATTERN = /^solaris-\d{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/;

/**
 * File name for one saved image: `solaris-<millis>-<uuid>.<extension>`.
 *
 * `unique` is injectable so the shape is testable; production callers leave it
 * to `crypto.randomUUID`.
 */
export function createImageFileName(input: { mimeType: string; unique?: string; now?: number }): string {
  const extension = extensionForImageMime(input.mimeType);
  const unique = input.unique ?? crypto.randomUUID();
  const millis = input.now ?? Date.now();
  const name = `solaris-${millis}-${unique}.${extension}`;
  if (!FILE_NAME_PATTERN.test(name)) {
    throw new Error(`Refusing to create an image file name outside the device pattern: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Whether a name is one this device could have produced. */
export function isImageFileName(value: string): boolean {
  return FILE_NAME_PATTERN.test(value);
}
