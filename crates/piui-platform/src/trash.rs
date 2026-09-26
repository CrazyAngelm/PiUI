//! Moving one regular file to the user's trash (the Windows Recycle Bin or
//! the freedesktop.org home trash).
//!
//! Nothing here deletes permanently. When the platform cannot recycle a file
//! it stays where it is and the caller receives [`TrashError`]. Directories,
//! symbolic links, junctions and other reparse points are refused: moving a
//! link could reach files outside the folder the user reviewed.

use std::error::Error;
use std::fmt;
use std::io;
use std::path::Path;

/// Why a file was not moved to the trash. The file is untouched in every case.
#[derive(Debug)]
pub enum TrashError {
    /// This platform has no trash PiUI can use yet.
    Unsupported,
    /// Nothing exists at the path.
    NotFound,
    /// Only regular files are moved; directories and links are refused.
    NotARegularFile,
    /// The platform could not recycle the file and permanent deletion was
    /// refused (for example the Recycle Bin is turned off for that drive).
    Declined,
    /// Another I/O failure.
    Io(io::Error),
}

impl fmt::Display for TrashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => {
                formatter.write_str("moving files to the trash is not supported here")
            }
            Self::NotFound => formatter.write_str("the file does not exist"),
            Self::NotARegularFile => {
                formatter.write_str("only regular files can be moved to the trash")
            }
            Self::Declined => formatter.write_str("the file could not be moved to the trash"),
            Self::Io(_) => formatter.write_str("the file could not be moved to the trash"),
        }
    }
}

impl Error for TrashError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

/// Moves one existing regular file to the user's trash.
///
/// `path` must be absolute. The file is checked without following links.
///
/// # Errors
///
/// See [`TrashError`]; the file is never deleted when an error is returned.
pub fn move_file_to_trash(path: &Path) -> Result<(), TrashError> {
    if !path.is_absolute() {
        return Err(TrashError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "trash paths must be absolute",
        )));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            TrashError::NotFound
        } else {
            TrashError::Io(error)
        }
    })?;
    if !metadata.file_type().is_file() {
        return Err(TrashError::NotARegularFile);
    }
    platform::move_to_trash(path)
}

