//! Windows-only retained lease for one already-resolved managed-runtime file.
//!
//! The lease is deliberately opaque: it neither returns the input path nor a
//! raw/native handle. It is a non-launching integrity primitive only.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::mem::MaybeUninit;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::FileExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_INFO, FILE_SHARE_READ, FileIdInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, OPEN_EXISTING,
};

/// Path-free failure categories for [`WindowsStableFileLease`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowsStableFileLeaseError {
    OpenFailed,
    UnsafeFile,
    IdentityChanged,
    TooLarge,
    SizeMismatch,
    DigestMismatch,
    ReadFailed,
}

impl std::fmt::Display for WindowsStableFileLeaseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::OpenFailed => "stable file lease could not open the file",
            Self::UnsafeFile => "stable file lease rejected an unsafe file",
            Self::IdentityChanged => "stable file lease file identity changed",
            Self::TooLarge => "stable file lease file exceeds its bound",
            Self::SizeMismatch => "stable file lease file size does not match",
            Self::DigestMismatch => "stable file lease file digest does not match",
            Self::ReadFailed => "stable file lease file cannot be read",
        })
    }
}

impl std::error::Error for WindowsStableFileLeaseError {}

/// Full native identity returned by `FileIdInfo`; this is never exposed from
/// the opaque lease. `BY_HANDLE_FILE_INFORMATION` has only a truncated volume
/// serial and file index, which must not be used for retained-lease identity.
#[derive(Clone, Copy, Eq, PartialEq)]
struct WindowsFileIdentity {
    volume_serial: u64,
    file_id: [u8; 16],
}

/// A read-only Windows file handle that denies future write and delete sharing.
///
/// It is not cloneable, serializable, or executable. The retained handle can
/// only be revalidated against caller-provided bounded provenance values.
pub struct WindowsStableFileLease {
    file: File,
    identity: WindowsFileIdentity,
}

impl std::fmt::Debug for WindowsStableFileLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WindowsStableFileLease(<redacted>)")
    }
}

