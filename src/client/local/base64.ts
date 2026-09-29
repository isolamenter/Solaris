/**
 * Strict base64 for the native boundary.
 *
 * The native side encodes and decodes with the standard alphabet and padding.
 * Input is validated before it is decoded so a malformed payload fails with a
 * clear message instead of a platform-specific one.
 */

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error("The image payload is not valid base64");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
