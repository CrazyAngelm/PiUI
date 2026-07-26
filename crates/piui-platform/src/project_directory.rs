use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A validated existing project directory with a platform-native identity.
///
/// `canonical_path` is suitable for host-side registry identity and never needs
/// to be reconstructed from a display string. The original spelling is not
/// retained: callers that need display metadata own it separately.
pub struct ProjectDirectory {
    canonical_path: PathBuf,
    identity: ProjectDirectoryIdentity,
}

/// Opaque, host-only native directory identity. It has no serde implementation
/// and its debug output intentionally omits device/inode or file-index values.
#[derive(Clone, Eq, PartialEq)]
pub struct ProjectDirectoryIdentity {
    inner: DirectoryIdentity,
}

/// Opaque database token for a native directory identity. It deliberately has
/// no serde/display implementation and never exposes a filesystem path.
#[derive(Clone, Eq, PartialEq)]
pub struct ProjectDirectoryIdentityToken {
    value: String,
}

impl fmt::Debug for ProjectDirectoryIdentityToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProjectDirectoryIdentityToken(<redacted>)")
    }
}

impl ProjectDirectoryIdentityToken {
    /// Trusted index storage only; never use this value in UI/IPC payloads.
    #[must_use]
    pub fn as_storage_str(&self) -> &str {
        &self.value
    }
}

impl fmt::Debug for ProjectDirectoryIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProjectDirectoryIdentity(<redacted>)")
    }
}

impl ProjectDirectoryIdentity {
    /// Stable private storage token, never suitable for UI/IPC serialization.
    #[must_use]
    pub fn storage_token(&self) -> ProjectDirectoryIdentityToken {
        ProjectDirectoryIdentityToken {
            value: self.inner.storage_token(),
        }
    }

    /// Rebuilds an identity from a token stored by the trusted host/index.
    /// Invalid or foreign-platform tokens are rejected without exposing them.
    #[must_use]
    pub fn from_storage_token(token: &str) -> Option<Self> {
        DirectoryIdentity::from_storage_token(token).map(|inner| Self { inner })
    }
}

impl fmt::Debug for ProjectDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProjectDirectory(<redacted>)")
    }
}

impl ProjectDirectory {
    /// Canonicalize an existing directory and capture its native identity.
    ///
    /// Canonicalization resolves symlinks (and Windows junctions) before any
    /// identity check. This function neither creates nor writes project files.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty, missing, unreadable, non-directory, or
    /// platform-identity-unavailable path.
    pub fn resolve(path: &Path) -> Result<Self, ProjectDirectoryError> {
        if path.as_os_str().is_empty() {
            return Err(ProjectDirectoryError::EmptyPath);
        }

        let canonical_path = fs::canonicalize(path).map_err(ProjectDirectoryError::Canonicalize)?;
        let metadata = fs::metadata(&canonical_path).map_err(ProjectDirectoryError::Metadata)?;
        if !metadata.is_dir() {
            return Err(ProjectDirectoryError::NotDirectory);
        }

        let identity = ProjectDirectoryIdentity {
            inner: DirectoryIdentity::from_canonical_directory(&canonical_path, &metadata)?,
        };
        Ok(Self {
            canonical_path,
            identity,
        })
    }

    /// The resolved directory path for trusted host-side use.
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    /// Whether two resolved directories refer to the same filesystem object.
    ///
    /// This deliberately compares platform file identity rather than only path
    /// text, so aliases through symlinks, junctions, drive-letter casing, or
    /// UNC spelling do not become duplicate project identities.
    #[must_use]
    pub fn same_directory(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    /// Native identity for trusted host/index persistence only.
    #[must_use]
    pub fn identity(&self) -> &ProjectDirectoryIdentity {
        &self.identity
    }
}

/// Validation failures for a project directory.
#[derive(Debug)]
pub enum ProjectDirectoryError {
    /// An empty path must not silently resolve to the host current directory.
    EmptyPath,
    /// The supplied path could not be canonicalized.
    Canonicalize(io::Error),
    /// Metadata could not be obtained after canonicalization.
    Metadata(io::Error),
    /// The canonical target exists but is not a directory.
    NotDirectory,
    /// The platform-native directory identity could not be obtained.
    Identity(io::Error),
}

impl fmt::Display for ProjectDirectoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPath => formatter.write_str("project directory path is empty"),
            Self::Canonicalize(_) => {
                formatter.write_str("project directory cannot be canonicalized")
            }
            Self::Metadata(_) => formatter.write_str("project directory metadata is unavailable"),
            Self::NotDirectory => formatter.write_str("project path is not a directory"),
            Self::Identity(_) => formatter.write_str("project directory identity is unavailable"),
        }
    }
}