impl WindowsStableFileLease {
    /// Opens a final bundle component without following a reparse point.
    ///
    /// The handle requests only `GENERIC_READ` and permits only other readers;
    /// future opens requesting write or delete sharing are denied while this
    /// lease remains alive.
    pub fn acquire(candidate: impl AsRef<Path>) -> Result<Self, WindowsStableFileLeaseError> {
        let mut wide_path = candidate
            .as_ref()
            .as_os_str()
            .encode_wide()
            .collect::<Vec<_>>();
        if wide_path.contains(&0) {
            return Err(WindowsStableFileLeaseError::OpenFailed);
        }
        wide_path.push(0);
        let handle = unsafe {
            // The UTF-16 buffer is NUL-terminated and lives through this call.
            // No security descriptor/template handle is supplied.
            CreateFileW(
                wide_path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(WindowsStableFileLeaseError::OpenFailed);
        }
        let file = unsafe {
            // `CreateFileW` returned one owned, valid HANDLE. `File` takes
            // exclusive ownership and closes it exactly once on drop.
            File::from_raw_handle(handle as RawHandle)
        };
        let (identity, _) = inspect_file(&file)?;
        Ok(Self { file, identity })
    }

    /// Rejects an independently opened file unless it is the same native file
    /// identity retained by this lease. The input handle remains caller-owned;
    /// no native handle or path is exposed by the lease.
    pub fn matches_open_file_identity(
        &self,
        candidate: &File,
    ) -> Result<(), WindowsStableFileLeaseError> {
        let (identity, _) = inspect_file(candidate)?;
        if identity != self.identity {
            return Err(WindowsStableFileLeaseError::IdentityChanged);
        }
        Ok(())
    }

    /// Compares retained native identities without exposing either identity or
    /// handle. Bundle verification uses this to require one unique lease per
    /// signed manifest slot.
    #[must_use]
    pub fn has_same_native_identity(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    /// Rechecks file identity, type, link count, exact size, and SHA-256 from
    /// this retained handle. Reads are bounded by both caller limits.
    pub fn revalidate_sha256(
        &self,
        expected_size: u64,
        expected_sha256: [u8; 32],
        max_size: u64,
    ) -> Result<(), WindowsStableFileLeaseError> {
        if expected_size > max_size {
            return Err(WindowsStableFileLeaseError::TooLarge);
        }
        let (identity, size) = inspect_file(&self.file)?;
        if identity != self.identity {
            return Err(WindowsStableFileLeaseError::IdentityChanged);
        }
        if size != expected_size {
            return Err(WindowsStableFileLeaseError::SizeMismatch);
        }

        let mut hasher = Sha256::new();
        let mut offset = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        while offset < expected_size {
            let remaining = expected_size - offset;
            let read_len = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| WindowsStableFileLeaseError::ReadFailed)?;
            let read = self
                .file
                .seek_read(&mut buffer[..read_len], offset)
                .map_err(|_| WindowsStableFileLeaseError::ReadFailed)?;
            if read == 0 {
                return Err(WindowsStableFileLeaseError::SizeMismatch);
            }
            let read = u64::try_from(read).map_err(|_| WindowsStableFileLeaseError::ReadFailed)?;
            offset = offset
                .checked_add(read)
                .ok_or(WindowsStableFileLeaseError::TooLarge)?;
            if offset > expected_size || offset > max_size {
                return Err(WindowsStableFileLeaseError::SizeMismatch);
            }
            hasher.update(
                &buffer[..usize::try_from(read)
                    .map_err(|_| WindowsStableFileLeaseError::ReadFailed)?],
            );
        }
        if hasher.finalize().as_slice() != expected_sha256 {
            return Err(WindowsStableFileLeaseError::DigestMismatch);
        }

        let (final_identity, final_size) = inspect_file(&self.file)?;
        if final_identity != self.identity {
            return Err(WindowsStableFileLeaseError::IdentityChanged);
        }
        if final_size != expected_size {
            return Err(WindowsStableFileLeaseError::SizeMismatch);
        }
        Ok(())
    }
}

fn inspect_file(file: &File) -> Result<(WindowsFileIdentity, u64), WindowsStableFileLeaseError> {
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe {
        // `file` owns a valid Windows HANDLE and `information` points to enough
        // initialized writable storage for the API result.
        GetFileInformationByHandle(file.as_raw_handle() as HANDLE, information.as_mut_ptr())
    };
    if ok == 0 {
        return Err(WindowsStableFileLeaseError::ReadFailed);
    }
    let information = unsafe {
        // The API returned success, so all fields of the output structure are initialized.
        information.assume_init()
    };
    if (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        != 0
        || information.nNumberOfLinks != 1
    {
        return Err(WindowsStableFileLeaseError::UnsafeFile);
    }
    let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);

    let mut identity = MaybeUninit::<FILE_ID_INFO>::zeroed();
    let ok = unsafe {
        // `file` owns a valid handle and `identity` has exactly the writable
        // storage required by FileIdInfo. Failure is rejected because the
        // legacy information above truncates both identity components.
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            identity.as_mut_ptr().cast(),
            u32::try_from(std::mem::size_of::<FILE_ID_INFO>())
                .map_err(|_| WindowsStableFileLeaseError::ReadFailed)?,
        )
    };
    if ok == 0 {
        return Err(WindowsStableFileLeaseError::ReadFailed);
    }
    let identity = unsafe {
        // The API returned success, so the FILE_ID_INFO output is initialized.
        identity.assume_init()
    };
    Ok((
        WindowsFileIdentity {
            volume_serial: identity.VolumeSerialNumber,
            file_id: identity.FileId.Identifier,
        },
        size,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TemporaryDirectory(PathBuf);

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("piui-stable-file-lease-{label}-{sequence}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("creates temporary directory");
            Self(path)
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn digest(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    #[test]
    fn full_file_id_identity_distinguishes_high_bytes() {
        let lower_bytes = WindowsFileIdentity {
            volume_serial: 0x0000_0000_0000_0001,
            file_id: [0; 16],
        };
        let higher_volume_serial = WindowsFileIdentity {
            volume_serial: 0x0000_0001_0000_0001,
            file_id: [0; 16],
        };
        let higher_file_id = WindowsFileIdentity {
            volume_serial: lower_bytes.volume_serial,
            file_id: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        };

        assert!(lower_bytes != higher_volume_serial);
        assert!(lower_bytes != higher_file_id);
    }

    #[test]
    fn retained_handle_revalidates_only_the_expected_bounded_bytes() {
        let root = TemporaryDirectory::new("revalidate");
        let path = root.0.join("runtime.exe");
        let bytes = b"managed runtime";
        fs::write(&path, bytes).expect("writes fixture");
        let lease = WindowsStableFileLease::acquire(&path).expect("acquires regular file lease");

        lease
            .revalidate_sha256(bytes.len() as u64, digest(bytes), bytes.len() as u64)
            .expect("revalidates retained handle");
        assert_eq!(
            lease.revalidate_sha256(
                bytes.len() as u64,
                digest(b"other runtime"),
                bytes.len() as u64
            ),
            Err(WindowsStableFileLeaseError::DigestMismatch)
        );
        assert_eq!(
            lease.revalidate_sha256(bytes.len() as u64, digest(bytes), bytes.len() as u64 - 1),
            Err(WindowsStableFileLeaseError::TooLarge)
        );
        assert_eq!(format!("{lease:?}"), "WindowsStableFileLease(<redacted>)");
    }

    #[test]
    fn opened_file_identity_must_match_the_retained_lease() {
        let root = TemporaryDirectory::new("identity");
        let path = root.0.join("runtime.exe");
        let other = root.0.join("other.exe");
        fs::write(&path, b"managed runtime").expect("writes fixture");
        fs::write(&other, b"other runtime").expect("writes other fixture");
        let lease = WindowsStableFileLease::acquire(&path).expect("acquires regular file lease");
        let same = File::open(&path).expect("opens leased entrypoint for reading");
        let different = File::open(&other).expect("opens another entrypoint for reading");

        lease
            .matches_open_file_identity(&same)
            .expect("matches the same opened file identity");
        assert_eq!(
            lease.matches_open_file_identity(&different),
            Err(WindowsStableFileLeaseError::IdentityChanged)
        );
    }

    #[test]
    fn preexisting_writable_handle_blocks_acquisition_until_closed() {
        let root = TemporaryDirectory::new("preexisting-writer");
        let path = root.0.join("runtime.exe");
        fs::write(&path, b"managed runtime").expect("writes fixture");
        let writer = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("opens preexisting writable handle");

        assert_eq!(
            WindowsStableFileLease::acquire(&path).err(),
            Some(WindowsStableFileLeaseError::OpenFailed)
        );
        drop(writer);
        WindowsStableFileLease::acquire(&path).expect("acquires after writable handle closes");
    }

    #[test]
    fn lease_denies_future_write_and_delete_sharing() {
        let root = TemporaryDirectory::new("share-mode");
        let path = root.0.join("runtime.exe");
        fs::write(&path, b"managed runtime").expect("writes fixture");
        let _lease = WindowsStableFileLease::acquire(&path).expect("acquires regular file lease");

        assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
    }

    #[test]
    fn dropping_lease_allows_deletion_and_replacement() {
        let root = TemporaryDirectory::new("drop-release");
        let path = root.0.join("runtime.exe");
        let replacement = root.0.join("replacement.exe");
        fs::write(&path, b"managed runtime").expect("writes fixture");
        fs::write(&replacement, b"replacement runtime").expect("writes replacement");
        let lease = WindowsStableFileLease::acquire(&path).expect("acquires regular file lease");

        drop(lease);
        fs::remove_file(&path).expect("deletes entrypoint after lease closes");
        fs::rename(&replacement, &path).expect("replaces deleted entrypoint after lease closes");
        assert_eq!(
            fs::read(&path).expect("reads replacement"),
            b"replacement runtime"
        );
    }

    #[test]
    fn rejects_directory_and_hardlinked_final_components() {
        let root = TemporaryDirectory::new("unsafe-final-component");
        assert!(matches!(
            WindowsStableFileLease::acquire(&root.0),
            Err(WindowsStableFileLeaseError::UnsafeFile)
        ));

        let runtime = root.0.join("runtime.exe");
        let alias = root.0.join("alias.exe");
        fs::write(&runtime, b"managed runtime").expect("writes fixture");
        fs::hard_link(&runtime, &alias).expect("creates hardlink");
        assert!(matches!(
            WindowsStableFileLease::acquire(&runtime),
            Err(WindowsStableFileLeaseError::UnsafeFile)
        ));
    }

    #[test]
    fn rejects_final_component_reparse_point_when_symlinks_are_available() {
        let root = TemporaryDirectory::new("reparse");
        let target = root.0.join("target.exe");
        let link = root.0.join("runtime.exe");
        fs::write(&target, b"managed runtime").expect("writes fixture");
        if let Err(error) = std::os::windows::fs::symlink_file(&target, &link) {
            if std::env::var_os("PIUI_REQUIRE_WINDOWS_REPARSE_TEST").as_deref()
                == Some(std::ffi::OsStr::new("1"))
            {
                panic!("required Windows reparse test could not create symlink: {error}");
            }
            eprintln!(
                "SKIP: Windows reparse test could not create a symlink ({error}); \
                 set PIUI_REQUIRE_WINDOWS_REPARSE_TEST=1 to require this capability"
            );
            return;
        }
        assert!(matches!(
            WindowsStableFileLease::acquire(&link),
            Err(WindowsStableFileLeaseError::UnsafeFile)
        ));
    }
}
