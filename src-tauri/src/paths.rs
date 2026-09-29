//! Validation and containment helpers.
//!
//! Every function here is pure (filesystem reads only where named) and free of
//! Tauri types, so `cargo test` runs them on the real toolchain. This module is
//! where the native security boundary lives: a scope key, a record id and a file
//! name that reach the filesystem have all passed through it.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Directory name prefix produced by the client (`localScopeKey`).
pub const SCOPE_PREFIX: &str = "s-";
/// Hex characters of the SHA-256 scope digest.
pub const SCOPE_DIGEST_CHARS: usize = 64;
/// Longest accepted device file name, in bytes.
pub const MAX_FILE_NAME: usize = 160;
/// Longest accepted record id, in bytes.
pub const MAX_RECORD_ID: usize = 128;
/// Longest accepted server origin, in bytes.
pub const MAX_SERVER_ORIGIN: usize = 512;
/// Refuse to materialise a single image larger than this after decoding.
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Refuse to decode a base64 payload larger than this before decoding.
pub const MAX_IMAGE_BASE64_BYTES: usize = 96 * 1024 * 1024;

/// Record kinds the store exposes. A closed set, never a path fragment.
pub fn is_record_kind(value: &str) -> bool {
    matches!(value, "drafts" | "runs")
}

/// Client scope key: `s-` followed by 64 lowercase hex characters.
pub fn is_scope_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == SCOPE_PREFIX.len() + SCOPE_DIGEST_CHARS
        && bytes.starts_with(SCOPE_PREFIX.as_bytes())
        && bytes[SCOPE_PREFIX.len()..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// Record id: no separators, no traversal, never dot-prefixed.
///
/// Callers must reject rather than rewrite an id: silently rewriting `a/b` into
/// `a_b` would let two different ids collide on one record.
pub fn is_record_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_RECORD_ID
        && bytes[0] != b'.'
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_' || *b == b'.')
}

/// Server origin accepted by the secure store. The origin is only used as a
/// keychain account suffix, but it is still validated and length-bounded.
pub fn is_server_origin(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SERVER_ORIGIN
        && (value.starts_with("http://") || value.starts_with("https://"))
        && value
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
}

/// Device-chosen image file name: `solaris-<millis>-<uuid>.<png|jpg|webp>`.
///
/// The name is minted on the device from the client's own random source; no part
/// of it comes from a Server response. Returns the extension when the name is
/// well formed.
pub fn parse_image_file_name(value: &str) -> Option<&str> {
    if value.len() > MAX_FILE_NAME {
        return None;
    }
    let (stem, extension) = value.rsplit_once('.')?;
    if !matches!(extension, "png" | "jpg" | "webp") {
        return None;
    }
    let rest = stem.strip_prefix("solaris-")?;
    let (millis, unique) = rest.split_once('-')?;
    if millis.is_empty() || millis.len() > 16 || !millis.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !is_uuid(unique) {
        return None;
    }
    Some(extension)
}

/// Relative path of one record inside the scoped store.
pub fn record_relative_path(
    scope_key: &str,
    kind: &str,
    record_id: &str,
) -> Option<PathBuf> {
    if !is_scope_key(scope_key) || !is_record_kind(kind) || !is_record_id(record_id) {
        return None;
    }
    Some(PathBuf::from("scopes").join(scope_key).join(kind).join(format!("{record_id}.json")))
}

/// Filesystem location of the scope's default image directory.
pub fn scope_image_dir(base: &Path, scope_key: &str) -> Option<PathBuf> {
    if !is_scope_key(scope_key) {
        return None;
    }
    Some(base.join("images").join(scope_key))
}

/// True when `candidate` resolves to a path inside `root`.
///
/// Both sides are canonicalised, so a symlink placed in a shared directory
/// cannot be used to read outside the root.
pub fn resolves_within(root: &Path, candidate: &Path) -> bool {
    match (root.canonicalize(), candidate.canonicalize()) {
        (Ok(root), Ok(candidate)) => candidate.starts_with(root),
        _ => false,
    }
}

/// True when `candidate` does not exist yet but its parent directory is `root`,
/// which is the situation when a new image is about to be written.
pub fn creates_inside(root: &Path, candidate: &Path) -> bool {
    let Some(parent) = candidate.parent() else {
        return false;
    };
    match (root.canonicalize(), parent.canonicalize()) {
        (Ok(root), Ok(parent)) => parent == root,
        _ => false,
    }
}

/// Scratch name used while an image is being written. Never matches
/// [`parse_image_file_name`], so a partially written file is never reported as a
/// saved image.
pub fn part_file_name(file_name: &str) -> String {
    format!(".{file_name}.part")
}

