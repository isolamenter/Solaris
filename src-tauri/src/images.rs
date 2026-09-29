//! Saved-image files.
//!
//! The device owns the directory and the file name: the client mints a name from
//! its own random source and the native layer joins it to the scope's authorised
//! directory. Nothing a Server sent becomes a path.
//!
//! Reads are confined to the directories the user authorised for that scope (the
//! chosen save directory, or the app's per-scope default), so an arbitrary path
//! parameter cannot become an arbitrary file read.

use std::io;
use std::path::{Path, PathBuf};

use crate::paths;

/// Largest image the native layer will materialise, after decoding.
pub const MAX_IMAGE_BYTES: usize = paths::MAX_IMAGE_BYTES;

/// Write one image into `dir` as `file_name`.
///
/// Temp file, `fsync`, atomic rename. A failure leaves no saved file and no
/// scratch file; a crash leaves at most a `.part` file, which is never mistaken
/// for an image.
pub fn save_image(dir: &Path, file_name: &str, bytes: &[u8]) -> io::Result<(PathBuf, usize)> {
    if paths::parse_image_file_name(file_name).is_none() {
        return Err(invalid("image file name"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(invalid("image size"));
    }
    std::fs::create_dir_all(dir)?;
    let target = dir.join(file_name);
    // The write must land directly in the authorised directory: no scope key, no
    // record id and no remote value contributes a path component.
    if !paths::creates_inside(dir, &target) {
        return Err(invalid("image destination"));
    }
    paths::commit_bytes_atomic(&target, bytes)?;
    Ok((target, bytes.len()))
}

/// Authorise a caller-supplied path against the scope's directories.
///
/// The file must exist, must resolve inside one of `roots`, and must carry a
/// device-chosen image name.
pub fn authorize<'a>(roots: &'a [PathBuf], file_path: &Path) -> io::Result<&'a PathBuf> {
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("image path"))?;
    if paths::parse_image_file_name(name).is_none() {
        return Err(invalid("image file name"));
    }
    for root in roots {
        if paths::resolves_within(root, file_path) {
            return Ok(root);
        }
    }
    Err(invalid("image path"))
}

/// Read an authorised image.
pub fn read_image(roots: &[PathBuf], file_path: &Path) -> io::Result<Vec<u8>> {
    authorize(roots, file_path)?;
    std::fs::read(file_path)
}

/// Whether an authorised image is still on disk.
pub fn image_exists(roots: &[PathBuf], file_path: &Path) -> bool {
    authorize(roots, file_path).is_ok() && file_path.is_file()
}

/// Ask the file manager to show an authorised image. The path is re-validated
/// here, so revealing cannot be used to open something else.
pub fn reveal(roots: &[PathBuf], file_path: &Path) -> io::Result<()> {
    authorize(roots, file_path)?;
    if !file_path.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "image is not on disk"));
    }
    reveal_path(file_path)
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &Path) -> io::Result<()> {
    std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &Path) -> io::Result<()> {
    std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path(path: &Path) -> io::Result<()> {
    let parent = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open").arg(parent).spawn().map(|_| ())
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("invalid {what}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("solaris-images-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    const NAME: &str = "solaris-1758758400000-0f2a1c4e-0000-4000-8000-000000000001.png";

    #[test]
    fn save_then_read_round_trip() {
        let scope_dir = scratch_dir("save").join("images");
        let (path, size) = save_image(&scope_dir, NAME, b"image-bytes").expect("save");
        assert_eq!(size, 11);
        assert!(path.is_file());

        let roots = vec![scope_dir.clone()];
        assert!(image_exists(&roots, &path));
        assert_eq!(read_image(&roots, &path).expect("read"), b"image-bytes");
    }

    #[test]
    fn save_refuses_a_hostile_file_name() {
        let scope_dir = scratch_dir("hostile").join("images");
        for name in ["../escape.png", "solaris-1-nope.png", "solaris-1-not-a-uuid.exe", ".."] {
            assert!(save_image(&scope_dir, name, b"x").is_err(), "{name} was accepted");
        }
        assert!(!scope_dir.parent().expect("parent").join("escape.png").exists());
    }

    #[test]
    fn reads_are_confined_to_the_authorised_directory() {
        let root = scratch_dir("confine");
        let authorised = root.join("images");
        std::fs::create_dir_all(&authorised).expect("authorised dir");

        let outside = root.join(NAME);
        std::fs::write(&outside, b"private").expect("write outside");
        let (inside, _) = save_image(&authorised, NAME, b"mine").expect("save");

        let roots = vec![authorised];
        assert!(image_exists(&roots, &inside));
        // Same file name, different directory: still refused.
        assert!(!image_exists(&roots, &outside));
        assert!(read_image(&roots, &outside).is_err());
        assert!(reveal(&roots, &outside).is_err());
    }

    #[test]
    fn a_removed_file_is_reported_missing() {
        let authorised = scratch_dir("missing").join("images");
        let (path, _) = save_image(&authorised, NAME, b"mine").expect("save");
        let roots = vec![authorised];
        assert!(image_exists(&roots, &path));
        std::fs::remove_file(&path).expect("remove");
        assert!(!image_exists(&roots, &path));
        assert!(read_image(&roots, &path).is_err());
    }

    #[test]
    fn a_partial_write_is_never_a_saved_image() {
        let authorised = scratch_dir("partial").join("images");
        std::fs::create_dir_all(&authorised).expect("dir");
        std::fs::write(authorised.join(format!(".{NAME}.part")), b"half").expect("write");
        let roots = vec![authorised.clone()];
        assert!(!image_exists(&roots, &authorised.join(format!(".{NAME}.part"))));
        assert!(save_image(&authorised, &format!(".{NAME}.part"), b"half").is_err());
    }

    #[test]
    fn oversized_images_are_refused_before_touching_disk() {
        let authorised = scratch_dir("oversize").join("images");
        let too_large = vec![0u8; MAX_IMAGE_BYTES + 1];
        assert!(save_image(&authorised, NAME, &too_large).is_err());
        assert!(!authorised.join(NAME).exists());
    }
}
