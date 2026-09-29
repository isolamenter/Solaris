//! Scoped record store.
//!
//! One JSON document per record under
//! `<data-root>/scopes/<scope-key>/<kind>/<record-id>.json`. The scope key and
//! the record id are validated by [`crate::paths`] before they ever reach the
//! filesystem, so the client cannot address another scope's records and cannot
//! leave the store root.

use std::io;
use std::path::{Path, PathBuf};

use crate::paths;

/// Absolute path of one record, or `None` when any component is invalid.
pub fn record_path(root: &Path, scope_key: &str, kind: &str, record_id: &str) -> Option<PathBuf> {
    paths::record_relative_path(scope_key, kind, record_id).map(|relative| root.join(relative))
}

fn scope_dir(root: &Path, scope_key: &str, kind: &str) -> Option<PathBuf> {
    if !paths::is_scope_key(scope_key) || !paths::is_record_kind(kind) {
        return None;
    }
    Some(root.join("scopes").join(scope_key).join(kind))
}

/// Every document of one scope and kind. A missing directory is an empty scope,
/// not an error.
pub fn list(root: &Path, scope_key: &str, kind: &str) -> io::Result<Vec<String>> {
    let Some(dir) = scope_dir(root, scope_key, kind) else {
        return Err(invalid("scope key or record kind"));
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut documents = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        documents.push(std::fs::read_to_string(&path)?);
    }
    documents.sort();
    Ok(documents)
}

/// One document, or `None` when the record does not exist.
pub fn read(root: &Path, scope_key: &str, kind: &str, record_id: &str) -> io::Result<Option<String>> {
    let Some(path) = record_path(root, scope_key, kind, record_id) else {
        return Err(invalid("scope key, record kind or record id"));
    };
    match std::fs::read_to_string(&path) {
        Ok(document) => Ok(Some(document)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Replace one document. The write goes through a scratch file and a rename, so
/// a record is never observed half written.
pub fn write(root: &Path, scope_key: &str, kind: &str, record_id: &str, document: &str) -> io::Result<()> {
    let Some(path) = record_path(root, scope_key, kind, record_id) else {
        return Err(invalid("scope key, record kind or record id"));
    };
    let Some(parent) = path.parent() else {
        return Err(invalid("record path"));
    };
    std::fs::create_dir_all(parent)?;
    paths::commit_bytes_atomic(&path, document.as_bytes())
}

/// Remove one document. Removing a missing record succeeds: the caller's intent
/// is that the record must not exist afterwards.
pub fn delete(root: &Path, scope_key: &str, kind: &str, record_id: &str) -> io::Result<()> {
    let Some(path) = record_path(root, scope_key, kind, record_id) else {
        return Err(invalid("scope key, record kind or record id"));
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("invalid {what}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solaris-records-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn scope(byte: char) -> String {
        format!("s-{}", byte.to_string().repeat(64))
    }

    #[test]
    fn records_round_trip() {
        let root = scratch_dir("round-trip");
        let scope = scope('a');
        assert_eq!(list(&root, &scope, "drafts").expect("list"), Vec::<String>::new());

        write(&root, &scope, "drafts", "one", "{\"id\":\"one\"}").expect("write");
        write(&root, &scope, "drafts", "two", "{\"id\":\"two\"}").expect("write");

        let mut documents = list(&root, &scope, "drafts").expect("list");
        documents.sort();
        assert_eq!(documents, vec!["{\"id\":\"one\"}".to_string(), "{\"id\":\"two\"}".to_string()]);
        assert_eq!(read(&root, &scope, "drafts", "one").expect("read"), Some("{\"id\":\"one\"}".to_string()));
        assert_eq!(read(&root, &scope, "drafts", "absent").expect("read"), None);

        delete(&root, &scope, "drafts", "one").expect("delete");
        delete(&root, &scope, "drafts", "one").expect("delete is idempotent");
        assert_eq!(read(&root, &scope, "drafts", "one").expect("read"), None);
        assert_eq!(list(&root, &scope, "drafts").expect("list"), vec!["{\"id\":\"two\"}".to_string()]);
    }

    #[test]
    fn scopes_are_separate_directories() {
        let root = scratch_dir("scopes");
        let first = scope('a');
        let second = scope('b');

        write(&root, &first, "runs", "shared-id", "{\"owner\":\"first\"}").expect("write");
        write(&root, &second, "runs", "shared-id", "{\"owner\":\"second\"}").expect("write");

        assert_eq!(read(&root, &first, "runs", "shared-id").expect("read"), Some("{\"owner\":\"first\"}".to_string()));
        assert_eq!(read(&root, &second, "runs", "shared-id").expect("read"), Some("{\"owner\":\"second\"}".to_string()));

        delete(&root, &first, "runs", "shared-id").expect("delete");
        assert_eq!(read(&root, &first, "runs", "shared-id").expect("read"), None);
        assert_eq!(read(&root, &second, "runs", "shared-id").expect("read"), Some("{\"owner\":\"second\"}".to_string()));
    }

    #[test]
    fn invalid_components_are_rejected() {
        let root = scratch_dir("invalid");
        let scope = scope('a');

        assert!(write(&root, &scope, "drafts", "../escape", "{}").is_err());
        assert!(write(&root, &scope, "../escape", "id", "{}").is_err());
        assert!(write(&root, &scope, "secrets", "id", "{}").is_err());
        assert!(write(&root, "s-short", "drafts", "id", "{}").is_err());
        assert!(read(&root, &scope, "drafts", "..").is_err());

        // Nothing was created outside the scope.
        assert!(!root.join("escape").exists());
        assert!(!root.join("drafts").exists());
    }
}
