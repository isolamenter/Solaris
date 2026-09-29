//! Solaris desktop shell.
//!
//! The Rust side carries only what needs the operating system: the loopback
//! login listener, the OS secure store, native file dialogs, the atomic image
//! write, and one scoped JSON record store. Every rule that can be expressed in
//! TypeScript lives in `src/client/local/` instead; the commands here validate
//! their inputs again because they are the last boundary before the filesystem.

mod images;
mod login;
mod paths;
mod records;
mod secrets;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Bounds for the login listener lifetime, in milliseconds.
const MIN_LOGIN_TIMEOUT_MS: u64 = 5_000;
const MAX_LOGIN_TIMEOUT_MS: u64 = 15 * 60 * 1000;
/// Longest accepted base64 image payload, before decoding.
const MAX_IMAGE_BASE64_BYTES: usize = paths::MAX_IMAGE_BASE64_BYTES;

/// Device-side authorisation state. None of it is derived from a Server
/// response; it records only what the user picked on this device.
#[derive(Debug, Default, Serialize, Deserialize)]
struct LocalConfig {
    /// Scope key to the reference files the user chose for it.
    references: HashMap<String, Vec<String>>,
    /// Scope key to the save directory the user chose for it.
    save_dirs: HashMap<String, String>,
}

struct AppState {
    root: PathBuf,
    config: Mutex<LocalConfig>,
    login: Mutex<Option<login::PendingLogin>>,
}

impl AppState {
    fn images_root(&self) -> &Path {
        &self.root
    }

    fn default_image_dir(&self, scope_key: &str) -> Result<PathBuf, String> {
        paths::scope_image_dir(self.images_root(), scope_key)
            .ok_or_else(|| "invalid scope key".to_string())
    }

    /// Directory new images are written to: the location the user chose for this
    /// scope, or the app's own per-scope directory when none was chosen.
    fn primary_image_dir(&self, scope_key: &str) -> Result<PathBuf, String> {
        let guard = self.config.lock().map_err(|_| "the local store is poisoned".to_string())?;
        match guard.save_dirs.get(scope_key) {
            Some(chosen) => Ok(PathBuf::from(chosen)),
            None => self.default_image_dir(scope_key),
        }
    }

    /// Directories this scope may read saved images from: the directory the user
    /// chose for it, plus the app's own per-scope directory.
    fn image_roots(&self, scope_key: &str) -> Result<Vec<PathBuf>, String> {
        let mut roots = vec![self.default_image_dir(scope_key)?];
        let guard = self.config.lock().map_err(|_| "the local store is poisoned".to_string())?;
        if let Some(chosen) = guard.save_dirs.get(scope_key) {
            let chosen = PathBuf::from(chosen);
            if !roots.contains(&chosen) {
                roots.push(chosen);
            }
        }
        Ok(roots)
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("local-config.json")
    }

    fn persist_config(&self, config: &LocalConfig) -> Result<(), String> {
        let document = serde_json::to_string(config).map_err(|error| error.to_string())?;
        paths::commit_bytes_atomic(&self.config_path(), document.as_bytes()).map_err(describe)
    }
}

fn describe(error: std::io::Error) -> String {
    format!("the local store failed: {error}")
}

