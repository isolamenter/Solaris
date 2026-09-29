//! The OS secure store (macOS Keychain).
//!
//! Only the active session document of a Server is kept here. Exactly one entry
//! per normalized Server origin, so `write` replaces the previous token for that
//! Server and `clear` removes it; another Server's entry is untouched. No token
//! is ever written to SQLite, to a JSON record or to a log.

use keyring::{Entry, Error as KeyringError};

use crate::paths;

/// Keychain service name of the application.
const SERVICE: &str = "com.solaris.desktop";
/// Account prefix; the remainder identifies the Server.
const ACCOUNT_PREFIX: &str = "session:";

/// Keychain account for a normalized Server origin.
pub fn account_for(server_origin: &str) -> Option<String> {
    if !paths::is_server_origin(server_origin) {
        return None;
    }
    Some(format!("{ACCOUNT_PREFIX}{server_origin}"))
}

fn entry(server_origin: &str) -> Result<Entry, String> {
    let account = account_for(server_origin)
        .ok_or_else(|| "the server origin is not a valid http(s) origin".to_string())?;
    Entry::new(SERVICE, &account).map_err(|error| describe(&error))
}

/// Stored session document, or `None` when this Server has no active session.
pub fn read(server_origin: &str) -> Result<Option<String>, String> {
    match entry(server_origin)?.get_password() {
        Ok(document) => Ok(Some(document)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(describe(&error)),
    }
}

/// Replace the stored session document for this Server.
pub fn write(server_origin: &str, document: &str) -> Result<(), String> {
    entry(server_origin)?.set_password(document).map_err(|error| describe(&error))
}

/// Remove the stored session. Clearing an absent entry succeeds: the caller's
/// intent is that no session remains for this Server.
pub fn clear(server_origin: &str) -> Result<(), String> {
    match entry(server_origin)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(describe(&error)),
    }
}

fn describe(error: &KeyringError) -> String {
    format!("the OS secure store refused the operation: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_per_server_and_validated() {
        assert_eq!(
            account_for("http://127.0.0.1:3210").as_deref(),
            Some("session:http://127.0.0.1:3210")
        );
        assert_eq!(account_for("https://a.example").as_deref(), Some("session:https://a.example"));
        // Two servers never share an account.
        assert_ne!(account_for("https://a.example"), account_for("https://b.example"));
        assert_eq!(account_for("localhost:3210"), None);
        assert_eq!(account_for(""), None);
        assert_eq!(account_for("file:///etc/passwd"), None);
    }

    /// Real Keychain round trip. Ignored by default because it needs a logged-in
    /// session and an unlocked login keychain; run with
    /// `cargo test -- --ignored` on a device to verify the native path.
    #[test]
    #[ignore = "requires an unlocked macOS login keychain"]
    fn keychain_round_trip() {
        let origin = "http://127.0.0.1:3210";
        clear(origin).expect("clear");
        assert_eq!(read(origin).expect("read"), None);

        write(origin, "{\"token\":\"first\"}").expect("write");
        assert_eq!(read(origin).expect("read").as_deref(), Some("{\"token\":\"first\"}"));

        write(origin, "{\"token\":\"second\"}").expect("replace");
        assert_eq!(read(origin).expect("read").as_deref(), Some("{\"token\":\"second\"}"));

        clear(origin).expect("clear");
        assert_eq!(read(origin).expect("read"), None);
        clear(origin).expect("clearing twice is fine");
    }
}