impl Error for ProjectDirectoryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Canonicalize(error) | Self::Metadata(error) | Self::Identity(error) => {
                Some(error)
            }
            Self::EmptyPath | Self::NotDirectory => None,
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
enum DirectoryIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows { volume_serial: u32, file_index: u64 },
    #[cfg(not(any(unix, windows)))]
    Unsupported,
}

impl DirectoryIdentity {
    fn storage_token(&self) -> String {
        match self {
            #[cfg(unix)]
            Self::Unix { device, inode } => format!("unix:{device}:{inode}"),
            #[cfg(windows)]
            Self::Windows {
                volume_serial,
                file_index,
            } => format!("windows:{volume_serial}:{file_index}"),
            #[cfg(not(any(unix, windows)))]
            Self::Unsupported => "unsupported".into(),
        }
    }

    fn from_storage_token(token: &str) -> Option<Self> {
        let mut fields = token.split(':');
        let platform = fields.next()?;
        let first = fields.next()?;
        let second = fields.next()?;
        if fields.next().is_some() {
            return None;
        }
        #[cfg(unix)]
        if platform == "unix" {
            return Some(Self::Unix {
                device: first.parse().ok()?,
                inode: second.parse().ok()?,
            });
        }
        #[cfg(windows)]
        if platform == "windows" {
            return Some(Self::Windows {
                volume_serial: first.parse().ok()?,
                file_index: second.parse().ok()?,
            });
        }
        None
    }

    fn from_canonical_directory(
        canonical_path: &Path,
        metadata: &fs::Metadata,
    ) -> Result<Self, ProjectDirectoryError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            let _ = canonical_path;
            Ok(Self::Unix {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }

        #[cfg(windows)]
        {
            let _ = metadata;
            windows_directory_identity(canonical_path).map_err(ProjectDirectoryError::Identity)
        }

        #[cfg(not(any(unix, windows)))]
        {
            let _ = (canonical_path, metadata);
            Err(ProjectDirectoryError::Identity(io::Error::other(
                "native directory identity is unsupported",
            )))
        }
    }
}

#[cfg(windows)]
fn windows_directory_identity(path: &Path) -> Result<DirectoryIdentity, io::Error> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
    };

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    // Zero desired access requests metadata only. BACKUP_SEMANTICS permits a
    // directory handle without granting a write capability.
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let information_result = unsafe { GetFileInformationByHandle(handle, &raw mut information) };
    if information_result == 0 {
        let error = io::Error::last_os_error();
        let _ = unsafe { CloseHandle(handle) };
        return Err(error);
    }

    let close_result = unsafe { CloseHandle(handle) };
    if close_result == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(DirectoryIdentity::Windows {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(test)]
mod tests {
    use super::{ProjectDirectory, ProjectDirectoryError};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn new() -> Self {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "piui-platform-project-directory-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test directory can be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn resolves_an_existing_directory_to_a_stable_identity() {
        let directory = TemporaryDirectory::new();
        let direct = ProjectDirectory::resolve(directory.path()).expect("directory resolves");
        let dotted = ProjectDirectory::resolve(&directory.path().join("."))
            .expect("dotted directory resolves");

        assert!(direct.canonical_path().is_absolute());
        assert!(direct.same_directory(&dotted));
        let token = direct.identity().storage_token();
        let restored = super::ProjectDirectoryIdentity::from_storage_token(token.as_storage_str())
            .expect("native token restores on the same platform");
        assert_eq!(&restored, direct.identity());
        assert!(!format!("{restored:?}").contains(token.as_storage_str()));
    }

    #[test]
    fn rejects_an_empty_path_without_using_current_directory() {
        let error = ProjectDirectory::resolve(Path::new("")).expect_err("empty path is invalid");
        assert!(matches!(error, ProjectDirectoryError::EmptyPath));
    }

    #[test]
    fn rejects_a_file_instead_of_treating_it_as_a_project() {
        let directory = TemporaryDirectory::new();
        let file = directory.path().join("not-a-directory");
        fs::write(&file, b"fixture").expect("fixture file can be written");

        let error = ProjectDirectory::resolve(&file).expect_err("file is not a directory");
        assert!(matches!(error, ProjectDirectoryError::NotDirectory));
    }

    #[test]
    fn rejects_a_missing_directory() {
        let directory = TemporaryDirectory::new();
        let missing = directory.path().join("missing");

        let error = ProjectDirectory::resolve(&missing).expect_err("missing directory is invalid");
        assert!(matches!(error, ProjectDirectoryError::Canonicalize(_)));
    }
}