/// Write `bytes` to `target` through a sibling scratch file and an atomic
/// rename.
///
/// A crash, a full disk or a permission failure leaves the previous content (or
/// nothing) in place; the scratch file is removed on the error path. Only after
/// this returns is the caller allowed to record the image as saved.
pub fn commit_bytes_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let Some(parent) = target.parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target path has no parent directory",
        ));
    };
    let Some(file_name) = target.file_name().and_then(|name| name.to_str()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target path has no usable file name",
        ));
    };
    let scratch = parent.join(part_file_name(file_name));
    let outcome = (|| -> io::Result<()> {
        let mut file = std::fs::File::create(&scratch)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&scratch, target)
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&scratch);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solaris-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn scope_keys_are_strict() {
        let valid = format!("s-{}", "a1".repeat(32));
        assert!(is_scope_key(&valid));

        assert!(!is_scope_key(""));
        assert!(!is_scope_key("s-"));
        assert!(!is_scope_key(&format!("s-{}", "a1".repeat(31))));
        assert!(!is_scope_key(&format!("s-{}", "A1".repeat(32))));
        assert!(!is_scope_key(&format!("s-{}", "zz".repeat(32))));
        assert!(!is_scope_key(&format!("x-{}", "a1".repeat(32))));
        // 64 hex characters only: a length match with other characters is not one.
        assert!(!is_scope_key(&format!("s-{}", "a1".repeat(33))));
    }

    #[test]
    fn record_ids_reject_traversal_and_separators() {
        assert!(is_record_id("0f2a1c4e-0000-4000-8000-000000000001"));
        assert!(is_record_id("draft_1"));
        assert!(!is_record_id(""));
        assert!(!is_record_id("."));
        assert!(!is_record_id(".."));
        assert!(!is_record_id(".hidden"));
        assert!(!is_record_id("../escape"));
        assert!(!is_record_id("a/b"));
        assert!(!is_record_id("a\\b"));
        assert!(!is_record_id("a\0b"));
        assert!(!is_record_id(&"a".repeat(MAX_RECORD_ID + 1)));
    }

    #[test]
    fn image_file_names_are_device_shaped() {
        let name = "solaris-1758758400000-0f2a1c4e-0000-4000-8000-000000000001.png";
        assert_eq!(parse_image_file_name(name), Some("png"));

        // A remote value can never be a file name.
        assert!(parse_image_file_name("../../etc/passwd").is_none());
        assert!(parse_image_file_name("solaris-1-0f2a1c4e-0000-4000-8000-000000000001.exe").is_none());
        assert!(parse_image_file_name("solaris-1-0f2a1c4e-0000-4000-8000-000000000001").is_none());
        assert!(parse_image_file_name("solaris-x-0f2a1c4e-0000-4000-8000-000000000001.png").is_none());
        assert!(parse_image_file_name("solaris-1-not-a-uuid.png").is_none());
        assert!(parse_image_file_name("solaris-1-0F2A1C4E-0000-4000-8000-000000000001.png").is_none());
        // A second dot cannot smuggle another extension.
        assert!(parse_image_file_name("solaris-1-0f2a1c4e-0000-4000-8000-000000000001.png.exe").is_none());
        assert!(parse_image_file_name(&format!("solaris-1-{}.png", "a".repeat(40))).is_none());
    }

    #[test]
    fn part_files_are_never_image_names() {
        let name = "solaris-1-0f2a1c4e-0000-4000-8000-000000000001.png";
        assert!(parse_image_file_name(&part_file_name(name)).is_none());
    }

    #[test]
    fn record_paths_stay_under_the_scope() {
        let scope = format!("s-{}", "0".repeat(64));
        let path = record_relative_path(&scope, "drafts", "abc").expect("path");
        assert_eq!(path, PathBuf::from(format!("scopes/{scope}/drafts/abc.json")));

        assert!(record_relative_path(&scope, "..", "abc").is_none());
        assert!(record_relative_path(&scope, "drafts", "../abc").is_none());
        assert!(record_relative_path("s-nope", "drafts", "abc").is_none());
    }

    #[test]
    fn containment_follows_components_not_text() {
        let root = scratch_dir("contain");
        let inside = root.join("images");
        std::fs::create_dir_all(&inside).expect("images dir");
        let file = inside.join("a.png");
        std::fs::write(&file, b"x").expect("write");

        let sibling = root.join("images-other");
        std::fs::create_dir_all(&sibling).expect("sibling dir");
        let other = sibling.join("a.png");
        std::fs::write(&other, b"x").expect("write");

        assert!(resolves_within(&inside, &file));
        assert!(!resolves_within(&inside, &other));
        assert!(!resolves_within(&inside, &root));
        assert!(creates_inside(&inside, &inside.join("new.png")));
        assert!(!creates_inside(&inside, &other));
    }

    #[test]
    fn atomic_commit_leaves_no_scratch_file() {
        let dir = scratch_dir("commit");
        let target = dir.join("solaris-1-0f2a1c4e-0000-4000-8000-000000000001.png");

        commit_bytes_atomic(&target, b"first").expect("first commit");
        assert_eq!(std::fs::read(&target).expect("read"), b"first");

        commit_bytes_atomic(&target, b"second").expect("second commit");
        assert_eq!(std::fs::read(&target).expect("read"), b"second");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "scratch files left behind: {leftovers:?}");
    }

    #[test]
    fn failed_commit_leaves_no_file_behind() {
        let dir = scratch_dir("commit-fail");
        let missing = dir.join("does-not-exist");
        let target = missing.join("solaris-1-0f2a1c4e-0000-4000-8000-000000000001.png");

        assert!(commit_bytes_atomic(&target, b"data").is_err());
        assert!(!target.exists());
        assert!(!missing.exists());
    }
}
