//! The Windows release includes a pinned Node and Pi. Extraction waits for
//! the first Nano session, and publishing a complete directory is atomic.

use ruzstd::decoding::StreamingDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub(crate) const NODE: &str = "node.exe";
pub(crate) const PI_CLI: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const REQUIRED_FILES: [&str; 4] = [NODE, PI_CLI, "rg.exe", "fd.exe"];

#[cfg(bundled_nano_runtime)]
pub(crate) const PI_VERSION: &str = env!("PIUI_NANO_RUNTIME_VERSION");

#[cfg(bundled_nano_runtime)]
pub(crate) fn prepare(cache: &Path) -> io::Result<PathBuf> {
    static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _install = INSTALL.lock().map_err(|_| invalid_bundle())?;
    let archive = include_bytes!(env!("PIUI_NANO_RUNTIME_ARCHIVE"));
    let manifest = include_bytes!(env!("PIUI_NANO_RUNTIME_MANIFEST"));
    install(cache, archive, manifest)
}

#[derive(Deserialize)]
struct BundleFile {
    sha256: String,
    size: u64,
}

fn install(cache: &Path, archive: &[u8], manifest: &[u8]) -> io::Result<PathBuf> {
    let files: BTreeMap<PathBuf, BundleFile> = serde_json::from_slice(manifest)?;
    if !REQUIRED_FILES
        .iter()
        .all(|path| files.contains_key(Path::new(path)))
    {
        return Err(invalid_bundle());
    }
    let directories = bundle_directories(&files)?;
    let parent = cache.parent().ok_or_else(invalid_bundle)?;
    if let Err(error) = fs::symlink_metadata(parent) {
        if error.kind() != io::ErrorKind::NotFound
            || !plain_directory(parent.parent().ok_or_else(invalid_bundle)?)?
        {
            return Err(invalid_bundle());
        }
        if let Err(error) = fs::create_dir(parent)
            && error.kind() != io::ErrorKind::AlreadyExists
        {
            return Err(error);
        }
    }
    if !plain_directory(parent)? {
        return Err(invalid_bundle());
    }
    fs::create_dir_all(cache)?;
    if !plain_directory(cache)? {
        return Err(invalid_bundle());
    }
    let root = cache.join(format!("{:x}", Sha256::digest(manifest)));
    let replace = match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {
            if verify_tree(&root, &files, &directories).is_ok() {
                return Ok(root);
            }
            true
        }
        Ok(_) => return Err(invalid_bundle()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let staging = tempfile::tempdir_in(cache)?;
    unpack(staging.path(), archive, &files)?;
    verify_tree(staging.path(), &files, &directories)?;
    let retired = if replace {
        let directory = tempfile::tempdir_in(cache)?;
        fs::rename(&root, directory.path().join("runtime"))?;
        Some(directory)
    } else {
        None
    };
    if let Err(error) = fs::rename(staging.path(), &root) {
        // A separate app process may have published a complete copy.
        if verify_tree(&root, &files, &directories).is_err() {
            if let Some(directory) = retired
                && fs::rename(directory.path().join("runtime"), &root).is_err()
            {
                let _ = directory.keep();
            }
            return Err(error);
        }
    }
    Ok(root)
}

fn bundle_directories(files: &BTreeMap<PathBuf, BundleFile>) -> io::Result<BTreeSet<PathBuf>> {
    let mut directories = BTreeSet::new();
    for path in files.keys() {
        if path.as_os_str().is_empty()
            || !path.components().all(|component| match component {
                Component::Normal(name) => name
                    .to_str()
                    .is_some_and(|name| !name.contains([':', '\\']) && !name.ends_with(['.', ' '])),
                _ => false,
            })
        {
            return Err(invalid_bundle());
        }
        directories.extend(path.ancestors().skip(1).map(Path::to_path_buf));
    }
    Ok(directories)
}

fn unpack(root: &Path, compressed: &[u8], files: &BTreeMap<PathBuf, BundleFile>) -> io::Result<()> {
    let decoder = StreamingDecoder::new(compressed).map_err(io::Error::other)?;
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let relative = path.strip_prefix(".").unwrap_or(&path);
        let spec = files.get(relative).ok_or_else(invalid_bundle)?;
        if !kind.is_file() || entry.size() != spec.size {
            return Err(invalid_bundle());
        }
        let destination = root.join(relative);
        fs::create_dir_all(destination.parent().ok_or_else(invalid_bundle)?)?;
        let mut file = File::create_new(destination)?;
        if io::copy(&mut entry, &mut file)? != spec.size {
            return Err(invalid_bundle());
        }
    }
    Ok(())
}