/// Read the device-side authorisation file.
///
/// Absent means a first run and yields the empty default. Present but unreadable
/// is reported: treating it as empty would silently drop the directories and
/// files the user authorised, and images already written there would start to
/// look missing.
fn load_config(root: &Path) -> Result<LocalConfig, String> {
    let path = root.join("local-config.json");
    match std::fs::read_to_string(&path) {
        Ok(document) => serde_json::from_str(&document)
            .map_err(|error| format!("{} is not a readable configuration: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LocalConfig::default()),
        Err(error) => Err(format!("{} could not be read: {error}", path.display())),
    }
}

/// Run a dialog on the main thread, where macOS requires a file panel to live,
/// without blocking the async runtime.
async fn on_main_thread<T, F>(app: &tauri::AppHandle, work: F) -> Result<Option<T>, String>
where
    T: Send + 'static,
    F: FnOnce() -> Option<T> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(work());
    })
    .map_err(|error| format!("the desktop shell could not show a file dialog: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|error| format!("the file dialog did not answer: {error}"))
}

fn image_filter() -> rfd::FileDialog {
    rfd::FileDialog::new().add_filter("Images", &["png", "jpg", "jpeg", "webp"])
}

// -- protocol shapes shared with `src/client/local/` -------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedirectUri {
    redirect_uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginCallback {
    request_target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePayload {
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    file_path: String,
    byte_size: u64,
}

fn validate_scope(scope_key: &str) -> Result<(), String> {
    if paths::is_scope_key(scope_key) {
        Ok(())
    } else {
        Err("invalid scope key".to_string())
    }
}

// -- desktop login (CONTRACTS §2.3) ------------------------------------------

#[tauri::command]
fn login_begin(state: State<'_, AppState>, timeout_ms: u64) -> Result<RedirectUri, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(MIN_LOGIN_TIMEOUT_MS, MAX_LOGIN_TIMEOUT_MS));
    let mut guard = state.login.lock().map_err(|_| "the login listener is poisoned".to_string())?;
    if let Some(previous) = guard.take() {
        // A second attempt replaces the first: one listener, one port.
        previous.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let pending = login::bind_loopback(timeout).map_err(|error| error.to_string())?;
    let redirect_uri = login::redirect_uri(pending.port);
    *guard = Some(pending);
    Ok(RedirectUri { redirect_uri })
}

#[tauri::command]
async fn login_await(state: State<'_, AppState>) -> Result<LoginCallback, String> {
    let (listener, stop, deadline) = {
        let guard = state.login.lock().map_err(|_| "the login listener is poisoned".to_string())?;
        let Some(pending) = guard.as_ref() else {
            return Err("no desktop login is in progress".to_string());
        };
        (
            login::cloned_listener(pending).map_err(|error| error.to_string())?,
            pending.stop.clone(),
            pending.deadline,
        )
    };

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        login::wait_for_target(&listener, &stop, deadline)
    })
    .await
    .map_err(|error| format!("the login listener stopped unexpectedly: {error}"))?;

    // One callback per attempt: the listener is closed whether it answered or not.
    if let Ok(mut guard) = state.login.lock() {
        *guard = None;
    }
    outcome
        .map(|request_target| LoginCallback { request_target })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.login.lock().map_err(|_| "the login listener is poisoned".to_string())?;
    if let Some(pending) = guard.take() {
        pending.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    login::open_in_browser(&url).map_err(|error| error.to_string())
}

// -- session secure store (§10) ----------------------------------------------

#[tauri::command]
fn secrets_read(server_origin: String) -> Result<Option<String>, String> {
    secrets::read(&server_origin)
}

#[tauri::command]
fn secrets_write(server_origin: String, document: String) -> Result<(), String> {
    secrets::write(&server_origin, &document)
}

#[tauri::command]
fn secrets_clear(server_origin: String) -> Result<(), String> {
    secrets::clear(&server_origin)
}

// -- scoped records (§10) ----------------------------------------------------

#[tauri::command]
fn records_list(state: State<'_, AppState>, kind: String, scope_key: String) -> Result<Vec<String>, String> {
    records::list(&state.root, &scope_key, &kind).map_err(describe)
}

#[tauri::command]
fn records_read(
    state: State<'_, AppState>,
    kind: String,
    scope_key: String,
    record_id: String,
) -> Result<Option<String>, String> {
    records::read(&state.root, &scope_key, &kind, &record_id).map_err(describe)
}

#[tauri::command]
fn records_write(
    state: State<'_, AppState>,
    kind: String,
    scope_key: String,
    record_id: String,
    document: String,
) -> Result<(), String> {
    records::write(&state.root, &scope_key, &kind, &record_id, &document).map_err(describe)
}

#[tauri::command]
fn records_delete(
    state: State<'_, AppState>,
    kind: String,
    scope_key: String,
    record_id: String,
) -> Result<(), String> {
    records::delete(&state.root, &scope_key, &kind, &record_id).map_err(describe)
}

// -- files (§10) -------------------------------------------------------------

#[tauri::command]
async fn choose_reference_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope_key: String,
) -> Result<Vec<String>, String> {
    validate_scope(&scope_key)?;
    let picked = on_main_thread(&app, || image_filter().pick_files()).await?;
    let Some(picked) = picked else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for path in picked {
        // Store the resolved path: the authorisation check compares canonical
        // paths, so a later symlink swap cannot redirect the read.
        let Ok(resolved) = path.canonicalize() else {
            continue;
        };
        if !resolved.is_file() {
            continue;
        }
        paths.push(resolved.to_string_lossy().into_owned());
    }
    if paths.is_empty() {
        return Ok(paths);
    }
    let mut config = state.config.lock().map_err(|_| "the local store is poisoned".to_string())?;
    let allowed = config.references.entry(scope_key).or_default();
    for path in &paths {
        if !allowed.contains(path) {
            allowed.push(path.clone());
        }
    }
    state.persist_config(&config)?;
    Ok(paths)
}

#[tauri::command]
fn read_reference_file(
    state: State<'_, AppState>,
    scope_key: String,
    file_path: String,
) -> Result<FilePayload, String> {
    validate_scope(&scope_key)?;
    let requested = PathBuf::from(&file_path);
    let allowed = {
        let config = state.config.lock().map_err(|_| "the local store is poisoned".to_string())?;
        config.references.get(&scope_key).cloned().unwrap_or_default()
    };
    let resolved = requested
        .canonicalize()
        .map_err(|_| "the reference file is not available".to_string())?;
    if !allowed.iter().any(|candidate| Path::new(candidate) == resolved) {
        return Err("that file was not chosen for this account on this device".to_string());
    }
    let bytes = read_bounded(&resolved)?;
    Ok(FilePayload {
        data_base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
async fn choose_save_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope_key: String,
) -> Result<Option<String>, String> {
    validate_scope(&scope_key)?;
    let picked = on_main_thread(&app, || rfd::FileDialog::new().pick_folder()).await?;
    let Some(directory) = picked else {
        return Ok(None);
    };
    let resolved = directory
        .canonicalize()
        .map_err(|_| "that directory is not available".to_string())?;
    if !resolved.is_dir() {
        return Err("the chosen save location is not a directory".to_string());
    }
    let path = resolved.to_string_lossy().into_owned();
    let mut config = state.config.lock().map_err(|_| "the local store is poisoned".to_string())?;
    config.save_dirs.insert(scope_key, path.clone());
    state.persist_config(&config)?;
    Ok(Some(path))
}

#[tauri::command]
fn save_image(
    state: State<'_, AppState>,
    scope_key: String,
    file_name: String,
    data_base64: String,
) -> Result<SavedImage, String> {
    validate_scope(&scope_key)?;
    if data_base64.len() > MAX_IMAGE_BASE64_BYTES {
        return Err("the image payload is too large".to_string());
    }
    let bytes = BASE64
        .decode(data_base64.as_bytes())
        .map_err(|_| "the image payload is not valid base64".to_string())?;
    let directory = state.primary_image_dir(&scope_key)?;
    let (path, byte_size) = images::save_image(&directory, &file_name, &bytes).map_err(describe)?;
    Ok(SavedImage {
        file_path: path.to_string_lossy().into_owned(),
        byte_size: byte_size as u64,
    })
}

#[tauri::command]
fn image_exists(state: State<'_, AppState>, scope_key: String, file_path: String) -> Result<bool, String> {
    validate_scope(&scope_key)?;
    let roots = state.image_roots(&scope_key)?;
    Ok(images::image_exists(&roots, Path::new(&file_path)))
}

#[tauri::command]
fn read_saved_image(
    state: State<'_, AppState>,
    scope_key: String,
    file_path: String,
) -> Result<FilePayload, String> {
    validate_scope(&scope_key)?;
    let roots = state.image_roots(&scope_key)?;
    let bytes = images::read_image(&roots, Path::new(&file_path)).map_err(describe)?;
    Ok(FilePayload {
        data_base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
fn reveal_in_file_manager(
    state: State<'_, AppState>,
    scope_key: String,
    file_path: String,
) -> Result<(), String> {
    validate_scope(&scope_key)?;
    let roots = state.image_roots(&scope_key)?;
    images::reveal(&roots, Path::new(&file_path)).map_err(describe)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "the file is not available".to_string())?;
    if !metadata.is_file() {
        return Err("the path is not a file".to_string());
    }
    if metadata.len() > paths::MAX_IMAGE_BYTES as u64 {
        return Err("the file is too large for this client".to_string());
    }
    std::fs::read(path).map_err(|_| "the file could not be read".to_string())
}

/// Build and run the desktop shell.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("local");
            std::fs::create_dir_all(&root)?;
            let config = load_config(&root)?;
            app.manage(AppState {
                root,
                config: Mutex::new(config),
                login: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            login_begin,
            login_await,
            login_cancel,
            open_external_url,
            secrets_read,
            secrets_write,
            secrets_clear,
            records_list,
            records_read,
            records_write,
            records_delete,
            choose_reference_files,
            read_reference_file,
            choose_save_directory,
            save_image,
            image_exists,
            read_saved_image,
            reveal_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("the Solaris desktop shell failed to start");
}
