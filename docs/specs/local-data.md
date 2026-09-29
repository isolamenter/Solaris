# Device-local records and image saving

## Goal

Keep drafts, selected reference files and generated images under device control while keeping remote run history independent from local file availability.

## Behavior and rules

- The desktop explicitly selects a Server origin. Local draft and run records are scoped by normalized Server origin plus Solaris user ID, so accounts and Servers do not mix data.
- Session documents are stored in the OS secure store per Server origin. Draft and run records are scoped JSON files, not a local SQLite database. The Server address itself is a non-secret setting.
- Native dialogs grant access to chosen reference files and an output directory. Remote responses cannot choose arbitrary local paths. Native record paths validate scope, kind and record ID.
- Reference records hold paths, MIME, sizes and digests. Exact bytes are read for submission and held in memory for that run; Client transport retries must reuse the original input.
- Image writes use a temporary file and atomic rename. A successful write must finish before the Client records `saved`. Canceling directory selection does not indicate a saved file.
- Local image states are `unsaved`, `saved` and `missing`. A deleted/moved file may become missing on this device without changing remote generation success. Revealing/reading saved images stays within the scope's native file grants.
- A successful remote history entry does not promise a file on this or another device. There is no Server asset sync or durable download endpoint. Retrying a local save can reuse image bytes still held by the Client; otherwise image retrieval is subject to the generation replay cache.

## Boundary and evidence

[local.ts](../../src/shared/local.ts) defines `LocalStore` and `DesktopLogin`. [client/local/](../../src/client/local/) implements TypeScript rules against `LocalBackend`; [tauriBackend.ts](../../src/client/local/tauriBackend.ts) is the native bridge. [src-tauri/src/](../../src-tauri/src/) implements secure storage, loopback login, dialogs, scoped records and image writes.

The native `keyring` dependency must retain the platform store feature (`apple-native` / `windows-native`), never its in-memory mock. Bundle targets currently cover macOS; Linux has no native-store dependency.

Local-layer unit tests use a fake device backend and Rust module tests cover selected filesystem rules. These do not establish OS dialogs, Keychain behavior, packaged-app login or cross-platform acceptance.