fn verify_tree(
    root: &Path,
    files: &BTreeMap<PathBuf, BundleFile>,
    directories: &BTreeSet<PathBuf>,
) -> io::Result<()> {
    if !plain_directory(root)? {
        return Err(invalid_bundle());
    }
    let mut pending = vec![PathBuf::new()];
    let mut seen_files = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(root.join(&directory))? {
            let entry = entry?;
            let relative = directory.join(entry.file_name());
            let metadata = fs::symlink_metadata(entry.path())?;
            if is_reparse_point(&metadata) {
                return Err(invalid_bundle());
            }
            if metadata.is_dir() && directories.contains(&relative) {
                pending.push(relative);
            } else if metadata.is_file() {
                let spec = files.get(&relative).ok_or_else(invalid_bundle)?;
                if metadata.len() != spec.size {
                    return Err(invalid_bundle());
                }
                let mut hash = Sha256::new();
                let mut file = File::open(entry.path())?.take(spec.size.saturating_add(1));
                if io::copy(&mut file, &mut hash)? != spec.size
                    || format!("{:x}", hash.finalize()) != spec.sha256
                {
                    return Err(invalid_bundle());
                }
                seen_files += 1;
            } else {
                return Err(invalid_bundle());
            }
        }
    }
    if seen_files == files.len() {
        Ok(())
    } else {
        Err(invalid_bundle())
    }
}

fn plain_directory(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    Ok(metadata.is_dir() && !is_reparse_point(&metadata))
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn invalid_bundle() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid bundled Nano runtime")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruzstd::encoding::{CompressionLevel, compress_to_vec};

    fn fixture() -> (Vec<u8>, Vec<u8>) {
        let mut archive = tar::Builder::new(Vec::new());
        let mut manifest = BTreeMap::new();
        for path in REQUIRED_FILES {
            let content = path.as_bytes();
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(content.len() as u64);
            header.set_cksum();
            archive
                .append_data(&mut header, path, content)
                .expect("tar entry");
            manifest.insert(
                path,
                serde_json::json!({"sha256": format!("{:x}", Sha256::digest(content)), "size": content.len()}),
            );
        }
        let tar = archive.into_inner().expect("archive");
        let compressed = compress_to_vec(tar.as_slice(), CompressionLevel::Fastest);
        (compressed, serde_json::to_vec(&manifest).expect("manifest"))
    }

    #[test]
    fn publishes_once_and_repairs_changed_missing_or_extra_files() {
        let cache = tempfile::tempdir().expect("cache");
        let (archive, manifest) = fixture();
        let root = install(cache.path(), &archive, &manifest).expect("install");
        assert_eq!(
            fs::read(root.join(PI_CLI)).expect("Pi CLI"),
            PI_CLI.as_bytes()
        );
        assert_eq!(
            install(cache.path(), &archive, &manifest).expect("reuse"),
            root
        );
        fs::write(root.join("extra.js"), []).expect("extra file");
        assert_eq!(
            install(cache.path(), &archive, &manifest).expect("repair extra file"),
            root
        );
        assert!(!root.join("extra.js").exists());
        fs::write(root.join(NODE), b"node.bin").expect("changed file of same size");
        fs::remove_file(root.join("fd.exe")).expect("missing search tool");
        assert_eq!(
            install(cache.path(), &archive, &manifest).expect("repair damaged files"),
            root
        );
        assert_eq!(
            fs::read(root.join(NODE)).expect("restored Node"),
            NODE.as_bytes()
        );
        assert!(root.join("fd.exe").is_file());
        assert_eq!(cache.path().read_dir().expect("cache").count(), 1);
    }

    #[test]
    fn invalid_archive_never_publishes_and_can_be_retried() {
        let cache = tempfile::tempdir().expect("cache");
        let (archive, manifest) = fixture();
        assert!(install(cache.path(), b"invalid archive", &manifest).is_err());
        assert_eq!(cache.path().read_dir().expect("cache").count(), 0);
        assert!(install(cache.path(), &archive, &manifest).is_ok());
    }

    #[test]
    fn the_shared_runtime_can_be_the_first_nano_asset_in_new_app_data() {
        let app_data = tempfile::tempdir().expect("app data");
        let cache = app_data.path().join("nano/runtime");
        let (archive, manifest) = fixture();
        let root = install(&cache, &archive, &manifest).expect("install external first");
        assert!(root.join(NODE).is_file());
        assert_eq!(install(&cache, &archive, &manifest).expect("reuse"), root);
    }
}
