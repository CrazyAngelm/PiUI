//! Atomic file replacement (temporary file in the same directory + rename).

use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::Path;

use crate::pkce::random_bytes;

/// Writes `bytes` to `path` so readers see either the old or the new file.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    fs::create_dir_all(dir)?;
    let nonce = random_bytes::<8>().map_err(|_| io::Error::other("random source unavailable"))?;
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let temp = dir.join(format!(".{}.{nonce}.tmp", name.to_string_lossy()));
    if let Err(error) = write_new(&temp, bytes).and_then(|()| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_content_without_leftovers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("file.json");
        atomic_write(&path, b"one").expect("first");
        atomic_write(&path, b"two").expect("second");
        assert_eq!(fs::read(&path).expect("read"), b"two");
        let entries = fs::read_dir(path.parent().expect("parent"))
            .expect("dir")
            .count();
        assert_eq!(entries, 1);
    }
}