#[cfg(windows)]
mod platform {
    use super::TrashError;
    use std::io;
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::{Component, Path, PathBuf, Prefix};
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
    };

    /// The shell file operation does not accept verbatim (`\\?\`) paths.
    pub(super) fn shell_path(path: &Path) -> Option<PathBuf> {
        let mut components = path.components();
        match components.next() {
            Some(Component::Prefix(prefix)) => {
                let root = match prefix.kind() {
                    Prefix::VerbatimDisk(letter) | Prefix::Disk(letter) => {
                        format!("{}:\\", char::from(letter))
                    }
                    Prefix::VerbatimUNC(server, share) | Prefix::UNC(server, share) => format!(
                        "\\\\{}\\{}\\",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    ),
                    _ => return None,
                };
                // A drive-relative path (`C:name`) has no root directory.
                if components.next() != Some(Component::RootDir) {
                    return None;
                }
                let mut plain = PathBuf::from(root);
                for component in components {
                    match component {
                        Component::Normal(name) => plain.push(name),
                        _ => return None,
                    }
                }
                Some(plain)
            }
            _ => None,
        }
    }

    pub(super) fn move_to_trash(path: &Path) -> Result<(), TrashError> {
        let plain = shell_path(path).ok_or_else(|| {
            TrashError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the path cannot be handed to the Windows shell",
            ))
        })?;
        let mut wide: Vec<u16> = plain.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(TrashError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the path contains a NUL character",
            )));
        }
        // The shell expects a double-NUL terminated list of paths.
        wide.extend([0, 0]);
        // Recycle; if the file cannot be recycled the shell asks the person
        // before deleting it permanently (FOF_WANTNUKEWARNING), and a refusal
        // aborts the operation with the file in place.
        let flags =
            FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING;
        let mut operation = SHFILEOPSTRUCTW {
            hwnd: std::ptr::null_mut(),
            wFunc: FO_DELETE,
            pFrom: wide.as_ptr(),
            pTo: std::ptr::null(),
            fFlags: u16::try_from(flags).map_err(|_| TrashError::Declined)?,
            fAnyOperationsAborted: 0,
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: std::ptr::null(),
        };
        // SAFETY: `operation` points at a double-NUL terminated wide string
        // that outlives the call; the other pointers are null as documented.
        let result = unsafe { SHFileOperationW(&mut operation) };
        if operation.fAnyOperationsAborted != 0 {
            return Err(TrashError::Declined);
        }
        if result != 0 {
            return Err(TrashError::Io(io::Error::other(
                "the Windows shell could not recycle the file",
            )));
        }
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            _ => Err(TrashError::Declined),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::TrashError;
    use std::path::Path;

    pub(super) fn move_to_trash(path: &Path) -> Result<(), TrashError> {
        let home = super::freedesktop::home_trash().ok_or(TrashError::Unsupported)?;
        match super::freedesktop::trash_into(&home, path) {
            Err(super::freedesktop::Attempt::CrossDevice) => {
                let top = super::freedesktop::topdir_trash(path)?;
                match super::freedesktop::trash_into(&top, path) {
                    Ok(()) => Ok(()),
                    Err(super::freedesktop::Attempt::CrossDevice) => Err(TrashError::Unsupported),
                    Err(super::freedesktop::Attempt::Failed(error)) => Err(error),
                }
            }
            Err(super::freedesktop::Attempt::Failed(error)) => Err(error),
            Ok(()) => Ok(()),
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::TrashError;
    use std::path::Path;

    pub(super) fn move_to_trash(_path: &Path) -> Result<(), TrashError> {
        Err(TrashError::Unsupported)
    }
}

/// The freedesktop.org Trash specification 1.0: `files/` holds the item,
/// `info/<name>.trashinfo` its original path and deletion date. The info file
/// is reserved with an exclusive create before the rename, so two moves
/// never share a name.
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod freedesktop {
    use super::TrashError;
    use std::io::{self, Write as _};
    use std::path::Path;

    pub(crate) enum Attempt {
        /// The trash is on another filesystem; the file was not moved.
        CrossDevice,
        Failed(TrashError),
    }

    /// Percent-encodes a path as the specification asks (RFC 2396 escaping,
    /// keeping `/`).
    pub(crate) fn encode_path(path: &[u8]) -> String {
        let mut encoded = String::with_capacity(path.len());
        for byte in path {
            if byte.is_ascii_alphanumeric() || b"/-_.~".contains(byte) {
                encoded.push(char::from(*byte));
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    pub(crate) fn info_text(original: &[u8], deleted_at: &str) -> String {
        format!(
            "[Trash Info]\nPath={}\nDeletionDate={deleted_at}\n",
            encode_path(original)
        )
    }

    /// `name`, then `stem.2.ext`, `stem.3.ext`, …
    pub(crate) fn candidate_name(name: &str, attempt: usize) -> String {
        if attempt == 0 {
            return name.to_owned();
        }
        match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => {
                format!("{stem}.{}.{extension}", attempt + 1)
            }
            _ => format!("{name}.{}", attempt + 1),
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn home_trash() -> Option<std::path::PathBuf> {
        use std::path::PathBuf;
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .map(|home| home.join(".local").join("share"))
            })?;
        Some(data.join("Trash"))
    }

    /// `$topdir/.Trash-$uid` of the filesystem that holds `path`.
    #[cfg(target_os = "linux")]
    pub(crate) fn topdir_trash(path: &Path) -> Result<std::path::PathBuf, TrashError> {
        use std::os::unix::fs::MetadataExt as _;
        let device = std::fs::symlink_metadata(path)
            .map_err(TrashError::Io)?
            .dev();
        let mut top = path.parent().ok_or(TrashError::Unsupported)?.to_path_buf();
        while let Some(parent) = top.parent() {
            match std::fs::metadata(parent) {
                Ok(metadata) if metadata.dev() == device => top = parent.to_path_buf(),
                _ => break,
            }
        }
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        Ok(top.join(format!(".Trash-{uid}")))
    }

    fn private_directory(path: &Path) -> io::Result<()> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            builder.mode(0o700);
        }
        builder.create(path)
    }

    /// Local time as `YYYY-MM-DDThh:mm:ss`.
    #[cfg(target_os = "linux")]
    fn deletion_date() -> String {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let now = libc::time_t::try_from(seconds).unwrap_or(0);
        // SAFETY: `tm` is a plain C struct; localtime_r only writes into it.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: both pointers are valid for the duration of the call.
        let converted = unsafe { libc::localtime_r(&now, &mut tm) };
        if converted.is_null() {
            return "1970-01-01T00:00:00".into();
        }
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            i64::from(tm.tm_year) + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec
        )
    }

    #[cfg(not(target_os = "linux"))]
    fn deletion_date() -> String {
        "1970-01-01T00:00:00".into()
    }

    #[cfg(unix)]
    fn path_bytes(path: &Path) -> Vec<u8> {
        use std::os::unix::ffi::OsStrExt as _;
        path.as_os_str().as_bytes().to_vec()
    }

    #[cfg(not(unix))]
    fn path_bytes(path: &Path) -> Vec<u8> {
        path.to_string_lossy().replace('\\', "/").into_bytes()
    }

    #[cfg(unix)]
    fn cross_device(error: &io::Error) -> bool {
        error.raw_os_error() == Some(libc::EXDEV)
    }

    #[cfg(not(unix))]
    fn cross_device(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::CrossesDevices
    }

    /// Moves `path` into the trash directory `trash`, creating it if needed.
    pub(crate) fn trash_into(trash: &Path, path: &Path) -> Result<(), Attempt> {
        let files = trash.join("files");
        let info = trash.join("info");
        for directory in [&files, &info] {
            private_directory(directory).map_err(|error| Attempt::Failed(TrashError::Io(error)))?;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(Attempt::Failed(TrashError::Unsupported))?;
        let text = info_text(&path_bytes(path), &deletion_date());
        for attempt in 0..1000 {
            let candidate = candidate_name(name, attempt);
            let info_path = info.join(format!("{candidate}.trashinfo"));
            let mut file = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&info_path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(Attempt::Failed(TrashError::Io(error))),
            };
            let written = file
                .write_all(text.as_bytes())
                .and_then(|()| file.sync_all());
            drop(file);
            if let Err(error) = written {
                let _ = std::fs::remove_file(&info_path);
                return Err(Attempt::Failed(TrashError::Io(error)));
            }
            let target = files.join(&candidate);
            if std::fs::symlink_metadata(&target).is_ok() {
                // A stray item without an info file keeps its name.
                let _ = std::fs::remove_file(&info_path);
                continue;
            }
            return match std::fs::rename(path, &target) {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = std::fs::remove_file(&info_path);
                    if cross_device(&error) {
                        Err(Attempt::CrossDevice)
                    } else {
                        Err(Attempt::Failed(TrashError::Io(error)))
                    }
                }
            };
        }
        Err(Attempt::Failed(TrashError::Declined))
    }
}

#[cfg(test)]
mod tests {
    use super::{TrashError, freedesktop, move_file_to_trash};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "piui-trash-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("creates scratch directory");
        root
    }

    #[test]
    fn refuses_relative_missing_and_non_file_paths_without_touching_them() {
        let root = scratch("refusals");
        assert!(matches!(
            move_file_to_trash(std::path::Path::new("relative.txt")),
            Err(TrashError::Io(_))
        ));
        assert!(matches!(
            move_file_to_trash(&root.join("missing.txt")),
            Err(TrashError::NotFound)
        ));
        let directory = root.join("folder");
        std::fs::create_dir_all(&directory).expect("creates folder");
        assert!(matches!(
            move_file_to_trash(&directory),
            Err(TrashError::NotARegularFile)
        ));
        assert!(directory.is_dir(), "a refused folder stays in place");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_links() {
        let root = scratch("links");
        let target = root.join("target.txt");
        std::fs::write(&target, "kept").expect("writes target");
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).expect("creates link");
        assert!(matches!(
            move_file_to_trash(&link),
            Err(TrashError::NotARegularFile)
        ));
        assert_eq!(std::fs::read_to_string(&target).expect("target"), "kept");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn freedesktop_info_encodes_the_original_path() {
        assert_eq!(
            freedesktop::encode_path(b"/home/a b/%x/\xD0\x96.txt"),
            "/home/a%20b/%25x/%D0%96.txt"
        );
        let text = freedesktop::info_text(b"/tmp/new file.txt", "2026-09-27T10:11:12");
        assert_eq!(
            text,
            "[Trash Info]\nPath=/tmp/new%20file.txt\nDeletionDate=2026-09-27T10:11:12\n"
        );
        assert_eq!(freedesktop::candidate_name("a.txt", 0), "a.txt");
        assert_eq!(freedesktop::candidate_name("a.txt", 1), "a.2.txt");
        assert_eq!(freedesktop::candidate_name("Makefile", 2), "Makefile.3");
        assert_eq!(freedesktop::candidate_name(".env", 1), ".env.2");
    }

    #[test]
    fn freedesktop_trash_moves_the_file_and_never_reuses_a_name() {
        let root = scratch("freedesktop");
        let trash = root.join("Trash");
        for content in ["first", "second"] {
            let file = root.join("notes.txt");
            std::fs::write(&file, content).expect("writes file");
            assert!(freedesktop::trash_into(&trash, &file).is_ok());
            assert!(!file.exists(), "the file left its folder");
        }
        assert_eq!(
            std::fs::read_to_string(trash.join("files").join("notes.txt")).expect("first"),
            "first"
        );
        assert_eq!(
            std::fs::read_to_string(trash.join("files").join("notes.2.txt")).expect("second"),
            "second"
        );
        let info = std::fs::read_to_string(trash.join("info").join("notes.2.txt.trashinfo"))
            .expect("info file");
        assert!(info.starts_with("[Trash Info]\nPath="));
        assert!(info.contains("notes.txt\nDeletionDate="));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_paths_drop_the_verbatim_prefix() {
        use super::platform::shell_path;
        assert_eq!(
            shell_path(std::path::Path::new(r"\\?\C:\Users\a\b.txt")),
            Some(PathBuf::from(r"C:\Users\a\b.txt"))
        );
        assert_eq!(
            shell_path(std::path::Path::new(r"C:\Users\a\b.txt")),
            Some(PathBuf::from(r"C:\Users\a\b.txt"))
        );
        assert_eq!(
            shell_path(std::path::Path::new(r"\\?\UNC\server\share\x.txt")),
            Some(PathBuf::from(r"\\server\share\x.txt"))
        );
        assert_eq!(shell_path(std::path::Path::new(r"C:relative.txt")), None);
    }

    /// Moves a scratch file to the real Recycle Bin or home trash. Ignored by
    /// default because it leaves a small file in the person's trash.
    #[test]
    #[ignore = "writes to the real system trash"]
    fn moves_a_scratch_file_to_the_system_trash() {
        let root = scratch("system");
        let file = root.join("piui-trash-probe.txt");
        std::fs::write(&file, "PiUI trash probe").expect("writes probe");
        move_file_to_trash(&file).expect("moves the probe to the trash");
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
