//! Read-only projections of Pi session JSONL plus rebuildable SQLite metadata.
//!
//! This crate deliberately has no operation that mutates a Pi session file. A
//! session path is supplied by trusted host code, read once as bytes, and
//! projected in memory. SQLite stores only a replaceable projection and private
//! host paths; UI-facing summaries contain safe display strings only.

pub use piui_contracts as contracts;

use piui_contracts::{
    BlockId, BlockStatus, EntryId, ModelRef, ProjectId, ProjectSummary as ContractProjectSummary,
    ProjectTrustState, ReadOnlySessionTree, SessionId, SessionParseState,
    SessionProjection as ContractSessionProjection, SessionSummary as ContractSessionSummary,
    SessionTitleSource, TimelineBlock, TimelineBlockKind, TimelinePage, TimelineSource,
};
use piui_platform::{ProjectDirectory, ProjectDirectoryIdentity};
use rusqlite::functions::FunctionFlags;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const PREVIEW_LIMIT: usize = 120;
/// Render-only limits. Discovery and indexing continue to use `PREVIEW_LIMIT`.
/// User/assistant Markdown is kept substantially larger than search previews.
const DISPLAY_MESSAGE_LIMIT: usize = 64 * 1024;
/// Tool output and reasoning remain readable without monopolizing page memory.
const DISPLAY_DETAIL_LIMIT: usize = 16 * 1024;
/// The render projection keeps the newest payloads when this bounded cache is
/// exceeded; older blocks remain as safe, explicitly truncated metadata.
const DISPLAY_TOTAL_LIMIT: usize = 4 * 1024 * 1024;
/// Host-private marker removed before DTO projection; source controls are
/// already filtered, so it cannot be confused with visible session content.
const DISPLAY_TRUNCATION_SENTINEL: char = '\0';
const SESSION_SEARCH_QUERY_MAX_CHARS: usize = 120;
const SESSION_SEARCH_RESULT_LIMIT: i64 = 50;
const SESSION_SEARCH_PROJECT_ID_LIMIT: usize = 64;
// Global allowlist search examines at most this many newest cached rows before
// Unicode/literal matching. This deliberately trades exhaustive historical
// search for bounded work while the index mutex is held.
const SESSION_SEARCH_CANDIDATE_ROW_BUDGET: usize = 256;
/// Maximum number of generic timeline blocks returned by one pure slice.
pub const TIMELINE_SLICE_MAX_LIMIT: usize = 200;
const PREFERENCES_STATE_KEY: &str = "piui.preferences.v1";
const TYPE_LIMIT: usize = 80;
const HEADER_CWD_MAX_BYTES: usize = 32 * 1024;
/// A complete initial header is sufficient to exclude a candidate that belongs
/// to another canonical project, avoiding a full parse of its JSONL history.
const DISCOVERY_HEADER_PREFIX_BYTES: usize = 64 * 1024;
/// Tail bytes included in the weak continuity fingerprint used only to avoid a
/// repeat projection scan. This is deliberately not a rendering/mutation proof.
const DISCOVERY_TAIL_EVIDENCE_BYTES: usize = 64 * 1024;
const DISCOVERY_FINGERPRINT_PARSER_VERSION: i64 = 1;
/// Metadata discovery never retains an individual JSONL frame beyond this
/// limit. Larger completed frames are recorded as corrupt and skipped.
const CATALOG_FRAME_MAX_BYTES: usize = 1024 * 1024;
const CATALOG_DIAGNOSTIC_LIMIT: usize = 64;
const CATALOG_UNKNOWN_ENTRY_LIMIT: usize = 64;
const TREE_MAX_NODES: usize = 10_000;
const TREE_MAX_DEPTH: usize = 1_024;
const TREE_MAX_OUTPUT_NODES: usize = 8_000;
const KNOWN_TYPES: &[&str] = &[
    "session",
    "session_meta",
    "session_info",
    "message",
    "custom",
    "custom_message",
    "compaction",
    "model_change",
    "thinking_level_change",
    "label",
    "branch_summary",
    "tool",
    "tool_result",
];

/// The scanner's result is a projection, never a claim that Pi accepts every
/// record as a currently executable session.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseState {
    Healthy,
    Partial,
    Unsupported,
    Corrupt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub line: u64,
    pub detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct UnknownEntrySummary {
    pub line: u64,
    pub entry_type: String,
    pub byte_length: usize,
    pub sha256: String,
}

/// A bounded, payload-safe record projection. Unknown records have no role,
/// preview, model, or image data even if a future format happens to use those
/// field names.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexedEntry {
    pub line: u64,
    pub order: usize,
    pub entry_id: Option<String>,
    pub parent_id: Option<String>,
    pub entry_type: String,
    pub role: Option<String>,
    pub preview: Option<String>,
    pub created_at: Option<String>,
    pub has_image: bool,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeNode {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
}

/// Generic blocks are intentionally renderer-independent. There is no raw Pi
/// payload in this type, so custom and future entries remain safely readable.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GenericTimelineBlock {
    /// Scanner-assigned opaque ID, never a source entry ID.
    pub id: String,
    /// Scanner-assigned parent block ID only when source linkage is unique and
    /// acyclic; source parent IDs are never exposed here.
    pub parent_id: Option<String>,
    pub kind: GenericBlockKind,
    pub source_type: String,
    pub created_at: Option<String>,
    pub preview: Option<String>,
    pub has_image: bool,
    /// Render-path-only semantic metadata. Scanner/index projections retain
    /// their preview-only defaults.
    pub title: Option<String>,
    pub tool_name: Option<String>,
    #[serde(default)]
    pub collapsible: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub fallback: bool,
    #[serde(default)]
    pub status: GenericBlockStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenericBlockKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Custom,
    Compaction,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenericBlockStatus {
    #[default]
    Complete,
    Running,
    Failed,
    Interrupted,
}

/// A position-based, chronologically ordered timeline slice. `start..end` is
/// the half-open range inside the report's full `total` block sequence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TimelineSlice {
    pub blocks: Vec<GenericTimelineBlock>,
    pub start: usize,
    pub end: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanReport {
    pub source_name: String,
    pub file_revision: String,
    /// Host-only stable metadata captured by a bounded no-follow render scan.
    /// In-memory/test scans leave it `None`; it never crosses serde/IPC.
    #[serde(skip)]
    pub source_modified: Option<SystemTime>,
    pub complete_bytes: usize,
    pub partial_tail_bytes: usize,
    pub parse_state: ParseState,
    pub pi_session_id: Option<String>,
    pub session_name: Option<String>,
    /// Host-only scanner data. Do not serialize this type to an untrusted UI;
    /// use [`SessionSummary`] instead.
    #[serde(skip_serializing, skip_deserializing, default)]
    pub project_cwd: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub first_user_preview: Option<String>,
    pub last_message_preview: Option<String>,
    pub model_ref: Option<String>,
    pub entry_count: usize,
    pub image_entry_count: usize,
    pub compaction_entry_count: usize,
    pub branch_count: usize,
    pub current_leaf_id: Option<String>,
    pub roots: Vec<String>,
    pub orphan_ids: Vec<String>,
    pub cycle_ids: Vec<String>,
    pub unknown_entries: Vec<UnknownEntrySummary>,
    pub diagnostics: Vec<Diagnostic>,
    pub entries: Vec<IndexedEntry>,
    pub tree: Vec<SessionTreeNode>,
    pub timeline_blocks: Vec<GenericTimelineBlock>,
}

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("session source is not a regular file")]
    NotRegularFile,
    #[error("cannot read session source")]
    Read(#[source] std::io::Error),
}

/// Read exactly one explicit session file. The implementation uses `fs::read`;
/// it never opens a writable handle, repairs records, renames, or truncates.
pub fn scan_file(path: impl AsRef<Path>) -> Result<ScanReport, ScanError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(ScanError::NotRegularFile);
    }
    let bytes = fs::read(path).map_err(ScanError::Read)?;
    Ok(scan_bytes(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("session.jsonl"),
        &bytes,
    ))
}

/// A path intentionally confined to trusted host code. It has no `Serialize`
/// implementation and its debug form is redacted, so it cannot become an IPC
/// DTO by accident. Rescan authorization is bound to the identity and revision
/// persisted at indexing time, never to a freshly sampled path.
pub struct HostSessionFile {
    path: PathBuf,
    expected_identity: Option<PlatformFileIdentity>,
    expected_revision: Option<String>,
    verification_limit: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PlatformFileIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows { volume_serial: u32, file_index: u64 },
    #[cfg(not(any(unix, windows)))]
    Unsupported,
}

impl PlatformFileIdentity {
    fn storage_value(&self) -> String {
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

    fn from_storage(value: &str) -> Option<Self> {
        let mut fields = value.split(':');
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
}

impl HostSessionFile {
    /// The trusted host may use this only for a read-only rescan.
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.path
    }

    /// Binds the exact bytes and handle identity observed by discovery. This
    /// constructor is private so only the no-follow discovery reader can mint
    /// a capability accepted by `index_discovered_scan`.
    fn from_verified(
        path: PathBuf,
        identity: PlatformFileIdentity,
        revision: String,
        verification_limit: usize,
    ) -> Self {
        Self {
            path,
            expected_identity: Some(identity),
            expected_revision: Some(revision),
            verification_limit: Some(verification_limit),
        }
    }

    fn from_stored(path: PathBuf, identity: String, revision: String) -> Result<Self, IndexError> {
        let expected_identity = PlatformFileIdentity::from_storage(&identity)
            .ok_or(IndexError::SessionIdentityUnavailable)?;
        if revision.is_empty() {
            return Err(IndexError::SessionIdentityUnavailable);
        }
        Ok(Self {
            path,
            expected_identity: Some(expected_identity),
            expected_revision: Some(revision),
            verification_limit: None,
        })
    }
}

impl std::fmt::Debug for HostSessionFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("HostSessionFile(<redacted>)")
    }
}

/// Errors from the bounded trusted-host rescan API. Displays deliberately omit
/// the private session path; callers can surface these safely without turning a
/// host path into a UI value.
#[derive(Debug, Error)]
pub enum BoundedScanError {
    #[error("session scan byte limit must be greater than zero")]
    InvalidByteLimit,
    #[error("session source is a symbolic link or reparse point")]
    Symlink,
    #[error("session source is not a regular file")]
    NotRegularFile,
    #[error("session source lacks a persisted identity and must be reindexed")]
    IdentityUnavailable,
    #[error("session source changed since it was indexed")]
    Changed,
    #[error("session content changed since it was indexed")]
    RevisionMismatch,
    #[error("session source exceeds the {limit}-byte limit")]
    FileTooLarge { limit: usize },
    #[error("cannot read session source")]
    Read(#[source] std::io::Error),
}

/// Re-scans a private session file through a bounded, read-only handle.
///
/// Unlike [`scan_file`], this API accepts only an indexed [`HostSessionFile`].
/// It opens the file with no-follow/reparse protection where the platform
/// provides it, compares opened-handle identity to the persisted identity,
/// caps the actual read at `max_bytes + 1`, and verifies the newly read content
/// hash against the persisted revision. No repair, rename, truncate, or other
/// write is performed.
pub fn scan_file_bounded(
    session_file: &HostSessionFile,
    max_bytes: usize,
) -> Result<ScanReport, BoundedScanError> {
    scan_file_bounded_with_revision_policy(session_file, max_bytes, true, false, None)
}

/// Internal result of a bounded, identity-bound streaming hash verification.
/// The prefix is retained only for canonical LF-header attribution; it never
/// crosses the trusted-host API boundary.
struct BoundedHashVerification {
    header_prefix: Vec<u8>,
}

/// Streams a bounded source through SHA-256 without allocating or parsing its
/// JSONL body. The opened handle, pre/post metadata, and final path identity
/// must all remain stable before success is returned.
fn verify_bound_file_revision_streaming(
    session_file: &HostSessionFile,
    max_bytes: usize,
    expected_revision: &str,
) -> Result<BoundedHashVerification, BoundedScanError> {
    if max_bytes == 0 || max_bytes == usize::MAX {
        return Err(BoundedScanError::InvalidByteLimit);
    }
    let expected_identity = session_file
        .expected_identity
        .as_ref()
        .ok_or(BoundedScanError::IdentityUnavailable)?;
    let (mut file, opened_identity) = open_session_file_no_follow(session_file.as_path())?;
    if &opened_identity != expected_identity {
        return Err(BoundedScanError::Changed);
    }
    let before = file.metadata().map_err(BoundedScanError::Read)?;
    if before.len() > max_bytes as u64 {
        return Err(BoundedScanError::FileTooLarge { limit: max_bytes });
    }

    let mut hasher = Sha256::new();
    let mut header_prefix = Vec::with_capacity(DISCOVERY_HEADER_PREFIX_BYTES.min(max_bytes));
    let mut total = 0_usize;
    let mut buffer = [0_u8; 64 * 1024];
    {
        let mut limited = file.by_ref().take((max_bytes + 1) as u64);
        loop {
            let read = limited.read(&mut buffer).map_err(BoundedScanError::Read)?;
            if read == 0 {
                break;
            }
            total = total.saturating_add(read);
            hasher.update(&buffer[..read]);
            let remaining_prefix =
                DISCOVERY_HEADER_PREFIX_BYTES.saturating_sub(header_prefix.len());
            if remaining_prefix > 0 {
                header_prefix.extend_from_slice(&buffer[..read.min(remaining_prefix)]);
            }
        }
    }
    if total > max_bytes {
        return Err(BoundedScanError::FileTooLarge { limit: max_bytes });
    }

    let after = file.metadata().map_err(BoundedScanError::Read)?;
    let (final_file, final_identity) = open_session_file_no_follow(session_file.as_path())?;
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    if opened_identity != final_identity
        || before.len() != total as u64
        || before.len() != after.len()
        || before.len() != final_metadata.len()
        || before.modified().ok() != after.modified().ok()
        || before.modified().ok() != final_metadata.modified().ok()
    {
        return Err(BoundedScanError::Changed);
    }
    if format!("{:x}", hasher.finalize()) != expected_revision {
        return Err(BoundedScanError::RevisionMismatch);
    }
    Ok(BoundedHashVerification { header_prefix })
}

/// Safe failures from the host-only timeline-cache revision verifier. These
/// errors reveal neither source bytes nor private filesystem paths.
#[derive(Debug, Error)]
pub enum ProjectRevisionVerificationError {
    #[error("{0}")]
    File(#[from] BoundedScanError),
    #[error("requested project directory is unavailable")]
    ProjectUnavailable,
    #[error("session header does not belong to the requested project")]
    HeaderProjectMismatch,
}

/// Verifies an already identity-bound session against a trusted expected
/// revision without parsing or returning its full JSONL content. The bounded
/// LF-only header must canonically attribute the source to `project_directory`.
/// This is suitable for invalidating a cached timeline before it is reused.
pub fn verify_project_file_revision_bounded(
    session_file: &HostSessionFile,
    project_directory: impl AsRef<Path>,
    max_bytes: usize,
    expected_revision: &str,
) -> Result<(), ProjectRevisionVerificationError> {
    let canonical_project = fs::canonicalize(project_directory)
        .map_err(|_| ProjectRevisionVerificationError::ProjectUnavailable)?;
    if !canonical_project.is_dir() {
        return Err(ProjectRevisionVerificationError::ProjectUnavailable);
    }
    let verification =
        verify_bound_file_revision_streaming(session_file, max_bytes, expected_revision)?;
    let source_name = session_file
        .as_path()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let header = scan_bytes(source_name, &verification.header_prefix);
    if !report_matches_project(&header, &canonical_project) {
        return Err(ProjectRevisionVerificationError::HeaderProjectMismatch);
    }
    Ok(())
}

/// Shared no-follow, native-identity, bounded-read implementation for strict
/// rendering rescans and non-persisting observations. `require_revision` is
/// the only behavioral difference: both paths authenticate the opened and
/// final path identities before returning a parsed report.
fn scan_file_bounded_with_revision_policy(
    session_file: &HostSessionFile,
    max_bytes: usize,
    require_revision: bool,
    display_detail: bool,
    display_project_root: Option<&Path>,
) -> Result<ScanReport, BoundedScanError> {
    if max_bytes == 0 || max_bytes == usize::MAX {
        return Err(BoundedScanError::InvalidByteLimit);
    }
    let expected_identity = session_file
        .expected_identity
        .as_ref()
        .ok_or(BoundedScanError::IdentityUnavailable)?;
    let expected_revision = if require_revision {
        Some(
            session_file
                .expected_revision
                .as_deref()
                .ok_or(BoundedScanError::IdentityUnavailable)?,
        )
    } else {
        None
    };

    let (file, opened_identity) = open_session_file_no_follow(session_file.as_path())?;
    if &opened_identity != expected_identity {
        return Err(BoundedScanError::Changed);
    }
    let opened_metadata = file.metadata().map_err(BoundedScanError::Read)?;
    if opened_metadata.len() > max_bytes as u64 {
        return Err(BoundedScanError::FileTooLarge { limit: max_bytes });
    }

    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(BoundedScanError::Read)?;
    if bytes.len() > max_bytes {
        return Err(BoundedScanError::FileTooLarge { limit: max_bytes });
    }

    let source_name = session_file
        .as_path()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let mut report = if display_detail {
        scan_bytes_for_display_with_root(source_name, &bytes, display_project_root)
    } else {
        scan_bytes(source_name, &bytes)
    };
    if expected_revision.is_some_and(|revision| report.file_revision != revision) {
        return Err(BoundedScanError::RevisionMismatch);
    }

    // Re-open by path to reject a post-open replacement before returning the
    // report. The handle used for bytes above was already identity-checked.
    let (final_file, final_identity) = open_session_file_no_follow(session_file.as_path())?;
    if &final_identity != expected_identity {
        return Err(BoundedScanError::Changed);
    }
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    let opened_modified = opened_metadata.modified().ok();
    let final_modified = final_metadata.modified().ok();
    if final_metadata.len() != bytes.len() as u64
        || (opened_modified.is_some() && final_modified != opened_modified)
    {
        return Err(BoundedScanError::Changed);
    }
    report.source_modified = final_modified;
    Ok(report)
}

fn capture_session_file_identity(path: &Path) -> Result<PlatformFileIdentity, IndexError> {
    let (_, identity) =
        open_session_file_no_follow(path).map_err(|_| IndexError::SessionIdentityUnavailable)?;
    Ok(identity)
}

#[cfg(unix)]
fn open_session_file_no_follow(
    path: &Path,
) -> Result<(fs::File, PlatformFileIdentity), BoundedScanError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let path_metadata = fs::symlink_metadata(path).map_err(BoundedScanError::Read)?;
    if path_metadata.file_type().is_symlink() {
        return Err(BoundedScanError::Symlink);
    }
    if !path_metadata.is_file() {
        return Err(BoundedScanError::NotRegularFile);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(BoundedScanError::Read)?;
    let metadata = file.metadata().map_err(BoundedScanError::Read)?;
    if !metadata.is_file() {
        return Err(BoundedScanError::NotRegularFile);
    }
    Ok((
        file,
        PlatformFileIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    ))
}

#[cfg(windows)]
fn open_session_file_no_follow(
    path: &Path,
) -> Result<(fs::File, PlatformFileIdentity), BoundedScanError> {
    use std::mem::MaybeUninit;
    use std::os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, RawHandle},
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        OPEN_EXISTING,
    };

    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // FILE_FLAG_OPEN_REPARSE_POINT opens the reparse object itself. We inspect
    // its attributes before converting ownership into a read-only Rust file.
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(BoundedScanError::Read(std::io::Error::last_os_error()));
    }
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let information_ok = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
    if information_ok == 0 {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(handle) };
        return Err(BoundedScanError::Read(error));
    }
    let information = unsafe { information.assume_init() };
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        unsafe { CloseHandle(handle) };
        return Err(BoundedScanError::Symlink);
    }
    let file = unsafe { fs::File::from_raw_handle(handle as RawHandle) };
    let metadata = file.metadata().map_err(BoundedScanError::Read)?;
    if !metadata.is_file() {
        return Err(BoundedScanError::NotRegularFile);
    }
    Ok((
        file,
        PlatformFileIdentity::Windows {
            volume_serial: information.dwVolumeSerialNumber,
            file_index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        },
    ))
}

#[cfg(not(any(unix, windows)))]
fn open_session_file_no_follow(
    _path: &Path,
) -> Result<(fs::File, PlatformFileIdentity), BoundedScanError> {
    Err(BoundedScanError::IdentityUnavailable)
}

/// Safe failures from the project-bound trusted-host rescan API.
#[derive(Debug, Error)]
pub enum ProjectBoundedScanError {
    #[error("{0}")]
    File(#[from] BoundedScanError),
    #[error("requested project directory is unavailable")]
    ProjectUnavailable,
    #[error("session header does not belong to the requested project")]
    HeaderProjectMismatch,
}

/// Re-scans a discovered/indexed session only if its file identity and content
/// revision remain stable and its header CWD canonically resolves to the
/// supplied project. This is the strict host API for rendering an indexed
/// session; it exposes no raw filesystem path in errors and never writes.
pub fn scan_project_file_bounded(
    session_file: &HostSessionFile,
    project_directory: impl AsRef<Path>,
    max_bytes: usize,
) -> Result<ScanReport, ProjectBoundedScanError> {
    scan_project_file_with_revision_policy(
        session_file,
        project_directory.as_ref(),
        max_bytes,
        true,
        false,
    )
}

/// Observes the current contents of an indexed session without updating SQLite.
/// Content may have changed since indexing, but the opened and final file
/// identities must still match the persisted native identity, and the bounded
/// parsed header must still canonically belong to the requested project. This
/// read-only API never writes or deletes JSONL files.
pub fn observe_project_file_bounded(
    session_file: &HostSessionFile,
    project_directory: impl AsRef<Path>,
    max_bytes: usize,
) -> Result<ScanReport, ProjectBoundedScanError> {
    scan_project_file_with_revision_policy(
        session_file,
        project_directory.as_ref(),
        max_bytes,
        false,
        true,
    )
}

fn scan_project_file_with_revision_policy(
    session_file: &HostSessionFile,
    project_directory: &Path,
    max_bytes: usize,
    require_revision: bool,
    display_detail: bool,
) -> Result<ScanReport, ProjectBoundedScanError> {
    let canonical_project = fs::canonicalize(project_directory)
        .map_err(|_| ProjectBoundedScanError::ProjectUnavailable)?;
    if !canonical_project.is_dir() {
        return Err(ProjectBoundedScanError::ProjectUnavailable);
    }
    let report = scan_file_bounded_with_revision_policy(
        session_file,
        max_bytes,
        require_revision,
        display_detail,
        display_detail.then_some(canonical_project.as_path()),
    )?;
    if !report_matches_project(&report, &canonical_project) {
        return Err(ProjectBoundedScanError::HeaderProjectMismatch);
    }
    Ok(report)
}

/// Resource limits for explicit session-root discovery. `max_depth = 0` scans
/// files directly in a root but does not recurse into its child directories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionDiscoveryLimits {
    pub max_files: usize,
    pub max_directories: usize,
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_file_bytes: usize,
}

impl Default for SessionDiscoveryLimits {
    fn default() -> Self {
        Self {
            max_files: 1_000,
            max_directories: 256,
            max_entries: 10_000,
            max_depth: 8,
            max_file_bytes: 128 * 1024 * 1024,
        }
    }
}

/// Aggregate-only discovery outcomes. No filesystem paths or raw content are
/// exposed here, making it safe to use for host diagnostics counts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SessionDiscoveryStats {
    pub visited_directories: usize,
    pub examined_entries: usize,
    pub scanned_files: usize,
    pub matched_files: usize,
    pub skipped_symlinks: usize,
    pub skipped_oversize_files: usize,
    pub skipped_depth_directories: usize,
    pub skipped_inaccessible_entries: usize,
    /// Readable JSONL candidates with no usable, canonical project CWD. These
    /// may be a temporarily truncated previously indexed session, so sweeping
    /// must wait for a later complete pass.
    pub unattributable_candidates: usize,
    pub skipped_duplicate_candidates: usize,
    /// Candidates that required a full JSONL projection pass.
    pub full_content_scans: usize,
    /// Catalog-matched candidates whose full JSONL projection was safely skipped.
    pub unchanged_sources: usize,
    pub directory_limit_reached: bool,
    pub entry_limit_reached: bool,
    pub file_limit_reached: bool,
}

impl SessionDiscoveryStats {
    /// Whether discovery observed every eligible candidate without a condition
    /// that could hide a previously indexed session. Duplicate candidates are
    /// harmless; all bounds and filesystem-access skips fail closed.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        !self.directory_limit_reached
            && !self.entry_limit_reached
            && !self.file_limit_reached
            && self.skipped_symlinks == 0
            && self.skipped_oversize_files == 0
            && self.skipped_depth_directories == 0
            && self.skipped_inaccessible_entries == 0
            && self.unattributable_candidates == 0
    }
}

/// A matched session's scanner report plus its private host rescan capability.
/// This type deliberately has no serde implementation.
pub struct DiscoveredSession {
    pub file: HostSessionFile,
    pub report: ScanReport,
    fingerprint: SourceFingerprint,
    /// Only discovery can mint this marker. Catalog reports deliberately omit
    /// topology, so persistence must keep branch count unknown.
    catalog_only: bool,
}

/// Opaque result of full outside-lock source verification. It has no path or
/// content accessors and can only be committed by [`ProjectIndex`].
pub struct VerifiedDiscoveredSessionBatch {
    sessions: Vec<DiscoveredSession>,
}

/// Safe, path-free outcome of one atomic project discovery commit.
pub struct VerifiedDiscoveryBatchCommit {
    pub sessions: Vec<SessionSummary>,
    pub unchanged_sources_marked: usize,
    pub swept_sessions: usize,
    /// True only when every root candidate was covered and every weak
    /// unchanged observation passed its transactional CAS check.
    pub complete: bool,
}

/// Host-private persisted evidence for a discovered catalog source. It has no
/// serialization or path accessor; callers can only hand it back to discovery.
pub struct CatalogSourceFingerprint {
    session_id: String,
    path: PathBuf,
    fingerprint: SourceFingerprint,
}

/// A safely re-observed catalog source. It is intentionally opaque: it can be
/// supplied to [`ProjectIndex::mark_unchanged_sources_seen`] but reveals no
/// path, source content, or filesystem identity.
pub struct UnchangedSourceObservation {
    session_id: String,
    fingerprint: SourceFingerprint,
}

/// Incremental discovery returns newly/full-scanned sessions separately from
/// catalog sources whose weak continuity evidence still matches.
pub struct IncrementalSessionDiscovery {
    pub sessions: Vec<DiscoveredSession>,
    pub unchanged_sources: Vec<UnchangedSourceObservation>,
    pub stats: SessionDiscoveryStats,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFingerprint {
    identity: PlatformFileIdentity,
    length: u64,
    modified_stamp: Option<i64>,
    continuity_digest: String,
    parser_version: i64,
}

/// Result of a bounded, non-mutating discovery pass. Only known session files
/// whose header CWD canonically equals the requested project are included.
pub struct SessionDiscovery {
    pub sessions: Vec<DiscoveredSession>,
    pub stats: SessionDiscoveryStats,
}

#[derive(Debug, Error, Clone, Copy, Eq, PartialEq)]
pub enum DiscoveryError {
    #[error("session discovery limits are invalid")]
    InvalidLimits,
    #[error("project directory is unavailable for session discovery")]
    ProjectUnavailable,
}

/// Performs all expensive no-follow evidence and full streamed-revision checks
/// before the host acquires its SQLite/index mutex. A failed source rejects the
/// entire batch; callers must rediscover rather than committing a partial set.
pub fn verify_discovered_sessions_batch(
    sessions: Vec<DiscoveredSession>,
) -> Result<VerifiedDiscoveredSessionBatch, IndexError> {
    let sessions = sessions
        .into_iter()
        .map(verify_discovered_session)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(VerifiedDiscoveredSessionBatch { sessions })
}

/// Discover sessions below explicit roots without following filesystem
/// symlinks. It reads only regular `.jsonl` candidates within the supplied
/// bounds, never opens auth/config filenames, and does not write to any path.
///
/// The project directory is canonicalized once for identity. A candidate is
/// returned only when the existing scanner found an absolute header `cwd` that
/// canonicalizes to that exact directory. Malformed and future-format files
/// are tolerated: they are either represented by a non-healthy `ScanReport`
/// (when their header still matches) or ignored without failing the pass.
pub fn discover_sessions_for_project(
    session_roots: &[PathBuf],
    project_directory: impl AsRef<Path>,
    limits: SessionDiscoveryLimits,
) -> Result<SessionDiscovery, DiscoveryError> {
    let incremental =
        discover_sessions_for_project_incremental(session_roots, project_directory, limits, &[])?;
    Ok(SessionDiscovery {
        sessions: incremental.sessions,
        stats: incremental.stats,
    })
}

/// Discovers project sessions while allowing a host-private catalog to avoid
/// repeating a full JSONL projection for a stably observed source. Every
/// candidate is still opened no-follow, identity checked, and its bounded
/// header is parsed to confirm canonical project attribution. Length, mtime,
/// and bounded continuity evidence are weak cache evidence only: a same-size,
/// same-mtime rewrite must never be used as a rendering or mutation proof.
pub fn discover_sessions_for_project_incremental(
    session_roots: &[PathBuf],
    project_directory: impl AsRef<Path>,
    limits: SessionDiscoveryLimits,
    known_sources: &[CatalogSourceFingerprint],
) -> Result<IncrementalSessionDiscovery, DiscoveryError> {
    if limits.max_files == 0
        || limits.max_directories == 0
        || limits.max_entries == 0
        || limits.max_file_bytes == 0
        || limits.max_file_bytes == usize::MAX
    {
        return Err(DiscoveryError::InvalidLimits);
    }

    let canonical_project = fs::canonicalize(project_directory.as_ref())
        .map_err(|_| DiscoveryError::ProjectUnavailable)?;
    if !canonical_project.is_dir() {
        return Err(DiscoveryError::ProjectUnavailable);
    }
    let known_by_path: HashMap<&Path, &CatalogSourceFingerprint> = known_sources
        .iter()
        .map(|source| (source.path.as_path(), source))
        .collect();

    let mut stats = SessionDiscoveryStats::default();
    let mut sessions = Vec::new();
    let mut unchanged_sources = Vec::new();
    let mut pending = VecDeque::new();
    let mut scheduled_directories = 0_usize;
    for root in session_roots {
        if scheduled_directories >= limits.max_directories {
            stats.directory_limit_reached = true;
            break;
        }
        pending.push_back((root.clone(), 0_usize));
        scheduled_directories += 1;
    }
    let mut seen_candidates = BTreeSet::new();

    'walk: while let Some((directory, depth)) = pending.pop_front() {
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(_) => {
                stats.skipped_inaccessible_entries =
                    stats.skipped_inaccessible_entries.saturating_add(1);
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            stats.skipped_symlinks = stats.skipped_symlinks.saturating_add(1);
            continue;
        }
        if !metadata.is_dir() {
            stats.skipped_inaccessible_entries =
                stats.skipped_inaccessible_entries.saturating_add(1);
            continue;
        }
        stats.visited_directories = stats.visited_directories.saturating_add(1);
        let mut entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                stats.skipped_inaccessible_entries =
                    stats.skipped_inaccessible_entries.saturating_add(1);
                continue;
            }
        };
        loop {
            if stats.examined_entries >= limits.max_entries {
                stats.entry_limit_reached = true;
                break 'walk;
            }
            let Some(entry) = entries.next() else {
                break;
            };
            stats.examined_entries = stats.examined_entries.saturating_add(1);
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    stats.skipped_inaccessible_entries =
                        stats.skipped_inaccessible_entries.saturating_add(1);
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    stats.skipped_inaccessible_entries =
                        stats.skipped_inaccessible_entries.saturating_add(1);
                    continue;
                }
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                stats.skipped_symlinks = stats.skipped_symlinks.saturating_add(1);
                continue;
            }
            if metadata.is_dir() {
                if depth >= limits.max_depth {
                    stats.skipped_depth_directories =
                        stats.skipped_depth_directories.saturating_add(1);
                } else if scheduled_directories >= limits.max_directories {
                    stats.directory_limit_reached = true;
                } else {
                    pending.push_back((path, depth + 1));
                    scheduled_directories += 1;
                }
                continue;
            }
            if !metadata.is_file() || !is_session_jsonl(&path) {
                continue;
            }
            if !seen_candidates.insert(path.clone()) {
                stats.skipped_duplicate_candidates =
                    stats.skipped_duplicate_candidates.saturating_add(1);
                continue;
            }
            if stats.scanned_files >= limits.max_files {
                stats.file_limit_reached = true;
                break 'walk;
            }
            stats.scanned_files = stats.scanned_files.saturating_add(1);
            if metadata.len() > limits.max_file_bytes as u64 {
                stats.skipped_oversize_files = stats.skipped_oversize_files.saturating_add(1);
                continue;
            }

            let evidence = match read_discovery_evidence(&path, limits.max_file_bytes) {
                Ok(evidence) => evidence,
                Err(BoundedScanError::FileTooLarge { .. }) => {
                    stats.skipped_oversize_files = stats.skipped_oversize_files.saturating_add(1);
                    continue;
                }
                Err(BoundedScanError::Symlink) => {
                    stats.skipped_symlinks = stats.skipped_symlinks.saturating_add(1);
                    continue;
                }
                Err(_) => {
                    stats.skipped_inaccessible_entries =
                        stats.skipped_inaccessible_entries.saturating_add(1);
                    continue;
                }
            };
            let source_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("session.jsonl");
            let header_report = scan_bytes(source_name, &evidence.header_prefix);
            if classify_report_project(&header_report, &canonical_project)
                == CandidateProjectAttribution::OtherProject
            {
                continue;
            }
            // Header attribution is mandatory even on the fast path. An
            // incomplete/malformed header remains ambiguous and is fully read.
            if classify_report_project(&header_report, &canonical_project)
                == CandidateProjectAttribution::MatchesRequestedProject
            {
                if let Some(known) = known_by_path.get(path.as_path()) {
                    if known.fingerprint == evidence.fingerprint {
                        stats.matched_files = stats.matched_files.saturating_add(1);
                        stats.unchanged_sources = stats.unchanged_sources.saturating_add(1);
                        unchanged_sources.push(UnchangedSourceObservation {
                            session_id: known.session_id.clone(),
                            fingerprint: evidence.fingerprint,
                        });
                        continue;
                    }
                }
            }

            let verified = match read_discovery_catalog(&path, source_name, limits.max_file_bytes) {
                Ok(verified) => verified,
                Err(BoundedScanError::FileTooLarge { .. }) => {
                    stats.skipped_oversize_files = stats.skipped_oversize_files.saturating_add(1);
                    continue;
                }
                Err(BoundedScanError::Symlink) => {
                    stats.skipped_symlinks = stats.skipped_symlinks.saturating_add(1);
                    continue;
                }
                Err(_) => {
                    stats.skipped_inaccessible_entries =
                        stats.skipped_inaccessible_entries.saturating_add(1);
                    continue;
                }
            };
            stats.full_content_scans = stats.full_content_scans.saturating_add(1);
            let report = verified.report;
            match classify_report_project(&report, &canonical_project) {
                CandidateProjectAttribution::MatchesRequestedProject => {
                    stats.matched_files = stats.matched_files.saturating_add(1);
                    sessions.push(DiscoveredSession {
                        file: HostSessionFile::from_verified(
                            path,
                            verified.fingerprint.identity.clone(),
                            report.file_revision.clone(),
                            limits.max_file_bytes,
                        ),
                        report,
                        fingerprint: verified.fingerprint,
                        catalog_only: true,
                    });
                }
                CandidateProjectAttribution::OtherProject => {}
                CandidateProjectAttribution::Unattributable => {
                    stats.unattributable_candidates =
                        stats.unattributable_candidates.saturating_add(1);
                }
            }
        }
    }

    Ok(IncrementalSessionDiscovery {
        sessions,
        unchanged_sources,
        stats,
    })
}

fn is_session_jsonl(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let protected_name = matches!(
        name.to_ascii_lowercase().as_str(),
        "auth.jsonl" | "config.jsonl" | "settings.jsonl"
    );
    !protected_name
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
}

struct DiscoveryEvidence {
    header_prefix: Vec<u8>,
    fingerprint: SourceFingerprint,
}

fn metadata_stamp(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .try_into()
        .ok()
}

fn continuity_digest(prefix: &[u8], tail: &[u8], length: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"piui-discovery-continuity-v1\\0");
    digest.update(length.to_le_bytes());
    digest.update((prefix.len() as u64).to_le_bytes());
    digest.update(prefix);
    digest.update((tail.len() as u64).to_le_bytes());
    digest.update(tail);
    format!("{:x}", digest.finalize())
}

/// Reads bounded header and tail evidence from one no-follow handle, then
/// validates unchanged metadata and final path identity before returning it.
fn read_discovery_evidence(
    path: &Path,
    max_file_bytes: usize,
) -> Result<DiscoveryEvidence, BoundedScanError> {
    let (mut file, identity) = open_session_file_no_follow(path)?;
    let before = file.metadata().map_err(BoundedScanError::Read)?;
    if before.len() > max_file_bytes as u64 {
        return Err(BoundedScanError::FileTooLarge {
            limit: max_file_bytes,
        });
    }
    let prefix_len = usize::try_from(before.len())
        .unwrap_or(usize::MAX)
        .min(DISCOVERY_HEADER_PREFIX_BYTES);
    let mut header_prefix = Vec::with_capacity(prefix_len);
    file.by_ref()
        .take(prefix_len as u64)
        .read_to_end(&mut header_prefix)
        .map_err(BoundedScanError::Read)?;
    let tail_len = usize::try_from(before.len())
        .unwrap_or(usize::MAX)
        .min(DISCOVERY_TAIL_EVIDENCE_BYTES);
    let mut tail = Vec::with_capacity(tail_len);
    if tail_len > 0 {
        file.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(BoundedScanError::Read)?;
        file.by_ref()
            .take(tail_len as u64)
            .read_to_end(&mut tail)
            .map_err(BoundedScanError::Read)?;
    }
    let after = file.metadata().map_err(BoundedScanError::Read)?;
    let (final_file, final_identity) = open_session_file_no_follow(path)?;
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    if identity != final_identity
        || before.len() != after.len()
        || before.len() != final_metadata.len()
        || metadata_stamp(&before) != metadata_stamp(&after)
        || metadata_stamp(&before) != metadata_stamp(&final_metadata)
    {
        return Err(BoundedScanError::Changed);
    }
    let modified_stamp = metadata_stamp(&before);
    let continuity_digest = continuity_digest(&header_prefix, &tail, before.len());
    Ok(DiscoveryEvidence {
        header_prefix,
        fingerprint: SourceFingerprint {
            identity,
            length: before.len(),
            modified_stamp,
            continuity_digest,
            parser_version: DISCOVERY_FINGERPRINT_PARSER_VERSION,
        },
    })
}

struct VerifiedCatalogFile {
    report: ScanReport,
    fingerprint: SourceFingerprint,
}

#[derive(Default)]
struct CatalogAccumulator {
    diagnostics: Vec<Diagnostic>,
    unknown_entries: Vec<UnknownEntrySummary>,
    saw_unknown: bool,
    pi_session_id: Option<String>,
    session_name: Option<String>,
    project_cwd: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    first_user_preview: Option<String>,
    last_message_preview: Option<String>,
    last_model: Option<String>,
    entry_count: usize,
    image_entry_count: usize,
    compaction_entry_count: usize,
}

impl CatalogAccumulator {
    fn diagnostic(&mut self, code: &str, line: u64, detail: String) {
        if self.diagnostics.len() < CATALOG_DIAGNOSTIC_LIMIT {
            self.diagnostics.push(Diagnostic {
                code: code.into(),
                line,
                detail,
            });
        }
    }

    fn oversized_frame(&mut self, line: u64) {
        self.diagnostic("frame-too-large", line, "ignored".into());
    }

    fn frame(&mut self, line: u64, frame: &[u8]) {
        if frame.is_empty() {
            self.diagnostic("empty-frame", line, "ignored".into());
            return;
        }
        let decoded = match std::str::from_utf8(frame) {
            Ok(value) => value,
            Err(error) => {
                self.diagnostic(
                    "invalid-utf8",
                    line,
                    format!("byte {}", error.valid_up_to()),
                );
                return;
            }
        };
        let value: Value = match serde_json::from_str(decoded) {
            Ok(value) => value,
            Err(error) => {
                self.diagnostic("malformed-json", line, format!("column {}", error.column()));
                return;
            }
        };
        let Some(object) = value.as_object() else {
            self.diagnostic("non-object-entry", line, "ignored".into());
            return;
        };
        let entry_type =
            string_field(object, &["type", "entryType"]).unwrap_or_else(|| "missing-type".into());
        let known = KNOWN_TYPES.contains(&entry_type.as_str());
        if !known {
            self.saw_unknown = true;
            if self.unknown_entries.len() < CATALOG_UNKNOWN_ENTRY_LIMIT {
                self.unknown_entries.push(UnknownEntrySummary {
                    line,
                    entry_type: safe_text(&entry_type, TYPE_LIMIT),
                    byte_length: frame.len(),
                    sha256: sha256(frame),
                });
            }
        }
        if matches!(
            entry_type.as_str(),
            "session" | "session_meta" | "session_info"
        ) {
            let id_keys: &[&str] = if matches!(entry_type.as_str(), "session" | "session_meta") {
                &["sessionId", "session_id", "id"]
            } else {
                &["sessionId", "session_id"]
            };
            self.pi_session_id = string_field(object, id_keys).or(self.pi_session_id.take());
            self.session_name = string_field(object, &["name", "sessionName", "title"])
                .or(self.session_name.take());
            match header_cwd_field(object) {
                Ok(Some(cwd)) => self.project_cwd = Some(cwd),
                Ok(None) => {}
                Err(()) => self.diagnostic("header-cwd-too-long", line, "ignored".into()),
            }
            self.created_at = string_field(object, &["createdAt", "created_at", "timestamp"])
                .or(self.created_at.take());
            self.last_model =
                string_field(object, &["model", "modelId", "model_id"]).or(self.last_model.take());
        }
        if matches!(entry_type.as_str(), "session" | "session_meta") {
            return;
        }
        // Reuse the scanner's bounded field extraction without retaining the
        // entry or any topology. `order` is intentionally irrelevant here.
        let entry = entry_from(object, line, 0, known, entry_type);
        self.entry_count = self.entry_count.saturating_add(1);
        self.image_entry_count = self
            .image_entry_count
            .saturating_add(usize::from(entry.has_image));
        self.compaction_entry_count = self
            .compaction_entry_count
            .saturating_add(usize::from(entry.entry_type == "compaction"));
        self.last_model = entry.model_ref.or(self.last_model.take());
        if self.first_user_preview.is_none() && entry.role.as_deref() == Some("user") {
            self.first_user_preview = entry.preview.clone();
        }
        if matches!(entry.role.as_deref(), Some("user" | "assistant")) {
            if let Some(preview) = entry.preview {
                self.last_message_preview = Some(preview);
            }
        }
        if let Some(timestamp) = entry.created_at {
            self.updated_at = Some(timestamp);
        }
    }

    fn into_report(
        self,
        source_name: &str,
        file_revision: String,
        complete_bytes: usize,
        partial_tail_bytes: usize,
    ) -> ScanReport {
        let parse_state = if self.diagnostics.is_empty() {
            if partial_tail_bytes > 0 {
                ParseState::Partial
            } else if self.saw_unknown {
                ParseState::Unsupported
            } else {
                ParseState::Healthy
            }
        } else {
            ParseState::Corrupt
        };
        ScanReport {
            source_name: safe_text(source_name, TYPE_LIMIT),
            file_revision,
            source_modified: None,
            complete_bytes,
            partial_tail_bytes,
            parse_state,
            pi_session_id: self.pi_session_id,
            session_name: self.session_name,
            project_cwd: self.project_cwd,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.or(self.created_at),
            first_user_preview: self.first_user_preview,
            last_message_preview: self.last_message_preview,
            model_ref: self.last_model,
            entry_count: self.entry_count,
            image_entry_count: self.image_entry_count,
            compaction_entry_count: self.compaction_entry_count,
            branch_count: 0,
            current_leaf_id: None,
            roots: Vec::new(),
            orphan_ids: Vec::new(),
            cycle_ids: Vec::new(),
            unknown_entries: self.unknown_entries,
            diagnostics: self.diagnostics,
            entries: Vec::new(),
            tree: Vec::new(),
            timeline_blocks: Vec::new(),
        }
    }
}

/// Streams a complete discovery candidate into a sidebar-only catalog. It
/// retains at most one 1 MiB frame plus fixed prefix/tail evidence, never a
/// complete file, entry list, tree, or timeline projection.
fn read_discovery_catalog(
    path: &Path,
    source_name: &str,
    max_file_bytes: usize,
) -> Result<VerifiedCatalogFile, BoundedScanError> {
    let (mut file, identity) = open_session_file_no_follow(path)?;
    let before = file.metadata().map_err(BoundedScanError::Read)?;
    if before.len() > max_file_bytes as u64 {
        return Err(BoundedScanError::FileTooLarge {
            limit: max_file_bytes,
        });
    }

    let mut hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(DISCOVERY_HEADER_PREFIX_BYTES);
    let mut tail = VecDeque::with_capacity(DISCOVERY_TAIL_EVIDENCE_BYTES);
    let mut frame = Vec::with_capacity(CATALOG_FRAME_MAX_BYTES.min(64 * 1024));
    let mut frame_too_large = false;
    let mut catalog = CatalogAccumulator::default();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_usize;
    let mut tail_bytes = 0_usize;
    let mut line = 1_u64;
    {
        let mut limited = file.by_ref().take((max_file_bytes + 1) as u64);
        loop {
            let read = limited.read(&mut buffer).map_err(BoundedScanError::Read)?;
            if read == 0 {
                break;
            }
            total = total.saturating_add(read);
            hasher.update(&buffer[..read]);
            for byte in &buffer[..read] {
                if prefix.len() < DISCOVERY_HEADER_PREFIX_BYTES {
                    prefix.push(*byte);
                }
                if tail.len() == DISCOVERY_TAIL_EVIDENCE_BYTES {
                    tail.pop_front();
                }
                tail.push_back(*byte);
                if *byte == b'\n' {
                    if frame_too_large {
                        catalog.oversized_frame(line);
                    } else {
                        catalog.frame(line, &frame);
                    }
                    frame.clear();
                    frame_too_large = false;
                    tail_bytes = 0;
                    line = line.saturating_add(1);
                } else {
                    tail_bytes = tail_bytes.saturating_add(1);
                    if !frame_too_large {
                        if frame.len() < CATALOG_FRAME_MAX_BYTES {
                            frame.push(*byte);
                        } else {
                            frame.clear();
                            frame_too_large = true;
                        }
                    }
                }
            }
        }
    }
    if total > max_file_bytes {
        return Err(BoundedScanError::FileTooLarge {
            limit: max_file_bytes,
        });
    }
    let after = file.metadata().map_err(BoundedScanError::Read)?;
    let (final_file, final_identity) = open_session_file_no_follow(path)?;
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    if identity != final_identity
        || before.len() != total as u64
        || before.len() != after.len()
        || before.len() != final_metadata.len()
        || metadata_stamp(&before) != metadata_stamp(&after)
        || metadata_stamp(&before) != metadata_stamp(&final_metadata)
    {
        return Err(BoundedScanError::Changed);
    }
    let tail = tail.into_iter().collect::<Vec<_>>();
    let fingerprint = SourceFingerprint {
        identity,
        length: total as u64,
        modified_stamp: metadata_stamp(&before),
        continuity_digest: continuity_digest(&prefix, &tail, total as u64),
        parser_version: DISCOVERY_FINGERPRINT_PARSER_VERSION,
    };
    let report = catalog.into_report(
        source_name,
        format!("{:x}", hasher.finalize()),
        total.saturating_sub(tail_bytes),
        tail_bytes,
    );
    Ok(VerifiedCatalogFile {
        report,
        fingerprint,
    })
}

fn report_matches_project(report: &ScanReport, canonical_project: &Path) -> bool {
    matches!(
        classify_report_project(report, canonical_project),
        CandidateProjectAttribution::MatchesRequestedProject
    )
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CandidateProjectAttribution {
    MatchesRequestedProject,
    OtherProject,
    Unattributable,
}

fn classify_report_project(
    report: &ScanReport,
    canonical_project: &Path,
) -> CandidateProjectAttribution {
    let Some(cwd) = report.project_cwd.as_deref() else {
        return CandidateProjectAttribution::Unattributable;
    };
    let cwd = Path::new(cwd);
    if !cwd.is_absolute() {
        return CandidateProjectAttribution::Unattributable;
    }
    match fs::canonicalize(cwd) {
        Ok(path) if path == canonical_project => {
            CandidateProjectAttribution::MatchesRequestedProject
        }
        Ok(_) => CandidateProjectAttribution::OtherProject,
        Err(_) => CandidateProjectAttribution::Unattributable,
    }
}

/// Scan in-memory bytes with the same LF-only rules as [`scan_file`]. This is
/// useful for watcher buffers and tests; it has no filesystem side effects.
pub fn scan_bytes(source_name: &str, bytes: &[u8]) -> ScanReport {
    let (frames, tail_start) = lf_frames(bytes);
    let mut diagnostics = Vec::new();
    let mut entries = Vec::new();
    let mut unknown_entries = Vec::new();
    let mut pi_session_id = None;
    let mut session_name = None;
    let mut project_cwd = None;
    let mut created_at = None;
    let mut last_model = None;
    let mut seen_entry_ids: HashMap<String, u64> = HashMap::new();

    for (line, frame) in frames {
        if frame.is_empty() {
            diagnostics.push(Diagnostic {
                code: "empty-frame".into(),
                line,
                detail: "ignored".into(),
            });
            continue;
        }
        let decoded = match std::str::from_utf8(frame) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(Diagnostic {
                    code: "invalid-utf8".into(),
                    line,
                    detail: format!("byte {}", error.valid_up_to()),
                });
                continue;
            }
        };
        let value: Value = match serde_json::from_str(decoded) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(Diagnostic {
                    code: "malformed-json".into(),
                    line,
                    detail: format!("column {}", error.column()),
                });
                continue;
            }
        };
        let Some(object) = value.as_object() else {
            diagnostics.push(Diagnostic {
                code: "non-object-entry".into(),
                line,
                detail: "ignored".into(),
            });
            continue;
        };

        let entry_type =
            string_field(object, &["type", "entryType"]).unwrap_or_else(|| "missing-type".into());
        let known = KNOWN_TYPES.contains(&entry_type.as_str());
        if !known {
            unknown_entries.push(UnknownEntrySummary {
                line,
                entry_type: safe_text(&entry_type, TYPE_LIMIT),
                byte_length: frame.len(),
                sha256: sha256(frame),
            });
        }

        if matches!(
            entry_type.as_str(),
            "session" | "session_meta" | "session_info"
        ) {
            let id_keys: &[&str] = if matches!(entry_type.as_str(), "session" | "session_meta") {
                &["sessionId", "session_id", "id"]
            } else {
                &["sessionId", "session_id"]
            };
            pi_session_id = string_field(object, id_keys).or(pi_session_id);
            session_name = string_field(object, &["name", "sessionName", "title"]).or(session_name);
            match header_cwd_field(object) {
                Ok(Some(cwd)) => project_cwd = Some(cwd),
                Ok(None) => {}
                Err(()) => diagnostics.push(Diagnostic {
                    code: "header-cwd-too-long".into(),
                    line,
                    detail: "ignored".into(),
                }),
            }
            created_at =
                string_field(object, &["createdAt", "created_at", "timestamp"]).or(created_at);
            last_model = string_field(object, &["model", "modelId", "model_id"]).or(last_model);
        }
        if matches!(entry_type.as_str(), "session" | "session_meta") {
            continue;
        }

        let entry = entry_from(object, line, entries.len(), known, entry_type);
        if let Some(entry_id) = &entry.entry_id {
            if let Some(first_line) = seen_entry_ids.get(entry_id) {
                diagnostics.push(Diagnostic {
                    code: "duplicate-entry-id".into(),
                    line,
                    detail: format!("first seen at line {first_line}"),
                });
            } else {
                seen_entry_ids.insert(entry_id.clone(), line);
            }
        }
        last_model = entry.model_ref.clone().or(last_model);
        entries.push(entry);
    }

    let tree_result = project_tree(&entries);
    diagnostics.extend(tree_result.diagnostics.iter().cloned());
    let first_user_preview = entries.iter().find_map(|entry| {
        (entry.role.as_deref() == Some("user"))
            .then(|| entry.preview.clone())
            .flatten()
    });
    let last_message_preview = entries.iter().rev().find_map(|entry| {
        matches!(entry.role.as_deref(), Some("user" | "assistant"))
            .then(|| entry.preview.clone())
            .flatten()
    });
    let parse_state = if diagnostics.is_empty() {
        if tail_start < bytes.len() {
            ParseState::Partial
        } else if unknown_entries.is_empty() {
            ParseState::Healthy
        } else {
            ParseState::Unsupported
        }
    } else {
        ParseState::Corrupt
    };
    let updated_at = entries
        .iter()
        .rev()
        .find_map(|entry| entry.created_at.clone())
        .or_else(|| created_at.clone());
    let timeline_blocks = generic_blocks(&entries);

    ScanReport {
        source_name: safe_text(source_name, TYPE_LIMIT),
        file_revision: sha256(bytes),
        source_modified: None,
        complete_bytes: tail_start,
        partial_tail_bytes: bytes.len().saturating_sub(tail_start),
        parse_state,
        pi_session_id,
        session_name,
        project_cwd,
        created_at,
        updated_at,
        first_user_preview,
        last_message_preview,
        model_ref: last_model,
        entry_count: entries.len(),
        image_entry_count: entries.iter().filter(|entry| entry.has_image).count(),
        compaction_entry_count: entries
            .iter()
            .filter(|entry| entry.entry_type == "compaction")
            .count(),
        branch_count: tree_result.branch_count,
        current_leaf_id: tree_result.current_leaf_id,
        roots: tree_result.roots,
        orphan_ids: tree_result.orphan_ids,
        cycle_ids: tree_result.cycle_ids,
        unknown_entries,
        diagnostics,
        entries,
        tree: tree_result.nodes,
        timeline_blocks,
    }
}

/// Splits only on byte `0x0A`; CR and Unicode separators remain frame data.
pub fn lf_frames(bytes: &[u8]) -> (Vec<(u64, &[u8])>, usize) {
    let mut frames = Vec::new();
    let mut start = 0;
    let mut line = 1;
    while let Some(relative_end) = bytes[start..].iter().position(|byte| *byte == b'\n') {
        let end = start + relative_end;
        frames.push((line, &bytes[start..end]));
        line += 1;
        start = end + 1;
    }
    (frames, start)
}

fn entry_from(
    object: &Map<String, Value>,
    line: u64,
    order: usize,
    known: bool,
    entry_type: String,
) -> IndexedEntry {
    let message = object.get("message").and_then(Value::as_object);
    let content = if known {
        message
            .and_then(|message| message.get("content"))
            .or_else(|| object.get("content"))
            .or_else(|| object.get("text"))
    } else {
        None
    };
    IndexedEntry {
        line,
        order,
        entry_id: string_field(object, &["entryId", "id"]),
        parent_id: string_field(object, &["parentId", "parent_id"]),
        entry_type: safe_text(&entry_type, TYPE_LIMIT),
        role: if known {
            message
                .and_then(|message| string_field(message, &["role"]))
                .or_else(|| string_field(object, &["role"]))
        } else {
            None
        },
        preview: content.and_then(preview),
        created_at: string_field(object, &["timestamp", "createdAt", "created_at"]),
        has_image: known
            && (content.is_some_and(content_has_image)
                || object.get("images").is_some_and(content_has_image)),
        model_ref: if known {
            string_field(object, &["model", "modelId", "model_id"])
        } else {
            None
        },
    }
}

/// The UI render path is deliberately separate from discovery/index scanning:
/// it parses only already bounded bytes and projects an allowlisted subset of
/// Pi v3 display content. Source IDs are used transiently for tool correlation
/// and never copied into a returned block.
#[cfg(test)]
fn scan_bytes_for_display(source_name: &str, bytes: &[u8]) -> ScanReport {
    scan_bytes_for_display_with_root(source_name, bytes, None)
}

fn scan_bytes_for_display_with_root(
    source_name: &str,
    bytes: &[u8],
    project_root: Option<&Path>,
) -> ScanReport {
    let mut report = scan_bytes(source_name, bytes);
    report.timeline_blocks = semantic_blocks(bytes, project_root);
    report
}

fn semantic_blocks(bytes: &[u8], project_root: Option<&Path>) -> Vec<GenericTimelineBlock> {
    let (frames, _) = lf_frames(bytes);
    let mut blocks = Vec::new();
    let mut tool_blocks: HashMap<String, usize> = HashMap::new();
    for (_, frame) in frames {
        let Ok(text) = std::str::from_utf8(frame) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let Some(entry) = value.as_object() else {
            continue;
        };
        let entry_type = string_field(entry, &["type", "entryType"]).unwrap_or_default();
        // These records are state/settings metadata, not timeline content.
        if matches!(
            entry_type.as_str(),
            "session"
                | "session_meta"
                | "session_info"
                | "model_change"
                | "thinking_level_change"
                | "label"
                | "branch_summary"
                | "custom"
        ) {
            continue;
        }
        let message = entry.get("message").and_then(Value::as_object);
        let role = message
            .and_then(|m| string_field(m, &["role"]))
            .or_else(|| string_field(entry, &["role"]));
        let created_at = string_field(entry, &["timestamp", "createdAt", "created_at"]);
        let content = message
            .and_then(|m| m.get("content"))
            .or_else(|| entry.get("content"))
            .or_else(|| entry.get("text"));
        let assistant_status = match message
            .and_then(|value| value.get("stopReason").or_else(|| value.get("stop_reason")))
            .and_then(Value::as_str)
        {
            Some("error") => GenericBlockStatus::Failed,
            Some("aborted") => GenericBlockStatus::Interrupted,
            _ => GenericBlockStatus::Complete,
        };
        let mut push = |kind,
                        source_type: &str,
                        title: Option<String>,
                        tool_name: Option<String>,
                        text: Option<String>,
                        collapsible,
                        fallback,
                        status| {
            let (preview, truncated) = bounded_display(text.as_deref(), display_limit(kind));
            let index = blocks.len();
            blocks.push(GenericTimelineBlock {
                id: timeline_block_id(index),
                parent_id: None,
                kind,
                source_type: safe_text(source_type, TYPE_LIMIT),
                created_at: created_at.clone(),
                preview,
                has_image: content.is_some_and(content_has_image),
                title,
                tool_name,
                collapsible,
                truncated,
                fallback,
                status,
            });
            index
        };

        if entry_type == "compaction" {
            push(
                GenericBlockKind::Compaction,
                "compaction",
                Some("Context compacted".into()),
                None,
                entry
                    .get("summary")
                    .or_else(|| message.and_then(|value| value.get("summary")))
                    .and_then(|value| display_content(Some(value)))
                    .or_else(|| display_content(content)),
                true,
                false,
                GenericBlockStatus::Complete,
            );
            continue;
        }
        if entry_type == "custom_message" {
            if entry
                .get("display")
                .or_else(|| message.and_then(|value| value.get("display")))
                .and_then(Value::as_bool)
                != Some(false)
            {
                push(
                    GenericBlockKind::Custom,
                    "custom_message",
                    Some("Extension message".into()),
                    None,
                    display_content(content),
                    true,
                    false,
                    GenericBlockStatus::Complete,
                );
            }
            continue;
        }
        let is_bash = entry_type == "bashExecution" || role.as_deref() == Some("bashExecution");
        if is_bash {
            let command = entry
                .get("command")
                .or_else(|| message.and_then(|value| value.get("command")))
                .or_else(|| {
                    content
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("command"))
                })
                .and_then(Value::as_str);
            let cancelled = entry
                .get("cancelled")
                .or_else(|| message.and_then(|value| value.get("cancelled")))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let source_truncated = entry
                .get("truncated")
                .or_else(|| message.and_then(|value| value.get("truncated")))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let output = entry
                .get("output")
                .or_else(|| message.and_then(|value| value.get("output")))
                .or_else(|| {
                    content
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("output"))
                })
                .and_then(|value| display_content(Some(value)))
                .or_else(|| display_content(content));
            push(
                GenericBlockKind::Tool,
                "bash_execution",
                bash_title(command),
                Some("bash".into()),
                mark_source_truncated(output, source_truncated),
                true,
                false,
                if cancelled {
                    GenericBlockStatus::Interrupted
                } else {
                    GenericBlockStatus::Complete
                },
            );
            continue;
        }
        if !matches!(entry_type.as_str(), "message" | "tool" | "tool_result") {
            push(
                GenericBlockKind::Unknown,
                "unknown",
                Some("Unrecognized session entry".into()),
                None,
                None,
                true,
                true,
                GenericBlockStatus::Complete,
            );
            continue;
        }

        let items: Vec<&Value> = match content {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(item) => vec![item],
            None => Vec::new(),
        };
        let mut recognized_assistant_detail = false;
        for item in &items {
            let Some(object) = item.as_object() else {
                continue;
            };
            let item_type = string_field(object, &["type"]).unwrap_or_default();
            if role.as_deref() == Some("assistant")
                && matches!(item_type.as_str(), "text" | "markdown")
            {
                recognized_assistant_detail = true;
                push(
                    GenericBlockKind::Assistant,
                    "message",
                    None,
                    None,
                    object
                        .get("text")
                        .and_then(|value| display_content(Some(value))),
                    false,
                    false,
                    assistant_status,
                );
            } else if role.as_deref() == Some("assistant") && item_type == "thinking" {
                recognized_assistant_detail = true;
                push(
                    GenericBlockKind::Thinking,
                    "thinking",
                    Some("Reasoning".into()),
                    None,
                    object
                        .get("thinking")
                        .or_else(|| object.get("text"))
                        .and_then(|value| display_content(Some(value))),
                    true,
                    false,
                    assistant_status,
                );
            } else if matches!(item_type.as_str(), "toolCall" | "tool_call") {
                recognized_assistant_detail = true;
                let name = string_field(object, &["name", "toolName"])
                    .map(|name| safe_text(&name, TYPE_LIMIT));
                let safe_name = tool_title(name.as_deref());
                let call_id = string_field(object, &["id", "toolCallId", "tool_call_id"]);
                let index = push(
                    GenericBlockKind::Tool,
                    "tool_call",
                    safe_name.clone(),
                    safe_name,
                    None,
                    true,
                    false,
                    match assistant_status {
                        GenericBlockStatus::Failed => GenericBlockStatus::Failed,
                        GenericBlockStatus::Interrupted => GenericBlockStatus::Interrupted,
                        _ => GenericBlockStatus::Running,
                    },
                );
                if let Some(call_id) = call_id {
                    tool_blocks.insert(call_id, index);
                }
            } else if item_type == "bashExecution" {
                recognized_assistant_detail = true;
                let command = object.get("command").and_then(Value::as_str);
                let source_truncated = object
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let output = object
                    .get("output")
                    .and_then(|value| display_content(Some(value)))
                    .or_else(|| {
                        object
                            .get("text")
                            .and_then(|value| display_content(Some(value)))
                    });
                push(
                    GenericBlockKind::Tool,
                    "bash_execution",
                    bash_title(command),
                    Some("bash".into()),
                    mark_source_truncated(output, source_truncated),
                    true,
                    false,
                    if object
                        .get("cancelled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        GenericBlockStatus::Interrupted
                    } else {
                        GenericBlockStatus::Complete
                    },
                );
            }
        }
        let is_tool_result = role.as_deref() == Some("toolResult") || entry_type == "tool_result";
        if is_tool_result {
            let call_id = string_field(entry, &["toolCallId", "tool_call_id"])
                .or_else(|| message.and_then(|m| string_field(m, &["toolCallId", "tool_call_id"])))
                .or_else(|| {
                    items.iter().find_map(|item| {
                        item.as_object().and_then(|object| {
                            string_field(object, &["toolCallId", "tool_call_id"])
                        })
                    })
                });
            let result = display_content(content).or_else(|| {
                entry
                    .get("output")
                    .and_then(|value| display_content(Some(value)))
            });
            let failed = entry
                .get("isError")
                .or_else(|| entry.get("is_error"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || message
                    .and_then(|m| m.get("isError").or_else(|| m.get("is_error")))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || items.iter().any(|item| {
                    item.as_object().is_some_and(|object| {
                        object
                            .get("isError")
                            .or_else(|| object.get("is_error"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    })
                });
            if let Some(index) = call_id.and_then(|id| tool_blocks.get(&id).copied()) {
                let (display, truncated) = bounded_display(result.as_deref(), DISPLAY_DETAIL_LIMIT);
                let block = &mut blocks[index];
                if display.is_some() {
                    block.preview = display;
                }
                block.truncated |= truncated;
                block.status = if failed {
                    GenericBlockStatus::Failed
                } else {
                    GenericBlockStatus::Complete
                };
            } else {
                push(
                    GenericBlockKind::Tool,
                    "tool_result",
                    Some("Tool result".into()),
                    None,
                    result,
                    true,
                    true,
                    if failed {
                        GenericBlockStatus::Failed
                    } else {
                        GenericBlockStatus::Complete
                    },
                );
            }
        } else if role.as_deref() == Some("user") {
            push(
                GenericBlockKind::User,
                "message",
                None,
                None,
                display_content(content),
                false,
                false,
                GenericBlockStatus::Complete,
            );
        } else if role.as_deref() == Some("assistant") && !recognized_assistant_detail {
            let display = display_content(content).or_else(|| {
                message
                    .and_then(|value| {
                        value
                            .get("errorMessage")
                            .or_else(|| value.get("error_message"))
                    })
                    .and_then(|value| display_content(Some(value)))
            });
            if let Some(display) = display {
                push(
                    GenericBlockKind::Assistant,
                    "message",
                    None,
                    None,
                    Some(display),
                    false,
                    false,
                    assistant_status,
                );
            }
        }
    }
    trim_old_display(&mut blocks);
    redact_timeline_paths(&mut blocks, project_root);
    blocks
}

/// Redacts absolute filesystem paths from a bounded UI-facing string when no
/// trusted project root is available. The result keeps only a safe leaf label
/// for unmatched paths.
pub fn redact_display_text(value: &str) -> String {
    redact_display_paths(value, None)
}

fn redact_timeline_paths(blocks: &mut [GenericTimelineBlock], project_root: Option<&Path>) {
    for block in blocks {
        if let Some(text) = block.preview.as_mut() {
            *text = redact_display_paths(text, project_root);
        }
    }
}

/// Redacts filesystem paths from render-only text. Session JSONL remains the
/// source of truth, but absolute host paths are not useful in the WebView and
/// can reveal the user's directory layout. Known project prefixes retain a
/// useful workspace-relative suffix; other absolute paths keep only a safe
/// leaf label. This is deliberately lexical and bounded to the already
/// bounded display text.
fn redact_display_paths(value: &str, project_root: Option<&Path>) -> String {
    let mut redacted = value.to_owned();
    if let Some(project_root) = project_root {
        for prefix in project_path_variants(project_root) {
            redacted = replace_known_path_prefix(&redacted, &prefix);
        }
    }
    redact_generic_absolute_paths(&redacted)
}

fn project_path_variants(project_root: &Path) -> Vec<String> {
    let raw = project_root.to_string_lossy();
    let trimmed = raw.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return Vec::new();
    }
    let forward = trimmed.replace('\\', "/");
    let backward = trimmed.replace('/', "\\");
    let mut variants = vec![trimmed.to_owned()];
    if forward != trimmed {
        variants.push(forward);
    }
    if backward != trimmed {
        variants.push(backward);
    }
    variants
}

fn replace_known_path_prefix(value: &str, prefix: &str) -> String {
    if prefix.is_empty() {
        return value.to_owned();
    }
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = value[cursor..].find(prefix) {
        let start = cursor + relative;
        let end = start + prefix.len();
        let previous = value[..start].chars().next_back();
        let next = value[end..].chars().next();
        let valid_start = previous.is_none_or(|character| {
            !character.is_ascii_alphanumeric() && character != '_' && character != '-'
        });
        let valid_end = next.is_none_or(|character| {
            !character.is_ascii_alphanumeric() && character != '_' && character != '-'
        });
        if !valid_start || !valid_end {
            output.push_str(&value[cursor..end]);
            cursor = end;
            continue;
        }
        output.push_str(&value[cursor..start]);
        output.push_str("<workspace>");
        cursor = end;
    }
    output.push_str(&value[cursor..]);
    output
}

fn redact_generic_absolute_paths(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut copied_until = 0;
    while let Some((start, end)) = next_absolute_path_span(value, cursor) {
        output.push_str(&value[copied_until..start]);
        output.push_str(&safe_external_path_label(&value[start..end]));
        cursor = end;
        copied_until = end;
    }
    output.push_str(&value[copied_until..]);
    output
}

fn next_absolute_path_span(value: &str, from: usize) -> Option<(usize, usize)> {
    for (offset, character) in value[from..].char_indices() {
        let start = from + offset;
        let previous = value[..start].chars().next_back();
        if previous.is_some_and(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        }) || value[..start].ends_with("<workspace>")
            || value[..start].ends_with("<external-path>")
        {
            continue;
        }
        let bytes = value.as_bytes();
        let windows_drive = character.is_ascii_alphabetic()
            && bytes.get(start + 1) == Some(&b':')
            && matches!(bytes.get(start + 2), Some(b'/' | b'\\'));
        let unc = bytes.get(start) == Some(&b'\\') && bytes.get(start + 1) == Some(&b'\\');
        let posix = character == '/' && bytes.get(start + 1) != Some(&b'/');
        if !(windows_drive || unc || posix) {
            continue;
        }
        let mut end = start;
        for (relative, next) in value[start..].char_indices() {
            if next.is_whitespace()
                || matches!(next, '"' | '\'' | '<' | '>' | '`' | ')' | ']' | '}' | ',')
            {
                break;
            }
            end = start + relative + next.len_utf8();
        }
        let candidate = &value[start..end];
        let has_separator = candidate[1..].contains(['/', '\\']);
        if end > start + 2 && has_separator {
            return Some((start, end));
        }
    }
    None
}

fn safe_external_path_label(path: &str) -> String {
    let trimmed = path.trim_end_matches(['.', ':', ';', '!', '?']);
    let leaf = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("path");
    format!("<external-path>/{leaf}")
}

fn display_limit(kind: GenericBlockKind) -> usize {
    match kind {
        GenericBlockKind::User | GenericBlockKind::Assistant => DISPLAY_MESSAGE_LIMIT,
        GenericBlockKind::Thinking | GenericBlockKind::Tool => DISPLAY_DETAIL_LIMIT,
        GenericBlockKind::Custom | GenericBlockKind::Compaction | GenericBlockKind::Unknown => {
            DISPLAY_DETAIL_LIMIT
        }
    }
}

fn bash_title(_command: Option<&str>) -> Option<String> {
    Some("bash".into())
}

fn tool_title(tool_name: Option<&str>) -> Option<String> {
    let name = tool_name.unwrap_or("Tool");
    let normalized = name.to_ascii_lowercase();
    Some(
        match normalized.as_str() {
            "bash" => "bash",
            "read" | "read_file" => "Read file",
            "write" | "write_file" => "Write file",
            "edit" | "edit_file" => "Edit file",
            "grep" | "search" => "Search workspace",
            _ => "Tool activity",
        }
        .to_owned(),
    )
}

fn trim_old_display(blocks: &mut [GenericTimelineBlock]) {
    let mut total: usize = blocks
        .iter()
        .filter_map(|block| block.preview.as_ref())
        .map(|text| text.len())
        .sum();
    for block in blocks {
        if total <= DISPLAY_TOTAL_LIMIT {
            break;
        }
        if let Some(text) = block.preview.take() {
            total = total.saturating_sub(text.len());
            block.truncated = true;
        }
    }
}

fn mark_source_truncated(value: Option<String>, truncated: bool) -> Option<String> {
    if !truncated {
        return value;
    }
    let mut value = value.unwrap_or_default();
    value.push(DISPLAY_TRUNCATION_SENTINEL);
    Some(value)
}

fn display_content(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let mut output = String::new();
    let mut truncated = false;
    match value {
        Value::String(value) => {
            truncated = append_bounded_text(&mut output, value, DISPLAY_MESSAGE_LIMIT)
        }
        Value::Object(object) => {
            if let Some(value) = object
                .get("text")
                .or_else(|| object.get("content"))
                .or_else(|| object.get("output"))
                .and_then(Value::as_str)
            {
                truncated = append_bounded_text(&mut output, value, DISPLAY_MESSAGE_LIMIT);
            }
        }
        Value::Array(items) => {
            let mut first = true;
            for item in items {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let kind = object.get("type").and_then(Value::as_str);
                if !matches!(
                    kind,
                    Some("text") | Some("markdown") | Some("toolResult") | Some("bashExecution")
                ) {
                    continue;
                }
                let Some(value) = object
                    .get("text")
                    .or_else(|| object.get("content"))
                    .or_else(|| object.get("output"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if !first && append_bounded_text(&mut output, "\n", DISPLAY_MESSAGE_LIMIT) {
                    truncated = true;
                    break;
                }
                first = false;
                if append_bounded_text(&mut output, value, DISPLAY_MESSAGE_LIMIT) {
                    truncated = true;
                    break;
                }
            }
        }
        _ => {}
    }
    if truncated {
        output.push(DISPLAY_TRUNCATION_SENTINEL);
    }
    (!output.is_empty()).then_some(output)
}

fn bounded_display(value: Option<&str>, limit: usize) -> (Option<String>, bool) {
    let Some(value) = value else {
        return (None, false);
    };
    let source_was_truncated = value.ends_with(DISPLAY_TRUNCATION_SENTINEL);
    let mut output = String::new();
    let mut truncated = append_bounded_text(&mut output, value, limit) || source_was_truncated;
    if truncated {
        append_truncation_marker(&mut output, limit);
    }
    if output.is_empty() {
        truncated = truncated || !value.is_empty();
        (None, truncated)
    } else {
        (Some(output), truncated)
    }
}

fn append_bounded_text(output: &mut String, value: &str, limit: usize) -> bool {
    for character in value.chars() {
        if character.is_control() && !matches!(character, '\n' | '\t') {
            continue;
        }
        if output.len().saturating_add(character.len_utf8()) > limit {
            return true;
        }
        output.push(character);
    }
    false
}

fn append_truncation_marker(output: &mut String, limit: usize) {
    const MARKER: char = '…';
    if output.ends_with(MARKER) {
        return;
    }
    while output.len().saturating_add(MARKER.len_utf8()) > limit {
        if output.pop().is_none() {
            return;
        }
    }
    output.push(MARKER);
}

fn generic_blocks(entries: &[IndexedEntry]) -> Vec<GenericTimelineBlock> {
    // Source IDs remain internal keys only. Counting first makes ambiguous
    // duplicate IDs unable to create an arbitrary parent edge in the fallback.
    let mut source_counts: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        if let Some(source_id) = entry.entry_id.as_deref() {
            *source_counts.entry(source_id).or_default() += 1;
        }
    }
    let mut unique_source_indices = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(source_id) = entry.entry_id.as_deref()
            && source_counts.get(source_id) == Some(&1)
        {
            unique_source_indices.insert(source_id, index);
        }
    }
    let mut parent_indices: Vec<Option<usize>> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            entry
                .parent_id
                .as_deref()
                .and_then(|source_parent| unique_source_indices.get(source_parent).copied())
                .filter(|parent| *parent != index)
        })
        .collect();
    drop_cyclic_timeline_parent_links(&mut parent_indices);

    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| GenericTimelineBlock {
            id: timeline_block_id(index),
            parent_id: parent_indices[index].map(timeline_block_id),
            kind: generic_block_kind(entry),
            source_type: entry.entry_type.clone(),
            created_at: entry.created_at.clone(),
            preview: entry.preview.clone(),
            has_image: entry.has_image,
            title: None,
            tool_name: None,
            collapsible: matches!(
                generic_block_kind(entry),
                GenericBlockKind::Thinking | GenericBlockKind::Tool | GenericBlockKind::Compaction
            ),
            truncated: false,
            fallback: matches!(generic_block_kind(entry), GenericBlockKind::Unknown),
            status: GenericBlockStatus::Complete,
        })
        .collect()
}

fn timeline_block_id(index: usize) -> String {
    format!("timeline-{index}")
}

fn drop_cyclic_timeline_parent_links(parent_indices: &mut [Option<usize>]) {
    let mut settled = vec![false; parent_indices.len()];
    for start in 0..parent_indices.len() {
        if settled[start] {
            continue;
        }
        let mut path = Vec::new();
        let mut positions = HashMap::new();
        let mut current = start;
        loop {
            if settled[current] {
                break;
            }
            if let Some(cycle_start) = positions.get(&current).copied() {
                for node in &path[cycle_start..] {
                    parent_indices[*node] = None;
                }
                break;
            }
            positions.insert(current, path.len());
            path.push(current);
            let Some(next) = parent_indices[current] else {
                break;
            };
            current = next;
        }
        for node in path {
            settled[node] = true;
        }
    }
}

fn generic_block_kind(entry: &IndexedEntry) -> GenericBlockKind {
    match entry.role.as_deref() {
        Some("user") => GenericBlockKind::User,
        Some("assistant") => GenericBlockKind::Assistant,
        _ => match entry.entry_type.as_str() {
            "compaction" => GenericBlockKind::Compaction,
            "tool" | "tool_result" => GenericBlockKind::Tool,
            "thinking_level_change" => GenericBlockKind::Thinking,
            "custom" | "custom_message" | "label" | "branch_summary" | "model_change"
            | "session_info" => GenericBlockKind::Custom,
            value if KNOWN_TYPES.contains(&value) => GenericBlockKind::Custom,
            _ => GenericBlockKind::Unknown,
        },
    }
}

struct TreeProjection {
    nodes: Vec<SessionTreeNode>,
    roots: Vec<String>,
    orphan_ids: Vec<String>,
    cycle_ids: Vec<String>,
    branch_count: usize,
    current_leaf_id: Option<String>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Clone)]
struct MutableNode {
    parent_id: Option<String>,
    order: usize,
    children: Vec<String>,
}

/// Builds a bounded forest projection with iterative, linear-time passes.
/// Parent edges form a functional graph, so color marking detects every cycle
/// without recursion or a per-start walk.
fn project_tree(entries: &[IndexedEntry]) -> TreeProjection {
    let mut nodes: HashMap<String, MutableNode> = HashMap::new();
    let mut node_order = Vec::new();
    let mut node_limit_hit = false;
    for entry in entries {
        let Some(id) = entry.entry_id.as_ref() else {
            continue;
        };
        if nodes.contains_key(id) {
            continue;
        }
        if nodes.len() >= TREE_MAX_NODES {
            node_limit_hit = true;
            continue;
        }
        nodes.insert(
            id.clone(),
            MutableNode {
                parent_id: entry.parent_id.clone(),
                order: entry.order,
                children: Vec::new(),
            },
        );
        node_order.push(id.clone());
    }

    let orphan_set: HashSet<String> = node_order
        .iter()
        .filter(|id| {
            nodes
                .get(*id)
                .and_then(|node| node.parent_id.as_ref())
                .is_some_and(|parent| !nodes.contains_key(parent))
        })
        .cloned()
        .collect();

    // 0 = unseen, 1 = active in this iterative walk, 2 = complete.
    let mut colors: HashMap<String, u8> = HashMap::new();
    let mut cycles = Vec::<Vec<String>>::new();
    for start in &node_order {
        if colors.contains_key(start) {
            continue;
        }
        let mut path = Vec::new();
        let mut cursor = Some(start.clone());
        while let Some(id) = cursor {
            match colors.get(&id).copied().unwrap_or(0) {
                0 => {
                    colors.insert(id.clone(), 1);
                    path.push(id.clone());
                    cursor = nodes.get(&id).and_then(|node| node.parent_id.clone());
                }
                1 => {
                    if let Some(cycle_start) = path.iter().position(|seen| seen == &id) {
                        cycles.push(path[cycle_start..].to_vec());
                    }
                    break;
                }
                _ => break,
            }
        }
        for id in path {
            colors.insert(id, 2);
        }
    }

    let mut cycle_set = HashSet::new();
    for cycle in cycles {
        cycle_set.extend(cycle.iter().cloned());
        let breaker = cycle.iter().min_by_key(|id| {
            nodes
                .get(*id)
                .map(|node| (node.order, (*id).clone()))
                .unwrap_or((usize::MAX, (*id).clone()))
        });
        if let Some(breaker) = breaker
            && let Some(node) = nodes.get_mut(breaker)
        {
            node.parent_id = None;
        }
    }

    // Cycles are now cut. Compute depth bottom-up without recursive traversal;
    // a too-deep node becomes a projection root so every returned edge has a
    // bounded depth for later consumers.
    let mut depths: HashMap<String, usize> = HashMap::new();
    let mut depth_cuts = 0_usize;
    for start in &node_order {
        if depths.contains_key(start) {
            continue;
        }
        let mut path = Vec::new();
        let mut cursor = Some(start.clone());
        while let Some(id) = cursor {
            if depths.contains_key(&id) || !nodes.contains_key(&id) {
                break;
            }
            path.push(id.clone());
            cursor = nodes.get(&id).and_then(|node| node.parent_id.clone());
        }
        for id in path.into_iter().rev() {
            let parent = nodes.get(&id).and_then(|node| node.parent_id.clone());
            let depth = parent
                .as_ref()
                .and_then(|parent| depths.get(parent))
                .map_or(0, |depth| depth.saturating_add(1));
            if depth > TREE_MAX_DEPTH {
                if let Some(node) = nodes.get_mut(&id) {
                    node.parent_id = None;
                }
                depths.insert(id, 0);
                depth_cuts = depth_cuts.saturating_add(1);
            } else {
                depths.insert(id, depth);
            }
        }
    }

    for child in &node_order {
        let parent = nodes.get(child).and_then(|node| node.parent_id.clone());
        if let Some(parent) = parent
            && let Some(parent_node) = nodes.get_mut(&parent)
        {
            parent_node.children.push(child.clone());
        }
    }

    let output_count = node_order.len().min(TREE_MAX_OUTPUT_NODES);
    let output_order = &node_order[..output_count];
    let output_ids: HashSet<&str> = output_order.iter().map(String::as_str).collect();
    let mut roots = Vec::new();
    let mut leaves = Vec::new();
    let mut nodes_out = Vec::with_capacity(output_count);
    for id in output_order {
        let Some(node) = nodes.get(id) else {
            continue;
        };
        let parent_visible = node
            .parent_id
            .as_deref()
            .is_some_and(|parent| output_ids.contains(parent));
        if !parent_visible || orphan_set.contains(id) {
            roots.push(id.clone());
        }
        let children: Vec<String> = node
            .children
            .iter()
            .filter(|child| output_ids.contains(child.as_str()))
            .cloned()
            .collect();
        if children.is_empty() {
            leaves.push(id.clone());
        }
        nodes_out.push(SessionTreeNode {
            entry_id: id.clone(),
            parent_id: parent_visible.then(|| node.parent_id.clone()).flatten(),
            children,
        });
    }

    let mut diagnostics = Vec::new();
    if node_limit_hit {
        diagnostics.push(Diagnostic {
            code: "tree-node-limit".into(),
            line: 0,
            detail: "projection truncated".into(),
        });
    }
    if depth_cuts > 0 {
        diagnostics.push(Diagnostic {
            code: "tree-depth-limit".into(),
            line: 0,
            detail: "parent links cut".into(),
        });
    }
    if node_order.len() > TREE_MAX_OUTPUT_NODES {
        diagnostics.push(Diagnostic {
            code: "tree-output-limit".into(),
            line: 0,
            detail: "projection truncated".into(),
        });
    }

    let branch_count = nodes_out
        .iter()
        .filter(|node| node.children.len() > 1)
        .count();
    TreeProjection {
        nodes: nodes_out,
        roots,
        orphan_ids: node_order
            .iter()
            .filter(|id| orphan_set.contains(*id) && output_ids.contains(id.as_str()))
            .cloned()
            .collect(),
        cycle_ids: node_order
            .iter()
            .filter(|id| cycle_set.contains(*id) && output_ids.contains(id.as_str()))
            .cloned()
            .collect(),
        branch_count,
        current_leaf_id: leaves.pop(),
        diagnostics,
    }
}

/// Reads the session-header CWD without applying display-text normalization.
/// It remains host-only on [`ScanReport`] and is bounded before allocation.
fn header_cwd_field(object: &Map<String, Value>) -> Result<Option<String>, ()> {
    for key in ["cwd", "projectCwd", "project_cwd"] {
        let Some(value) = object.get(key).and_then(Value::as_str) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if value.len() > HEADER_CWD_MAX_BYTES {
            return Err(());
        }
        return Ok(Some(value.to_owned()));
    }
    Ok(None)
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| safe_text(value, PREVIEW_LIMIT))
    })
}

fn text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Array(values) => {
            let text: String = values
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.as_str()),
                    Value::Object(object) => object.get("text").and_then(Value::as_str),
                    _ => None,
                })
                .collect();
            (!text.is_empty()).then_some(text)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

fn preview(value: &Value) -> Option<String> {
    text_content(value)
        .map(|text| safe_text(&text, PREVIEW_LIMIT))
        .filter(|text| !text.is_empty())
}

fn content_has_image(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "image_url" | "input_image"))
                || object.values().any(content_has_image)
        }
        Value::Array(values) => values.iter().any(content_has_image),
        _ => false,
    }
}

fn safe_text(value: &str, limit: usize) -> String {
    let normalized: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '%' | '_' | '\\' => escaped.push('\\'),
            _ => {}
        }
        escaped.push(character);
    }
    escaped
}

fn sanitize_project_name(value: &str) -> Option<String> {
    let without_controls: String = value
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let normalized = safe_text(&without_controls, PREVIEW_LIMIT);
    (!normalized.is_empty()).then_some(normalized)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl ScanReport {
    /// Returns the newest chronological block slice, capped at
    /// [`TIMELINE_SLICE_MAX_LIMIT`]. Use the returned `start` as `before` for
    /// [`Self::timeline_slice_older`] without reparsing or reading a file.
    #[must_use]
    pub fn timeline_slice_latest(&self, limit: usize) -> TimelineSlice {
        self.timeline_slice_before(self.timeline_blocks.len(), limit)
    }

    /// Returns the chronological slice immediately before `before`, clamping
    /// both position and size to safe bounds. `start`, `end`, and `total` are
    /// positional metadata for a host cursor layer; no source IDs are exposed.
    #[must_use]
    pub fn timeline_slice_older(&self, before: usize, limit: usize) -> TimelineSlice {
        self.timeline_slice_before(before.min(self.timeline_blocks.len()), limit)
    }

    fn timeline_slice_before(&self, end: usize, limit: usize) -> TimelineSlice {
        let total = self.timeline_blocks.len();
        let end = end.min(total);
        let start = end.saturating_sub(limit.min(TIMELINE_SLICE_MAX_LIMIT));
        TimelineSlice {
            blocks: self.timeline_blocks[start..end].to_vec(),
            start,
            end,
            total,
        }
    }

    /// Converts the deterministic, generic scanner blocks to the versioned host
    /// contract. Unknown records remain generic `custom` blocks and their raw
    /// JSON is never copied into contract content.
    pub fn timeline_page(&self, session_id: SessionId) -> TimelinePage {
        let blocks = self
            .timeline_blocks
            .iter()
            .map(|block| TimelineBlock {
                id: BlockId::new(block.id.clone()),
                parent_id: block.parent_id.as_ref().map(|id| BlockId::new(id.clone())),
                kind: match block.kind {
                    GenericBlockKind::User => TimelineBlockKind::User,
                    GenericBlockKind::Assistant => TimelineBlockKind::Assistant,
                    GenericBlockKind::Thinking => TimelineBlockKind::Thinking,
                    GenericBlockKind::Tool => TimelineBlockKind::Tool,
                    GenericBlockKind::Compaction => TimelineBlockKind::Compaction,
                    GenericBlockKind::Custom | GenericBlockKind::Unknown => {
                        TimelineBlockKind::Custom
                    }
                },
                status: BlockStatus::Complete,
                created_at: block.created_at.clone(),
                source: TimelineSource {
                    session_id: session_id.clone(),
                    entry_id: (!block.id.starts_with("line-"))
                        .then(|| EntryId::new(block.id.clone())),
                    extension_id: None,
                    entry_type: Some(block.source_type.clone()),
                },
                content: serde_json::json!({
                    "label": block.source_type,
                    "preview": block.preview,
                    "hasImage": block.has_image,
                }),
            })
            .collect();
        TimelinePage {
            session_id,
            blocks,
            file_revision: self.file_revision.clone(),
            older_cursor: None,
            newer_cursor: None,
            stale_cursor: false,
        }
    }

    /// Produces the read-only tree contract. `is_current_path` follows the
    /// documented last-leaf heuristic and is not a Pi navigation assertion.
    pub fn read_only_tree(&self, session_id: SessionId) -> ReadOnlySessionTree {
        let mut current = BTreeSet::new();
        let by_id: HashMap<&str, &SessionTreeNode> = self
            .tree
            .iter()
            .map(|node| (node.entry_id.as_str(), node))
            .collect();
        let entry_by_id: HashMap<&str, &IndexedEntry> = self
            .entries
            .iter()
            .filter_map(|entry| entry.entry_id.as_deref().map(|id| (id, entry)))
            .collect();
        let mut cursor = self.current_leaf_id.as_deref();
        while let Some(id) = cursor {
            if !current.insert(id.to_owned()) {
                break;
            }
            cursor = by_id.get(id).and_then(|node| node.parent_id.as_deref());
        }
        ReadOnlySessionTree {
            session_id,
            current_leaf_id: self
                .current_leaf_id
                .as_ref()
                .map(|id| EntryId::new(id.clone())),
            nodes: self
                .tree
                .iter()
                .map(|node| {
                    let entry = entry_by_id.get(node.entry_id.as_str()).copied();
                    piui_contracts::SessionTreeNode {
                        entry_id: EntryId::new(node.entry_id.clone()),
                        parent_id: node.parent_id.as_ref().map(|id| EntryId::new(id.clone())),
                        role_or_type: entry
                            .and_then(|entry| {
                                entry
                                    .role
                                    .clone()
                                    .or_else(|| Some(entry.entry_type.clone()))
                            })
                            .unwrap_or_else(|| "unknown".into()),
                        created_at: entry.and_then(|entry| entry.created_at.clone()),
                        preview: entry.and_then(|entry| entry.preview.clone()),
                        children: node.children.iter().cloned().map(EntryId::new).collect(),
                        is_current_path: current.contains(&node.entry_id),
                    }
                })
                .collect(),
        }
    }

    /// Converts scanner metadata to the contract projection without exposing a
    /// session file path or a project CWD.
    pub fn contract_projection(
        &self,
        id: SessionId,
        project_id: Option<ProjectId>,
    ) -> ContractSessionProjection {
        let (_, title_source) = title_from_report(self, id.as_str());
        ContractSessionProjection {
            id,
            project_id,
            pi_session_id: self.pi_session_id.clone(),
            name: self.session_name.clone(),
            title_source: contract_title_source(title_source),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            first_user_preview: self.first_user_preview.clone(),
            last_message_preview: self.last_message_preview.clone(),
            entry_count: self.entry_count as u64,
            branch_count: Some(self.branch_count as u64),
            current_leaf_id: self.current_leaf_id.clone().map(EntryId::new),
            model: self.model_ref.clone().map(model_ref),
            parse_state: contract_parse_state(self.parse_state),
            file_revision: self.file_revision.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustState {
    Unknown,
    Trusted,
    Restricted,
}

impl TrustState {
    fn as_db(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Trusted => "trusted",
            Self::Restricted => "restricted",
        }
    }
    fn from_db(value: &str) -> Result<Self, IndexError> {
        match value {
            "unknown" => Ok(Self::Unknown),
            "trusted" => Ok(Self::Trusted),
            "restricted" => Ok(Self::Restricted),
            _ => Err(IndexError::InvalidStoredValue("trust_state")),
        }
    }
}

/// PiUI-owned local display preferences. These values are stored only in the
/// rebuildable index database and never read from Pi configuration/auth files.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePreference {
    #[default]
    System,
    Dark,
    Light,
}

impl ThemePreference {
    fn storage_value(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }

    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "dark" => Some(Self::Dark),
            "light" => Some(Self::Light),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DensityPreference {
    #[default]
    Comfortable,
    Compact,
}

impl DensityPreference {
    fn storage_value(self) -> &'static str {
        match self {
            Self::Comfortable => "comfortable",
            Self::Compact => "compact",
        }
    }

    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "comfortable" => Some(Self::Comfortable),
            "compact" => Some(Self::Compact),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReducedMotionPreference {
    #[default]
    System,
    Reduce,
}

impl ReducedMotionPreference {
    fn storage_value(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Reduce => "reduce",
        }
    }

    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "reduce" => Some(Self::Reduce),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FontSizePreference {
    Small,
    #[default]
    Medium,
    Large,
}

impl FontSizePreference {
    fn storage_value(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }

    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "small" => Some(Self::Small),
            "medium" => Some(Self::Medium),
            "large" => Some(Self::Large),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatWidthPreference {
    #[default]
    Wide,
    Centered,
    Focused,
}

impl ChatWidthPreference {
    fn storage_value(self) -> &'static str {
        match self {
            Self::Wide => "wide",
            Self::Centered => "centered",
            Self::Focused => "focused",
        }
    }

    fn from_storage(value: &str) -> Option<Self> {
        match value {
            "wide" => Some(Self::Wide),
            "centered" => Some(Self::Centered),
            "focused" => Some(Self::Focused),
            _ => None,
        }
    }
}

/// Validated, path-free PiUI display preferences. Defaults follow the system
/// theme/motion policy, use comfortable density, a medium chat font, and the
/// widest readable conversation lane.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: ThemePreference,
    pub density: DensityPreference,
    pub reduced_motion: ReducedMotionPreference,
    pub font_size: FontSizePreference,
    pub chat_width: ChatWidthPreference,
}

/// Path-safe DTO for UI and IPC. It deliberately contains no canonical path,
/// session file path, URI, or CWD.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub display_path: String,
    pub trust_state: TrustState,
    #[serde(default)]
    pub pinned: bool,
    pub missing: bool,
    pub last_opened_at: Option<i64>,
}

/// Path-safe session list DTO. Full file identity remains internal to SQLite.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub title_source: TitleSource,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub preview: Option<String>,
    pub entry_count: usize,
    pub branch_count: Option<usize>,
    pub parse_state: ParseState,
    pub model_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleSource {
    PiName,
    FirstUserMessage,
    DateId,
    UiAlias,
}

impl TitleSource {
    fn as_db(self) -> &'static str {
        match self {
            Self::PiName => "pi-name",
            Self::FirstUserMessage => "first-user-message",
            Self::DateId => "date-id",
            Self::UiAlias => "ui-alias",
        }
    }
    fn from_db(value: &str) -> Result<Self, IndexError> {
        match value {
            "pi-name" => Ok(Self::PiName),
            "first-user-message" => Ok(Self::FirstUserMessage),
            "date-id" => Ok(Self::DateId),
            "ui-alias" => Ok(Self::UiAlias),
            _ => Err(IndexError::InvalidStoredValue("title_source")),
        }
    }
}

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("project directory is unavailable")]
    NotDirectory,
    #[error("cannot canonicalize project directory")]
    Canonicalize(#[source] std::io::Error),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("project lacks a valid directory identity and must be re-registered")]
    ProjectIdentityUnavailable,
    #[error("project is not registered")]
    ProjectNotRegistered,
    #[error("project discovery generation is invalid or stale")]
    ProjectDiscoveryGenerationUnavailable,
    #[error("project name is empty after sanitization")]
    InvalidProjectName,
    #[error("session search query is empty or exceeds the safe limit")]
    InvalidSessionSearchQuery,
    #[error("session search project allowlist exceeds the safe limit")]
    SessionSearchProjectLimitExceeded,
    #[error("indexed session lacks a valid file identity and must be reindexed")]
    SessionIdentityUnavailable,
    #[error("indexed session changed before its discovery report could be stored")]
    SessionIdentityChanged,
    #[error("stored value is invalid: {0}")]
    InvalidStoredValue(&'static str),
}

/// Small host-side SQLite repository. `canonical_path` and `file_path` never
/// occur in a serializable return type.
pub struct ProjectIndex {
    connection: Connection,
}

struct PersistedScanEvidence<'a> {
    fingerprint: Option<&'a SourceFingerprint>,
    catalog_only: bool,
}

fn encode_preferences(preferences: Preferences) -> String {
    format!(
        "v2|{}|{}|{}|{}|{}",
        preferences.theme.storage_value(),
        preferences.density.storage_value(),
        preferences.reduced_motion.storage_value(),
        preferences.font_size.storage_value(),
        preferences.chat_width.storage_value(),
    )
}

fn decode_preferences(value: &str) -> Option<Preferences> {
    let mut fields = value.split('|');
    match fields.next()? {
        // v1 did not have chat presentation controls. Preserve its valid
        // display choices and use conservative defaults for the new fields.
        "v1" => {
            let theme = ThemePreference::from_storage(fields.next()?)?;
            let density = DensityPreference::from_storage(fields.next()?)?;
            let reduced_motion = ReducedMotionPreference::from_storage(fields.next()?)?;
            if fields.next().is_some() {
                return None;
            }
            Some(Preferences {
                theme,
                density,
                reduced_motion,
                font_size: FontSizePreference::default(),
                chat_width: ChatWidthPreference::default(),
            })
        }
        "v2" => {
            let theme = ThemePreference::from_storage(fields.next()?)?;
            let density = DensityPreference::from_storage(fields.next()?)?;
            let reduced_motion = ReducedMotionPreference::from_storage(fields.next()?)?;
            let font_size = FontSizePreference::from_storage(fields.next()?)?;
            let chat_width = ChatWidthPreference::from_storage(fields.next()?)?;
            if fields.next().is_some() {
                return None;
            }
            Some(Preferences {
                theme,
                density,
                reduced_motion,
                font_size,
                chat_width,
            })
        }
        _ => None,
    }
}

/// Confirms that the report still belongs to the observed source without
/// reparsing JSONL. This is intentionally usable before an index mutex is
/// acquired; batch commit performs one final bounded evidence CAS check.
fn verify_discovered_session(
    discovered: DiscoveredSession,
) -> Result<DiscoveredSession, IndexError> {
    let verification_limit = discovered
        .file
        .verification_limit
        .filter(|limit| *limit != 0)
        .ok_or(IndexError::SessionIdentityUnavailable)?;
    let current = read_discovery_evidence(discovered.file.as_path(), verification_limit)
        .map_err(|_| IndexError::SessionIdentityChanged)?;
    if current.fingerprint != discovered.fingerprint {
        return Err(IndexError::SessionIdentityChanged);
    }
    // Hash only: no full JSON parser/tree/timeline allocation on this second
    // pass. The report revision must still name the complete verified bytes.
    verify_bound_file_revision_streaming(
        &discovered.file,
        verification_limit,
        &discovered.report.file_revision,
    )
    .map_err(|_| IndexError::SessionIdentityChanged)?;
    Ok(discovered)
}

fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.create_scalar_function(
        "piui_casefold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let value: Option<String> = context.get(0)?;
            Ok(value.unwrap_or_default().to_lowercase())
        },
    )
}

impl ProjectIndex {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let connection = Connection::open(path)?;
        configure_connection(&connection)?;
        let mut index = Self { connection };
        index.migrate()?;
        Ok(index)
    }

    pub fn open_in_memory() -> Result<Self, IndexError> {
        let connection = Connection::open_in_memory()?;
        configure_connection(&connection)?;
        let mut index = Self { connection };
        index.migrate()?;
        Ok(index)
    }

    fn migrate(&mut self) -> Result<(), IndexError> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                canonical_path TEXT NOT NULL UNIQUE,
                display_path TEXT NOT NULL,
                name TEXT NOT NULL,
                order_key TEXT NOT NULL,
                trust_state TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                directory_identity TEXT,
                added_at INTEGER NOT NULL,
                last_opened_at INTEGER,
                missing_since INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions_index (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL UNIQUE,
                project_id TEXT,
                pi_session_id TEXT,
                name TEXT,
                title_source TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                first_user_preview TEXT,
                last_message_preview TEXT,
                entry_count INTEGER NOT NULL,
                branch_count INTEGER,
                current_leaf_id TEXT,
                model_ref TEXT,
                parse_state TEXT NOT NULL,
                file_revision TEXT NOT NULL,
                file_identity TEXT,
                source_length INTEGER,
                source_modified_stamp INTEGER,
                source_continuity_digest TEXT,
                source_parser_version INTEGER,
                index_generation INTEGER NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );
            CREATE TABLE IF NOT EXISTS index_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_index_project_updated_id
                ON sessions_index(project_id, updated_at DESC, id);",
        )?;
        if !self.table_has_column("projects", "directory_identity")? {
            self.connection.execute(
                "ALTER TABLE projects ADD COLUMN directory_identity TEXT",
                [],
            )?;
        }
        if !self.table_has_column("projects", "pinned")? {
            self.connection.execute(
                "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS projects_active_pinned_order
             ON projects(pinned DESC, order_key, id)
             WHERE missing_since IS NULL",
            [],
        )?;
        if !self.table_has_column("sessions_index", "file_identity")? {
            self.connection.execute(
                "ALTER TABLE sessions_index ADD COLUMN file_identity TEXT",
                [],
            )?;
        }
        // Additive host-private catalog evidence. NULL legacy values remain
        // readable but deliberately never qualify for incremental skipping.
        for (column, definition) in [
            ("source_length", "INTEGER"),
            ("source_modified_stamp", "INTEGER"),
            ("source_continuity_digest", "TEXT"),
            ("source_parser_version", "INTEGER"),
        ] {
            if !self.table_has_column("sessions_index", column)? {
                self.connection.execute(
                    &format!("ALTER TABLE sessions_index ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    fn table_has_column(&self, table: &str, column: &str) -> Result<bool, IndexError> {
        let pragma = match table {
            "projects" => "PRAGMA table_info(projects)",
            "sessions_index" => "PRAGMA table_info(sessions_index)",
            _ => return Ok(false),
        };
        let mut statement = self.connection.prepare(pragma)?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        Ok(columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|value| value == column))
    }

    /// Loads PiUI-owned local preferences from SQLite. Missing or malformed
    /// state fails closed to conservative defaults without touching Pi files.
    pub fn preferences(&self) -> Result<Preferences, IndexError> {
        let stored: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM index_state WHERE key = ?1",
                params![PREFERENCES_STATE_KEY],
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored
            .as_deref()
            .and_then(decode_preferences)
            .unwrap_or_default())
    }

    /// Atomically replaces the complete validated PiUI preference set in
    /// SQLite. It never opens or modifies project, session, Pi config, or auth
    /// files.
    pub fn update_preferences(
        &mut self,
        preferences: Preferences,
    ) -> Result<Preferences, IndexError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO index_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![PREFERENCES_STATE_KEY, encode_preferences(preferences)],
        )?;
        transaction.commit()?;
        Ok(preferences)
    }

    /// Compatibility registration path. It resolves a native identity before
    /// writing, so new project rows never rely on canonical path text alone.
    pub fn register_project(
        &mut self,
        path: impl AsRef<Path>,
        name: Option<&str>,
        trust_state: TrustState,
    ) -> Result<ProjectSummary, IndexError> {
        let directory =
            ProjectDirectory::resolve(path.as_ref()).map_err(|_| IndexError::NotDirectory)?;
        self.register_project_directory(&directory, name, trust_state)
    }

    /// Registers a host-resolved project directory and persists its native
    /// identity token. A canonical-path collision with a missing or mismatched
    /// token is treated as replacement: its old trust is reset to Restricted.
    pub fn register_project_directory(
        &mut self,
        directory: &ProjectDirectory,
        name: Option<&str>,
        trust_state: TrustState,
    ) -> Result<ProjectSummary, IndexError> {
        let canonical = directory.canonical_path();
        let canonical_text = canonical.to_string_lossy().into_owned();
        let identity = directory.identity().storage_token();
        let existing: Option<(ProjectSummary, Option<String>)> = self
            .connection
            .query_row(
                "SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at, directory_identity FROM projects WHERE canonical_path = ?1",
                params![canonical_text],
                |row| Ok((project_summary_row(row)?, row.get(7)?)),
            )
            .optional()?;
        if let Some((existing, stored_identity)) = existing {
            if stored_identity.as_deref() == Some(identity.as_storage_str()) {
                return Ok(existing);
            }
            // Same spelling but a different native object (or a legacy row)
            // never inherits prior trust. Purge rebuildable associations in the
            // same transaction, so no cached session can survive a replacement.
            let transaction = self.connection.transaction()?;
            transaction.execute(
                "DELETE FROM sessions_index WHERE project_id = ?1",
                params![&existing.id],
            )?;
            transaction.execute(
                "UPDATE projects SET directory_identity = ?2, trust_state = ?3, missing_since = NULL WHERE id = ?1",
                params![&existing.id, identity.as_storage_str(), TrustState::Restricted.as_db()],
            )?;
            transaction.commit()?;
            return self
                .connection
                .query_row(
                    "SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at FROM projects WHERE id = ?1",
                    params![existing.id],
                    project_summary_row,
                )
                .map_err(IndexError::from);
        }

        let id = Uuid::new_v4().to_string();
        let display_path = safe_display_path(canonical);
        let project_name = name
            .map(|name| safe_text(name, PREVIEW_LIMIT))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| {
                canonical
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| safe_text(value, PREVIEW_LIMIT))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "Project".into())
            });
        self.connection.execute(
            "INSERT INTO projects (id, canonical_path, display_path, name, order_key, trust_state, directory_identity, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, canonical_text, display_path, project_name, now_epoch_seconds().to_string(), trust_state.as_db(), identity.as_storage_str(), now_epoch_seconds()],
        )?;
        Ok(ProjectSummary {
            id,
            name: project_name,
            display_path,
            trust_state,
            pinned: false,
            missing: false,
            last_opened_at: None,
        })
    }

    /// Retrieves the stored native identity for trusted host code. Legacy rows
    /// with no token fail closed rather than falling back to path text.
    pub fn stored_project_identity(
        &self,
        project_id: &str,
    ) -> Result<Option<ProjectDirectoryIdentity>, IndexError> {
        let stored: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT directory_identity FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        match stored {
            None => Ok(None),
            Some(Some(token)) => ProjectDirectoryIdentity::from_storage_token(&token)
                .map(Some)
                .ok_or(IndexError::ProjectIdentityUnavailable),
            Some(None) => Err(IndexError::ProjectIdentityUnavailable),
        }
    }

    /// True only when a stored project identity exists and exactly matches the
    /// host-resolved directory. Missing/legacy identity rows fail closed.
    pub fn verify_project_identity(
        &self,
        project_id: &str,
        identity: &ProjectDirectoryIdentity,
    ) -> Result<bool, IndexError> {
        let Some(stored) = self.stored_project_identity(project_id)? else {
            return Ok(false);
        };
        Ok(stored == *identity)
    }

    /// Returns a bounded, path-free allowlist for host session search. Missing
    /// projects are excluded; ordering matches the registry's pinned-first UI
    /// order. This reads IDs directly from SQLite rather than materializing
    /// project summaries.
    pub fn active_project_ids_for_search(&self, limit: usize) -> Result<Vec<String>, IndexError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut statement = self.connection.prepare(
            "SELECT id FROM projects
             WHERE missing_since IS NULL
             ORDER BY pinned DESC, order_key, id
             LIMIT ?1",
        )?;
        let rows = statement.query_map(
            params![limit.min(SESSION_SEARCH_PROJECT_ID_LIMIT) as i64],
            |row| row.get::<_, String>(0),
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from)
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>, IndexError> {
        let mut statement = self.connection.prepare("SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at FROM projects ORDER BY pinned DESC, order_key, id")?;
        let rows = statement.query_map([], project_summary_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from)
    }

    /// Updates the trust decision for an already registered project. The only
    /// returned value is the existing path-safe summary; no canonical path is
    /// exposed to the UI/IPC caller.
    pub fn update_project_trust(
        &mut self,
        project_id: &str,
        trust_state: TrustState,
    ) -> Result<Option<ProjectSummary>, IndexError> {
        let changed = self.connection.execute(
            "UPDATE projects SET trust_state = ?2 WHERE id = ?1",
            params![project_id, trust_state.as_db()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at FROM projects WHERE id = ?1",
                params![project_id],
                project_summary_row,
            )
            .optional()
            .map_err(IndexError::from)
    }

    /// Renames a registered project in SQLite only. The new UI label is
    /// whitespace-normalized, control-character-free, bounded, and non-empty.
    pub fn rename_project(
        &mut self,
        project_id: &str,
        name: &str,
    ) -> Result<Option<ProjectSummary>, IndexError> {
        let name = sanitize_project_name(name).ok_or(IndexError::InvalidProjectName)?;
        let changed = self.connection.execute(
            "UPDATE projects SET name = ?2 WHERE id = ?1",
            params![project_id, name],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at FROM projects WHERE id = ?1",
                params![project_id],
                project_summary_row,
            )
            .optional()
            .map_err(IndexError::from)
    }

    /// Changes only the SQLite pin metadata for a registered project.
    pub fn set_project_pinned(
        &mut self,
        project_id: &str,
        pinned: bool,
    ) -> Result<Option<ProjectSummary>, IndexError> {
        let changed = self.connection.execute(
            "UPDATE projects SET pinned = ?2 WHERE id = ?1",
            params![project_id, if pinned { 1_i64 } else { 0_i64 }],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT id, name, display_path, trust_state, pinned, missing_since, last_opened_at FROM projects WHERE id = ?1",
                params![project_id],
                project_summary_row,
            )
            .optional()
            .map_err(IndexError::from)
    }

    /// Removes one registry entry and its rebuildable cache rows atomically.
    /// This exclusively mutates SQLite: project folders and JSONL files are
    /// never opened, written, or deleted.
    pub fn remove_project_registry_entry(&mut self, project_id: &str) -> Result<bool, IndexError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM sessions_index WHERE project_id = ?1",
            params![project_id],
        )?;
        transaction.execute(
            "DELETE FROM index_state WHERE key = ?1",
            params![project_generation_key(project_id)],
        )?;
        let removed =
            transaction.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
        transaction.commit()?;
        Ok(removed > 0)
    }

    /// Explicit host-only lookup. Never send this return value across IPC.
    pub fn canonical_project_path(&self, project_id: &str) -> Result<Option<PathBuf>, IndexError> {
        self.connection
            .query_row(
                "SELECT canonical_path FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.map(PathBuf::from))
            .map_err(IndexError::from)
    }

    /// Looks up a cache-private path by opaque session ID for a trusted host
    /// rescan. [`HostSessionFile`] intentionally cannot be serialized or
    /// debug-printed with its raw path.
    pub fn indexed_session_file_path(
        &self,
        session_id: &str,
    ) -> Result<Option<HostSessionFile>, IndexError> {
        let stored: Option<(String, Option<String>, String)> = self
            .connection
            .query_row(
                "SELECT file_path, file_identity, file_revision FROM sessions_index WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match stored {
            None => Ok(None),
            Some((path, Some(identity), revision)) => {
                HostSessionFile::from_stored(PathBuf::from(path), identity, revision).map(Some)
            }
            Some((_, None, _)) => Err(IndexError::SessionIdentityUnavailable),
        }
    }

    pub fn mark_project_missing(
        &mut self,
        project_id: &str,
        missing: bool,
    ) -> Result<(), IndexError> {
        let missing_since = missing.then(now_epoch_seconds);
        self.connection.execute(
            "UPDATE projects SET missing_since = ?2 WHERE id = ?1",
            params![project_id, missing_since],
        )?;
        Ok(())
    }

    /// Returns private catalog fingerprints for a project's indexed sources.
    /// Legacy rows with incomplete evidence are omitted so they must take the
    /// conservative full-discovery path once before becoming eligible.
    pub fn known_project_catalog_fingerprints(
        &self,
        project_id: &str,
    ) -> Result<Vec<CatalogSourceFingerprint>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT id, file_path, file_identity, source_length, source_modified_stamp,
                    source_continuity_digest, source_parser_version
             FROM sessions_index
             WHERE project_id = ?1
               AND file_identity IS NOT NULL
               AND source_length IS NOT NULL
               AND source_modified_stamp IS NOT NULL
               AND source_continuity_digest IS NOT NULL
               AND source_parser_version IS NOT NULL",
        )?;
        let mut rows = statement.query(params![project_id])?;
        let mut fingerprints = Vec::new();
        while let Some(row) = rows.next()? {
            // Database conversion/iteration failures propagate. Only values
            // that are semantically unusable as a local fingerprint are
            // treated as legacy and omitted from this optional fast path.
            let session_id: String = row.get(0)?;
            let path: String = row.get(1)?;
            let identity_text: String = row.get(2)?;
            let length: i64 = row.get(3)?;
            let modified_stamp: i64 = row.get(4)?;
            let continuity_digest: String = row.get(5)?;
            let parser_version: i64 = row.get(6)?;
            let Some(identity) = PlatformFileIdentity::from_storage(&identity_text) else {
                continue;
            };
            if length < 0
                || modified_stamp < 0
                || parser_version != DISCOVERY_FINGERPRINT_PARSER_VERSION
                || !is_sha256_hex(&continuity_digest)
            {
                continue;
            }
            fingerprints.push(CatalogSourceFingerprint {
                session_id,
                path: PathBuf::from(path),
                fingerprint: SourceFingerprint {
                    identity,
                    length: length as u64,
                    modified_stamp: Some(modified_stamp),
                    continuity_digest,
                    parser_version,
                },
            });
        }
        Ok(fingerprints)
    }

    /// Marks catalog observations as seen for the current generation. Each
    /// update also compares the persisted weak fingerprint, so stale or
    /// cross-project observations cannot keep a replaced row alive.
    pub fn mark_unchanged_sources_seen(
        &mut self,
        project_id: &str,
        generation: i64,
        observations: &[UnchangedSourceObservation],
    ) -> Result<usize, IndexError> {
        let transaction = self.connection.transaction()?;
        let mut changed = 0;
        for observation in observations {
            changed += transaction.execute(
                "UPDATE sessions_index SET index_generation = ?3
                 WHERE id = ?1 AND project_id = ?2
                   AND file_identity = ?4
                   AND source_length = ?5
                   AND source_modified_stamp = ?6
                   AND source_continuity_digest = ?7
                   AND source_parser_version = ?8",
                params![
                    &observation.session_id,
                    project_id,
                    generation,
                    observation.fingerprint.identity.storage_value(),
                    observation.fingerprint.length as i64,
                    observation.fingerprint.modified_stamp,
                    &observation.fingerprint.continuity_digest,
                    observation.fingerprint.parser_version,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(changed)
    }

    /// Allocates the next host-only generation for one project's discovery
    /// pass. Callers persist each observed session with this generation before
    /// asking [`Self::sweep_project_sessions_if_complete`] to reconcile it.
    pub fn allocate_project_discovery_generation(
        &mut self,
        project_id: &str,
    ) -> Result<i64, IndexError> {
        let key = project_generation_key(project_id);
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(IndexError::ProjectNotRegistered);
        }
        let previous: Option<String> = transaction
            .query_row(
                "SELECT value FROM index_state WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        let generation = match previous {
            None => 1,
            Some(value) => parse_project_generation(&value)?
                .checked_add(1)
                .ok_or(IndexError::ProjectDiscoveryGenerationUnavailable)?,
        };
        transaction.execute(
            "INSERT INTO index_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![project_generation_key(project_id), generation.to_string()],
        )?;
        transaction.commit()?;
        Ok(generation)
    }

    /// Removes only cache rows not seen in this generation, and only after a
    /// confirmed complete discovery. This is SQLite-only: it never opens or
    /// changes JSONL files. An incomplete pass returns zero without sweeping.
    pub fn sweep_project_sessions_if_complete(
        &mut self,
        project_id: &str,
        generation: i64,
        stats: &SessionDiscoveryStats,
    ) -> Result<usize, IndexError> {
        if !stats.is_complete() {
            return Ok(0);
        }
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(IndexError::ProjectNotRegistered);
        }
        let current: Option<String> = transaction
            .query_row(
                "SELECT value FROM index_state WHERE key = ?1",
                params![project_generation_key(project_id)],
                |row| row.get(0),
            )
            .optional()?;
        if current
            .as_deref()
            .and_then(|value| parse_project_generation(value).ok())
            != Some(generation)
        {
            return Err(IndexError::ProjectDiscoveryGenerationUnavailable);
        }
        let removed = transaction.execute(
            "DELETE FROM sessions_index WHERE project_id = ?1 AND index_generation < ?2",
            params![project_id, generation],
        )?;
        transaction.commit()?;
        Ok(removed)
    }

    /// Store scanner metadata for internal callers that only have a path. This
    /// compatibility path creates a bound capability and then performs the
    /// same verified persistence as discovery; host discovery must call
    /// [`Self::index_discovered_scan`] directly.
    pub fn index_scan(
        &mut self,
        session_file: impl AsRef<Path>,
        project_id: Option<&str>,
        report: &ScanReport,
        generation: i64,
    ) -> Result<SessionSummary, IndexError> {
        let path = session_file.as_ref().to_path_buf();
        let identity = capture_session_file_identity(&path)?;
        let verification_limit = report
            .complete_bytes
            .checked_add(report.partial_tail_bytes)
            .map(|limit| limit.max(1))
            .filter(|limit| *limit < usize::MAX)
            .ok_or(IndexError::SessionIdentityUnavailable)?;
        let bound = HostSessionFile::from_verified(
            path,
            identity,
            report.file_revision.clone(),
            verification_limit,
        );
        self.index_discovered_scan(&bound, project_id, report, generation)
    }

    /// Persists a discovery projection only when it still describes the exact
    /// no-follow handle identity and revision observed during discovery. This
    /// prevents a path swap from binding target-derived metadata to a session.
    pub fn index_discovered_scan(
        &mut self,
        session_file: &HostSessionFile,
        project_id: Option<&str>,
        report: &ScanReport,
        generation: i64,
    ) -> Result<SessionSummary, IndexError> {
        let expected_identity = session_file
            .expected_identity
            .as_ref()
            .ok_or(IndexError::SessionIdentityUnavailable)?;
        let expected_revision = session_file
            .expected_revision
            .as_deref()
            .ok_or(IndexError::SessionIdentityUnavailable)?;
        let verification_limit = session_file
            .verification_limit
            .filter(|limit| *limit != 0)
            .ok_or(IndexError::SessionIdentityUnavailable)?;
        if expected_revision != report.file_revision {
            return Err(IndexError::SessionIdentityChanged);
        }
        let verified = scan_file_bounded(session_file, verification_limit)
            .map_err(|_| IndexError::SessionIdentityChanged)?;
        if verified.file_revision != report.file_revision {
            return Err(IndexError::SessionIdentityChanged);
        }
        let fingerprint = read_discovery_evidence(session_file.as_path(), verification_limit)
            .map_err(|_| IndexError::SessionIdentityChanged)?
            .fingerprint;
        if fingerprint.identity != *expected_identity {
            return Err(IndexError::SessionIdentityChanged);
        }
        self.persist_index_scan(
            session_file.as_path(),
            expected_identity.storage_value(),
            project_id,
            report,
            generation,
            PersistedScanEvidence {
                fingerprint: Some(&fingerprint),
                catalog_only: false,
            },
        )
    }

    /// Persists the report produced by [`discover_sessions_for_project`] or
    /// its incremental counterpart without repeating a full JSONL parse. The
    /// discovery capability is unconstructable outside this crate; a final
    /// bounded no-follow evidence read rejects replacements or instability.
    pub fn index_verified_discovered_session(
        &mut self,
        discovered: DiscoveredSession,
        project_id: Option<&str>,
        generation: i64,
    ) -> Result<SessionSummary, IndexError> {
        let discovered = verify_discovered_session(discovered)?;
        self.persist_index_scan(
            discovered.file.as_path(),
            discovered.fingerprint.identity.storage_value(),
            project_id,
            &discovered.report,
            generation,
            PersistedScanEvidence {
                fingerprint: Some(&discovered.fingerprint),
                catalog_only: discovered.catalog_only,
            },
        )
    }

    /// Commits a fully verified discovery batch in one SQLite transaction.
    /// Before opening that transaction, each source receives one final bounded
    /// no-follow evidence comparison so a replacement after outside-lock
    /// verification cannot bind stale report metadata to an indexed row.
    pub fn commit_verified_project_discovery_batch(
        &mut self,
        batch: VerifiedDiscoveredSessionBatch,
        project_id: &str,
        generation: i64,
        unchanged_sources: &[UnchangedSourceObservation],
        stats: &SessionDiscoveryStats,
    ) -> Result<VerifiedDiscoveryBatchCommit, IndexError> {
        for discovered in &batch.sessions {
            let verification_limit = discovered
                .file
                .verification_limit
                .filter(|limit| *limit != 0)
                .ok_or(IndexError::SessionIdentityUnavailable)?;
            let current = read_discovery_evidence(discovered.file.as_path(), verification_limit)
                .map_err(|_| IndexError::SessionIdentityChanged)?;
            if current.fingerprint != discovered.fingerprint {
                return Err(IndexError::SessionIdentityChanged);
            }
        }

        let transaction = self.connection.transaction()?;
        Self::assert_project_generation(&transaction, project_id, generation)?;
        let mut sessions = Vec::with_capacity(batch.sessions.len());
        for discovered in batch.sessions {
            sessions.push(Self::persist_index_scan_in_transaction(
                &transaction,
                discovered.file.as_path(),
                discovered.fingerprint.identity.storage_value(),
                Some(project_id),
                &discovered.report,
                generation,
                PersistedScanEvidence {
                    fingerprint: Some(&discovered.fingerprint),
                    catalog_only: discovered.catalog_only,
                },
            )?);
        }
        let unchanged_sources_marked = Self::mark_unchanged_sources_in_transaction(
            &transaction,
            project_id,
            generation,
            unchanged_sources,
        )?;
        // A stale/mismatched fast-path observation must never make its prior
        // row eligible for deletion. It is safe to keep an old catalog row and
        // rediscover later; it is not safe to sweep it based on incomplete
        // evidence collected before a replacement or concurrent write.
        let complete = stats.is_complete() && unchanged_sources_marked == unchanged_sources.len();
        let swept_sessions = if complete {
            transaction.execute(
                "DELETE FROM sessions_index WHERE project_id = ?1 AND index_generation < ?2",
                params![project_id, generation],
            )?
        } else {
            0
        };
        transaction.commit()?;
        Ok(VerifiedDiscoveryBatchCommit {
            sessions,
            unchanged_sources_marked,
            swept_sessions,
            complete,
        })
    }

    fn assert_project_generation(
        transaction: &rusqlite::Transaction<'_>,
        project_id: &str,
        generation: i64,
    ) -> Result<(), IndexError> {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(IndexError::ProjectNotRegistered);
        }
        let current: Option<String> = transaction
            .query_row(
                "SELECT value FROM index_state WHERE key = ?1",
                params![project_generation_key(project_id)],
                |row| row.get(0),
            )
            .optional()?;
        if current
            .as_deref()
            .and_then(|value| parse_project_generation(value).ok())
            != Some(generation)
        {
            return Err(IndexError::ProjectDiscoveryGenerationUnavailable);
        }
        Ok(())
    }

    fn mark_unchanged_sources_in_transaction(
        transaction: &rusqlite::Transaction<'_>,
        project_id: &str,
        generation: i64,
        observations: &[UnchangedSourceObservation],
    ) -> Result<usize, IndexError> {
        let mut changed = 0;
        for observation in observations {
            changed += transaction.execute(
                "UPDATE sessions_index SET index_generation = ?3
                 WHERE id = ?1 AND project_id = ?2
                   AND file_identity = ?4
                   AND source_length = ?5
                   AND source_modified_stamp = ?6
                   AND source_continuity_digest = ?7
                   AND source_parser_version = ?8",
                params![
                    &observation.session_id,
                    project_id,
                    generation,
                    observation.fingerprint.identity.storage_value(),
                    observation.fingerprint.length as i64,
                    observation.fingerprint.modified_stamp,
                    &observation.fingerprint.continuity_digest,
                    observation.fingerprint.parser_version,
                ],
            )?;
        }
        Ok(changed)
    }

    fn persist_index_scan(
        &mut self,
        session_file: &Path,
        file_identity: String,
        project_id: Option<&str>,
        report: &ScanReport,
        generation: i64,
        evidence: PersistedScanEvidence<'_>,
    ) -> Result<SessionSummary, IndexError> {
        let transaction = self.connection.transaction()?;
        let summary = Self::persist_index_scan_in_transaction(
            &transaction,
            session_file,
            file_identity,
            project_id,
            report,
            generation,
            evidence,
        )?;
        transaction.commit()?;
        Ok(summary)
    }

    fn persist_index_scan_in_transaction(
        transaction: &rusqlite::Transaction<'_>,
        session_file: &Path,
        file_identity: String,
        project_id: Option<&str>,
        report: &ScanReport,
        generation: i64,
        evidence: PersistedScanEvidence<'_>,
    ) -> Result<SessionSummary, IndexError> {
        let file_path = session_file.to_string_lossy().into_owned();
        let branch_count = (!evidence.catalog_only).then_some(report.branch_count as i64);
        // A native file identity, scoped to the same project, is the stable
        // session association. Path text is only its current cache location.
        // This transaction prevents a rename or replacement from exposing an
        // intermediate duplicate/incorrect opaque ID.
        let identity_match: Option<String> = transaction
            .query_row(
                "SELECT id FROM sessions_index WHERE project_id IS ?1 AND file_identity = ?2 ORDER BY id LIMIT 1",
                params![project_id, &file_identity],
                |row| row.get(0),
            )
            .optional()?;
        let id = identity_match.unwrap_or_else(|| Uuid::new_v4().to_string());
        // A different object now occupying this spelling must not inherit the
        // old ID. Conversely, remove a target collision before moving an
        // identity-matched row to its renamed path.
        transaction.execute(
            "DELETE FROM sessions_index WHERE file_path = ?1 AND id <> ?2",
            params![&file_path, &id],
        )?;
        let (title, title_source) = title_from_report(report, &id);
        transaction.execute(
            "INSERT INTO sessions_index (id, file_path, project_id, pi_session_id, name, title_source, created_at, updated_at, first_user_preview, last_message_preview, entry_count, branch_count, current_leaf_id, model_ref, parse_state, file_revision, file_identity, source_length, source_modified_stamp, source_continuity_digest, source_parser_version, index_generation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
             ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, project_id=excluded.project_id, pi_session_id=excluded.pi_session_id, name=excluded.name, title_source=excluded.title_source, created_at=excluded.created_at, updated_at=excluded.updated_at, first_user_preview=excluded.first_user_preview, last_message_preview=excluded.last_message_preview, entry_count=excluded.entry_count, branch_count=excluded.branch_count, current_leaf_id=excluded.current_leaf_id, model_ref=excluded.model_ref, parse_state=excluded.parse_state, file_revision=excluded.file_revision, file_identity=excluded.file_identity, source_length=excluded.source_length, source_modified_stamp=excluded.source_modified_stamp, source_continuity_digest=excluded.source_continuity_digest, source_parser_version=excluded.source_parser_version, index_generation=excluded.index_generation",
            params![&id, &file_path, project_id, report.pi_session_id, &title, title_source.as_db(), report.created_at, report.updated_at, report.first_user_preview, report.last_message_preview, report.entry_count as i64, branch_count, report.current_leaf_id, report.model_ref, parse_state_db(report.parse_state), report.file_revision, &file_identity, evidence.fingerprint.map(|value| value.length as i64), evidence.fingerprint.and_then(|value| value.modified_stamp), evidence.fingerprint.map(|value| &value.continuity_digest), evidence.fingerprint.map(|value| value.parser_version), generation],
        )?;
        Ok(SessionSummary {
            id,
            project_id: project_id.map(ToOwned::to_owned),
            title,
            title_source,
            created_at: report.created_at.clone(),
            updated_at: report.updated_at.clone(),
            preview: report
                .last_message_preview
                .clone()
                .or_else(|| report.first_user_preview.clone()),
            entry_count: report.entry_count,
            branch_count: branch_count.map(|value| value as usize),
            parse_state: report.parse_state,
            model_ref: report.model_ref.clone(),
        })
    }

    /// Searches only existing, bounded SQLite session metadata for one project.
    /// It never reads JSONL or searches raw session/tool/thinking payloads.
    /// Results are capped and path-free for trusted host callers to forward.
    pub fn search_project_sessions(
        &self,
        project_id: &str,
        query: &str,
    ) -> Result<Vec<SessionSummary>, IndexError> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > SESSION_SEARCH_QUERY_MAX_CHARS {
            return Err(IndexError::InvalidSessionSearchQuery);
        }
        let pattern = format!("%{}%", escape_like_pattern(&query.to_lowercase()));
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, name, title_source, created_at, updated_at, first_user_preview, last_message_preview, entry_count, branch_count, parse_state, model_ref
             FROM sessions_index
             WHERE project_id = ?1
               AND (
                    piui_casefold(COALESCE(name, '')) LIKE ?2 ESCAPE '\\'
                    OR piui_casefold(COALESCE(first_user_preview, '')) LIKE ?2 ESCAPE '\\'
                    OR piui_casefold(COALESCE(last_message_preview, '')) LIKE ?2 ESCAPE '\\'
               )
             ORDER BY updated_at DESC, id
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![project_id, pattern, SESSION_SEARCH_RESULT_LIMIT],
            session_summary_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from)
    }

    /// Searches existing SQLite metadata across an explicit, bounded project-ID
    /// allowlist. An empty allowlist returns before preparing SQL, so it can
    /// never broaden into a global session search. To keep index-mutex work
    /// bounded, matching runs only over at most 256 newest candidate rows,
    /// divided evenly among allowed projects; older matches are intentionally
    /// outside this search API's coverage. This never reads JSONL.
    pub fn search_sessions_for_projects(
        &self,
        project_ids: &[String],
        query: &str,
        limit: usize,
    ) -> Result<Vec<SessionSummary>, IndexError> {
        if project_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if project_ids.len() > SESSION_SEARCH_PROJECT_ID_LIMIT {
            return Err(IndexError::SessionSearchProjectLimitExceeded);
        }
        let project_ids: BTreeSet<&str> = project_ids.iter().map(String::as_str).collect();
        let query = query.trim();
        if query.is_empty() || query.chars().count() > SESSION_SEARCH_QUERY_MAX_CHARS {
            return Err(IndexError::InvalidSessionSearchQuery);
        }
        let pattern = format!("%{}%", escape_like_pattern(&query.to_lowercase()));
        let columns = "id, project_id, name, title_source, created_at, updated_at, first_user_preview, last_message_preview, entry_count, branch_count, parse_state, model_ref";
        let per_project_candidate_limit =
            (SESSION_SEARCH_CANDIDATE_ROW_BUDGET / project_ids.len()).max(1);
        // Each branch uses the migrated `(project_id, updated_at DESC, id)`
        // index and is limited before the outer Unicode matcher/global sort.
        let candidate_branches = project_ids
            .iter()
            .enumerate()
            .map(|(index, _)| {
                format!(
                    "SELECT {columns} FROM (SELECT {columns} FROM sessions_index WHERE project_id = ?{} ORDER BY updated_at DESC, id LIMIT {per_project_candidate_limit})",
                    index + 1
                )
            })
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        let pattern_parameter = project_ids.len() + 1;
        let limit_parameter = pattern_parameter + 1;
        let sql = format!(
            "SELECT {columns}
             FROM ({candidate_branches}) AS candidates
             WHERE piui_casefold(COALESCE(name, '')) LIKE ?{pattern_parameter} ESCAPE '\\'
                OR piui_casefold(COALESCE(first_user_preview, '')) LIKE ?{pattern_parameter} ESCAPE '\\'
                OR piui_casefold(COALESCE(last_message_preview, '')) LIKE ?{pattern_parameter} ESCAPE '\\'
             ORDER BY updated_at DESC, id
             LIMIT ?{limit_parameter}"
        );
        let mut parameters: Vec<SqlValue> = project_ids
            .into_iter()
            .map(|project_id| SqlValue::Text(project_id.into()))
            .collect();
        parameters.push(SqlValue::Text(pattern));
        parameters.push(SqlValue::Integer(
            limit.min(SESSION_SEARCH_RESULT_LIMIT as usize) as i64,
        ));
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(parameters), session_summary_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from)
    }

    pub fn list_sessions(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<SessionSummary>, IndexError> {
        let sql = if project_id.is_some() {
            "SELECT id, project_id, name, title_source, created_at, updated_at, first_user_preview, last_message_preview, entry_count, branch_count, parse_state, model_ref FROM sessions_index WHERE project_id = ?1 ORDER BY updated_at DESC, id"
        } else {
            "SELECT id, project_id, name, title_source, created_at, updated_at, first_user_preview, last_message_preview, entry_count, branch_count, parse_state, model_ref FROM sessions_index WHERE project_id IS NULL ORDER BY updated_at DESC, id"
        };
        let mut statement = self.connection.prepare(sql)?;
        let mapper = |row: &rusqlite::Row<'_>| session_summary_row(row);
        let rows = if let Some(project_id) = project_id {
            statement.query_map(params![project_id], mapper)?
        } else {
            statement.query_map([], mapper)?
        };
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(IndexError::from)
    }

    pub fn remove_session_projection(
        &mut self,
        session_file: impl AsRef<Path>,
    ) -> Result<bool, IndexError> {
        let changed = self.connection.execute(
            "DELETE FROM sessions_index WHERE file_path = ?1",
            params![session_file.as_ref().to_string_lossy()],
        )?;
        Ok(changed > 0)
    }

    /// Deletes rebuildable cached session associations for one project identity.
    /// This only mutates SQLite; it never opens, rewrites, or removes JSONL
    /// session files. The return value is the number of cache rows removed.
    pub fn purge_project_sessions(&mut self, project_id: &str) -> Result<usize, IndexError> {
        self.connection
            .execute(
                "DELETE FROM sessions_index WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(IndexError::from)
    }

    /// Deletes only rebuildable session rows. Project registry records survive.
    pub fn rebuild_session_projection(&mut self) -> Result<(), IndexError> {
        self.connection.execute("DELETE FROM sessions_index", [])?;
        Ok(())
    }
}

fn project_generation_key(project_id: &str) -> String {
    format!("project-discovery-generation:{project_id}")
}

fn parse_project_generation(value: &str) -> Result<i64, IndexError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|generation| *generation > 0)
        .ok_or(IndexError::ProjectDiscoveryGenerationUnavailable)
}

fn project_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSummary> {
    let trust: String = row.get(3)?;
    let trust_state = TrustState::from_db(&trust).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let pinned = match row.get::<_, i64>(4)? {
        0 => false,
        1 => true,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Integer,
                Box::new(IndexError::InvalidStoredValue("pinned")),
            ));
        }
    };
    Ok(ProjectSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        display_path: row.get(2)?,
        trust_state,
        pinned,
        missing: row.get::<_, Option<i64>>(5)?.is_some(),
        last_opened_at: row.get(6)?,
    })
}

fn session_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    let source: String = row.get(3)?;
    let parse: String = row.get(10)?;
    let title_source = TitleSource::from_db(&source).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let parse_state = parse_state_from_db(&parse).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let first: Option<String> = row.get(6)?;
    let last: Option<String> = row.get(7)?;
    Ok(SessionSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        title_source,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        preview: last.or(first),
        entry_count: row.get::<_, i64>(8)? as usize,
        branch_count: row.get::<_, Option<i64>>(9)?.map(|value| value as usize),
        parse_state,
        model_ref: row.get(11)?,
    })
}

fn parse_state_db(state: ParseState) -> &'static str {
    match state {
        ParseState::Healthy => "healthy",
        ParseState::Partial => "partial",
        ParseState::Unsupported => "unsupported",
        ParseState::Corrupt => "corrupt",
    }
}
fn parse_state_from_db(value: &str) -> Result<ParseState, IndexError> {
    match value {
        "healthy" => Ok(ParseState::Healthy),
        "partial" => Ok(ParseState::Partial),
        "unsupported" => Ok(ParseState::Unsupported),
        "corrupt" => Ok(ParseState::Corrupt),
        _ => Err(IndexError::InvalidStoredValue("parse_state")),
    }
}
fn title_from_report(report: &ScanReport, id: &str) -> (String, TitleSource) {
    if let Some(name) = report
        .session_name
        .as_deref()
        .map(|name| safe_text(name, PREVIEW_LIMIT))
        .filter(|name| !name.is_empty())
    {
        return (name, TitleSource::PiName);
    }
    if let Some(preview) = report
        .first_user_preview
        .as_deref()
        .map(|value| safe_text(value, PREVIEW_LIMIT))
        .filter(|value| !value.is_empty())
    {
        return (preview, TitleSource::FirstUserMessage);
    }
    (
        format!("Session {}", id.chars().take(8).collect::<String>()),
        TitleSource::DateId,
    )
}
fn contract_parse_state(state: ParseState) -> SessionParseState {
    match state {
        ParseState::Healthy => SessionParseState::Healthy,
        ParseState::Partial => SessionParseState::Partial,
        ParseState::Unsupported => SessionParseState::Unsupported,
        ParseState::Corrupt => SessionParseState::Corrupt,
    }
}

fn contract_title_source(source: TitleSource) -> SessionTitleSource {
    match source {
        TitleSource::PiName => SessionTitleSource::PiName,
        TitleSource::FirstUserMessage => SessionTitleSource::FirstUserMessage,
        TitleSource::DateId => SessionTitleSource::DateId,
        TitleSource::UiAlias => SessionTitleSource::UiAlias,
    }
}

fn model_ref(id: String) -> ModelRef {
    ModelRef {
        provider: "pi".into(),
        id,
    }
}

impl ProjectSummary {
    /// Contract projection intentionally drops even the safe display path: the
    /// current foundation contract has no display-path field.
    pub fn contract_summary(&self) -> ContractProjectSummary {
        ContractProjectSummary {
            id: ProjectId::new(self.id.clone()),
            name: self.name.clone(),
            trust_state: match self.trust_state {
                TrustState::Unknown => ProjectTrustState::Unknown,
                TrustState::Trusted => ProjectTrustState::Trusted,
                TrustState::Restricted => ProjectTrustState::Restricted,
            },
            missing: self.missing,
            last_opened_at: self.last_opened_at.map(|time| time.to_string()),
        }
    }
}

impl SessionSummary {
    pub fn contract_summary(&self) -> ContractSessionSummary {
        ContractSessionSummary {
            id: SessionId::new(self.id.clone()),
            project_id: self.project_id.clone().map(ProjectId::new),
            title: self.title.clone(),
            title_source: contract_title_source(self.title_source),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            preview: self.preview.clone(),
            entry_count: self.entry_count as u64,
            branch_count: self.branch_count.map(|count| count as u64),
            parse_state: contract_parse_state(self.parse_state),
            runtime_state: None,
            model: self.model_ref.clone().map(model_ref),
        }
    }
}

fn safe_display_path(path: &Path) -> String {
    let leaf = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| safe_text(name, PREVIEW_LIMIT))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Project".into());
    format!("…/{leaf}")
}
fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_text_redacts_windows_and_unicode_absolute_paths() {
        assert_eq!(
            redact_display_text(r"D:\\Users\\example\\Private\\result.txt"),
            "<external-path>/result.txt"
        );
        assert_eq!(
            redact_display_text("/home/Тест/Секреты/result.txt"),
            "<external-path>/result.txt"
        );
    }

    #[test]
    fn render_projection_correlates_v3_tools_and_keeps_display_detail_separate_from_preview() {
        let markdown = format!("# Detailed markdown\n{}", "x".repeat(PREVIEW_LIMIT + 80));
        let input = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"toolCall\",\"id\":\"private-call-id\",\"name\":\"bash\",\"arguments\":\"pwd\"}}]}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"toolResult\",\"toolCallId\":\"private-call-id\",\"content\":\"/safe/output\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}\n",
            serde_json::to_string(&markdown).expect("encodes markdown")
        );
        let indexed = scan_bytes("session.jsonl", input.as_bytes());
        assert_eq!(
            indexed.entries[2].preview.as_ref().map(String::len),
            Some(PREVIEW_LIMIT)
        );

        let rendered = scan_bytes_for_display("session.jsonl", input.as_bytes());
        assert_eq!(rendered.timeline_blocks.len(), 2);
        let tool = &rendered.timeline_blocks[0];
        assert_eq!(tool.kind, GenericBlockKind::Tool);
        assert_eq!(tool.tool_name.as_deref(), Some("bash"));
        assert_eq!(tool.status, GenericBlockStatus::Complete);
        assert_eq!(tool.preview.as_deref(), Some("<external-path>/output"));
        assert!(!tool.fallback);
        assert!(
            !serde_json::to_string(tool)
                .expect("serializes projection")
                .contains("private-call-id")
        );
        let user = &rendered.timeline_blocks[1];
        assert_eq!(user.kind, GenericBlockKind::User);
        assert!(
            user.preview
                .as_ref()
                .is_some_and(|text| text.len() > PREVIEW_LIMIT)
        );
    }
    #[test]
    fn render_projection_redacts_known_project_and_external_paths() {
        let project_root = Path::new("/workspace/PiUI");
        let content = "Read /workspace/PiUI/src/main.rs and /private/cache/result.txt";
        let input = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":{}}}}}\n",
            serde_json::to_string(content).expect("encodes content")
        );
        let blocks =
            scan_bytes_for_display_with_root("session.jsonl", input.as_bytes(), Some(project_root))
                .timeline_blocks;
        assert_eq!(
            blocks[0].preview.as_deref(),
            Some("Read <workspace>/src/main.rs and <external-path>/result.txt")
        );
        let serialized = serde_json::to_string(&blocks).expect("serializes redacted projection");
        assert!(!serialized.contains("/workspace/PiUI"));
        assert!(!serialized.contains("/private/cache"));
    }

    #[test]
    fn render_projection_preserves_assistant_content_order() {
        let input = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"before\"},{\"type\":\"thinking\",\"thinking\":\"reason\"},{\"type\":\"toolCall\",\"id\":\"call\",\"name\":\"read\",\"arguments\":{\"path\":\"private/path\"}},{\"type\":\"text\",\"text\":\"after\"}]}}\n";
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(
            blocks.iter().map(|block| block.kind).collect::<Vec<_>>(),
            vec![
                GenericBlockKind::Assistant,
                GenericBlockKind::Thinking,
                GenericBlockKind::Tool,
                GenericBlockKind::Assistant,
            ]
        );
        assert_eq!(blocks[0].preview.as_deref(), Some("before"));
        assert_eq!(blocks[3].preview.as_deref(), Some("after"));
        assert_eq!(blocks[2].title.as_deref(), Some("Read file"));
        assert!(
            !serde_json::to_string(&blocks)
                .expect("serializes")
                .contains("private/path")
        );
    }

    #[test]
    fn render_projection_does_not_treat_a_real_ellipsis_as_truncation() {
        let input = "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"bash\",\"content\":\"waiting…\"}}\n";
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks[0].preview.as_deref(), Some("waiting…"));
        assert!(!blocks[0].truncated);
    }

    #[test]
    fn render_projection_caps_multibyte_content_in_bytes() {
        let content = "🦀".repeat(DISPLAY_MESSAGE_LIMIT);
        let input = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}\n",
            serde_json::to_string(&content).expect("encodes content")
        );
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        let block = &blocks[0];
        assert!(
            block
                .preview
                .as_ref()
                .is_some_and(|text| text.len() <= DISPLAY_MESSAGE_LIMIT)
        );
        assert!(block.truncated);
    }

    #[test]
    fn render_projection_marks_aborted_tool_calls_interrupted() {
        let input = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"aborted\",\"content\":[{\"type\":\"toolCall\",\"id\":\"call\",\"name\":\"bash\",\"arguments\":{}}]}}\n";
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].status, GenericBlockStatus::Interrupted);
    }

    #[test]
    fn render_projection_preserves_bounded_assistant_failure_text() {
        let input = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"Provider request failed\"}}\n";
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, GenericBlockKind::Assistant);
        assert_eq!(blocks[0].status, GenericBlockStatus::Failed);
        assert_eq!(
            blocks[0].preview.as_deref(),
            Some("Provider request failed")
        );
    }

    #[test]
    fn render_projection_allowlists_unknown_tool_names() {
        let input = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"D:\\private\\tool","arguments":{}}]}}
"#;
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks[0].title.as_deref(), Some("Tool activity"));
        assert_eq!(blocks[0].tool_name.as_deref(), Some("Tool activity"));
        assert!(
            !serde_json::to_string(&blocks)
                .expect("serializes safe tool projection")
                .contains("private")
        );
    }

    #[test]
    fn render_projection_never_copies_raw_tool_arguments_into_content() {
        let input = "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"call\",\"name\":\"write\",\"arguments\":{\"path\":\"src/file.rs\",\"content\":\"private argument body\"}}]}}\n";
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, GenericBlockKind::Tool);
        assert_eq!(blocks[0].title.as_deref(), Some("Write file"));
        assert!(blocks[0].preview.is_none());
        assert!(
            !serde_json::to_string(&blocks)
                .expect("serializes projection")
                .contains("private argument body")
        );
    }

    #[test]
    fn render_projection_suppresses_hidden_custom_state_and_projects_bash_and_compaction() {
        let input = concat!(
            "{\"type\":\"custom\",\"content\":\"state\"}\n",
            "{\"type\":\"custom_message\",\"display\":false,\"content\":\"hidden\"}\n",
            "{\"type\":\"custom_message\",\"content\":\"shown\"}\n",
            "{\"type\":\"bashExecution\",\"command\":\"git status\\nignored\",\"output\":\"clean\",\"cancelled\":true,\"truncated\":true}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"bashExecution\",\"content\":{\"command\":\"pwd\",\"output\":\"repo\"}}}\n",
            "{\"type\":\"compaction\",\"summary\":\"Earlier context summarized\"}\n"
        );
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].kind, GenericBlockKind::Custom);
        assert_eq!(blocks[0].preview.as_deref(), Some("shown"));
        assert_eq!(blocks[1].kind, GenericBlockKind::Tool);
        assert_eq!(blocks[1].title.as_deref(), Some("bash"));
        assert_eq!(blocks[1].preview.as_deref(), Some("clean…"));
        assert_eq!(blocks[1].status, GenericBlockStatus::Interrupted);
        assert!(blocks[1].truncated);
        assert_eq!(blocks[2].kind, GenericBlockKind::Tool);
        assert_eq!(blocks[2].title.as_deref(), Some("bash"));
        assert_eq!(blocks[2].preview.as_deref(), Some("repo"));
        assert_eq!(blocks[3].kind, GenericBlockKind::Compaction);
        assert_eq!(
            blocks[3].preview.as_deref(),
            Some("Earlier context summarized")
        );
    }

    #[test]
    fn render_projection_trims_oldest_display_before_newest_content() {
        let message = "x".repeat(DISPLAY_MESSAGE_LIMIT);
        let mut input = String::new();
        for index in 0..70 {
            input.push_str(&format!(
                "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":\"{index}:{message}\"}}}}\n"
            ));
        }
        let blocks = scan_bytes_for_display("session.jsonl", input.as_bytes()).timeline_blocks;
        let total: usize = blocks
            .iter()
            .filter_map(|block| block.preview.as_ref())
            .map(String::len)
            .sum();
        assert!(total <= DISPLAY_TOTAL_LIMIT);
        assert!(blocks.first().is_some_and(|block| block.preview.is_none()));
        assert!(blocks.last().is_some_and(|block| {
            block
                .preview
                .as_deref()
                .is_some_and(|text| text.starts_with("69:"))
        }));
    }

    use std::fs::{create_dir_all, remove_dir_all, remove_file, write};

    #[test]
    fn lf_only_unicode_separator_and_partial_tail_are_safe() {
        let source = b"{\"type\":\"session\",\"id\":\"s\"}\n{\"type\":\"message\",\"id\":\"complete\",\"message\":{\"role\":\"user\",\"content\":\"a\xe2\x80\xa8b\"}}\n{\"type\":\"message\",\"id\":\"tail\"}";
        let report = scan_bytes("synthetic.jsonl", source);
        assert_eq!(report.parse_state, ParseState::Partial);
        assert_eq!(report.entry_count, 1);
        assert_eq!(report.entries[0].preview.as_deref(), Some("a b"));
        assert_eq!(report.partial_tail_bytes, 30);
        let (frames, complete) = lf_frames("a\u{2028}b\nc".as_bytes());
        assert_eq!(frames.len(), 1);
        assert_eq!(complete, "a\u{2028}b\n".len());
    }

    #[test]
    fn header_cwd_is_exact_host_only_and_bounded() {
        let exact_cwd = "  /private/project with spaces\t  ";
        let header = serde_json::json!({"type": "session", "id": "s", "cwd": exact_cwd});
        let mut bytes = serde_json::to_vec(&header).expect("encodes header");
        bytes.push(b'\n');
        let report = scan_bytes("cwd.jsonl", &bytes);
        assert_eq!(report.project_cwd.as_deref(), Some(exact_cwd));
        let encoded = serde_json::to_string(&report).expect("serializes report");
        assert!(!encoded.contains(exact_cwd));

        let oversized = "x".repeat(HEADER_CWD_MAX_BYTES + 1);
        let header = serde_json::json!({"type": "session", "cwd": oversized});
        let mut bytes = serde_json::to_vec(&header).expect("encodes oversized header");
        bytes.push(b'\n');
        let report = scan_bytes("oversized-cwd.jsonl", &bytes);
        assert!(report.project_cwd.is_none());
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "header-cwd-too-long")
        );
    }

    #[test]
    fn tree_projection_has_linear_bounded_chain_and_output_fallbacks() {
        let mut input = String::from("{\"type\":\"session\",\"id\":\"s\"}\n");
        for index in 0..(TREE_MAX_DEPTH + 2) {
            let parent = index
                .checked_sub(1)
                .map(|parent| format!(",\"parentId\":\"n{parent}\""));
            input.push_str(&format!(
                "{{\"type\":\"message\",\"id\":\"n{index}\"{} }}\n",
                parent.unwrap_or_default()
            ));
        }
        let report = scan_bytes("deep.jsonl", input.as_bytes());
        assert!(report.tree.len() <= TREE_MAX_OUTPUT_NODES);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "tree-depth-limit")
        );

        let mut wide = String::from("{\"type\":\"session\",\"id\":\"s\"}\n");
        for index in 0..(TREE_MAX_NODES + 1) {
            wide.push_str(&format!("{{\"type\":\"message\",\"id\":\"w{index}\"}}\n"));
        }
        let report = scan_bytes("wide.jsonl", wide.as_bytes());
        assert_eq!(report.tree.len(), TREE_MAX_OUTPUT_NODES);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "tree-node-limit")
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "tree-output-limit")
        );
    }

    #[test]
    fn scanner_projects_known_types_and_generic_blocks_deterministically() {
        let input = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"sess\",\"name\":\"Fixture\",\"cwd\":\"/private/project\"}\n",
            "{\"type\":\"message\",\"id\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"Hello world 👋\"}}\n",
            "{\"type\":\"message\",\"id\":\"assistant\",\"parentId\":\"root\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Answer\"}]}}\n",
            "{\"type\":\"compaction\",\"id\":\"compact\",\"parentId\":\"assistant\"}\n",
            "{\"type\":\"message\",\"id\":\"image\",\"parentId\":\"compact\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"x\"}]}}\n"
        );
        let first = scan_bytes("fixture.jsonl", input.as_bytes());
        let second = scan_bytes("fixture.jsonl", input.as_bytes());
        assert_eq!(first, second);
        assert_eq!(first.parse_state, ParseState::Healthy);
        assert_eq!(first.pi_session_id.as_deref(), Some("sess"));
        assert_eq!(first.entry_count, 4);
        assert_eq!(first.image_entry_count, 1);
        assert_eq!(first.compaction_entry_count, 1);
        assert_eq!(first.roots, vec!["root"]);
        assert_eq!(first.current_leaf_id.as_deref(), Some("image"));
        assert_eq!(first.timeline_blocks[2].kind, GenericBlockKind::Compaction);
        let contract_page = first.timeline_page(SessionId::new("opaque-session"));
        assert_eq!(contract_page.blocks.len(), 4);
        assert_eq!(contract_page.blocks[2].kind, TimelineBlockKind::Compaction);
        assert_eq!(
            contract_page.blocks[0].source.session_id.as_str(),
            "opaque-session"
        );
        let contract_tree = first.read_only_tree(SessionId::new("opaque-session"));
        assert!(
            contract_tree
                .nodes
                .iter()
                .any(|node| node.role_or_type == "user")
        );
        let projection = first.contract_projection(SessionId::new("opaque-session"), None);
        let encoded_projection =
            serde_json::to_string(&projection).expect("serializes safe projection");
        assert!(!encoded_projection.contains("/private/project"));
    }

    #[test]
    fn unknown_payload_never_enters_projection() {
        let input = concat!(
            "{\"type\":\"future_header\",\"prompt\":\"TOP SECRET\",\"opaque\":true}\n",
            "{\"type\":\"future_entry\",\"id\":\"next\",\"content\":\"DO NOT LEAK\"}\n"
        );
        let report = scan_bytes("future.jsonl", input.as_bytes());
        let encoded = serde_json::to_string(&report).expect("serializes report");
        assert_eq!(report.parse_state, ParseState::Unsupported);
        assert_eq!(report.unknown_entries.len(), 2);
        assert!(report.entries.iter().all(|entry| entry.preview.is_none()));
        assert!(
            report
                .timeline_blocks
                .iter()
                .all(|block| block.kind == GenericBlockKind::Unknown)
        );
        assert!(!encoded.contains("TOP SECRET"));
        assert!(!encoded.contains("DO NOT LEAK"));
        assert!(!encoded.contains("opaque"));
    }

    #[test]
    fn corrupt_duplicate_orphan_and_cycle_only_change_projection() {
        let input = concat!(
            "{\"type\":\"session\",\"id\":\"s\"}\n",
            "{\"type\":\"message\",\"id\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"root\"}}\n",
            "{\"type\":\"message\",\"id\":\"orphan\",\"parentId\":\"missing\"}\n",
            "{\"type\":\"message\",\"id\":\"cycle-a\",\"parentId\":\"cycle-b\"}\n",
            "{\"type\":\"message\",\"id\":\"cycle-b\",\"parentId\":\"cycle-a\"}\n",
            "{\"type\":\"message\",\"id\":\"duplicate\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"message\",\"id\":\"duplicate\",\"prompt\":\"RAW DUPLICATE\",\"message\":{\"role\":\"assistant\",\"content\":\"second\"}}\n",
            "{\"type\":\"message\",\"id\":\"broken\",\"message\":\n"
        );
        let original = input.as_bytes().to_vec();
        let report = scan_bytes("corrupt.jsonl", &original);
        assert_eq!(report.parse_state, ParseState::Corrupt);
        assert_eq!(report.orphan_ids, vec!["orphan"]);
        assert_eq!(report.cycle_ids, vec!["cycle-a", "cycle-b"]);
        assert!(report.roots.contains(&"cycle-a".into()));
        assert_eq!(
            report
                .tree
                .iter()
                .filter(|node| node.entry_id == "duplicate")
                .count(),
            1
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "duplicate-entry-id")
        );
        assert_eq!(original, input.as_bytes());
    }

    #[test]
    fn timeline_blocks_hide_ambiguous_source_ids_and_keep_only_safe_links() {
        let raw_root = "RAW_ROOT_IDENTIFIER";
        let raw_duplicate = "RAW_DUPLICATE_IDENTIFIER";
        let input = format!(
            concat!(
                "{{\"type\":\"session\",\"id\":\"session\"}}\n",
                "{{\"type\":\"message\",\"id\":\"{raw_root}\",\"message\":{{\"role\":\"user\",\"content\":\"root\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"{raw_duplicate}\",\"parentId\":\"{raw_root}\",\"message\":{{\"role\":\"assistant\",\"content\":\"first duplicate\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"{raw_duplicate}\",\"parentId\":\"{raw_root}\",\"message\":{{\"role\":\"assistant\",\"content\":\"second duplicate\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"\",\"parentId\":\"{raw_root}\",\"message\":{{\"role\":\"assistant\",\"content\":\"malformed id\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"child\",\"parentId\":\"{raw_duplicate}\",\"message\":{{\"role\":\"assistant\",\"content\":\"ambiguous parent\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"cycle-a\",\"parentId\":\"cycle-b\",\"message\":{{\"role\":\"assistant\",\"content\":\"cycle a\"}}}}\n",
                "{{\"type\":\"message\",\"id\":\"cycle-b\",\"parentId\":\"cycle-a\",\"message\":{{\"role\":\"assistant\",\"content\":\"cycle b\"}}}}\n"
            ),
            raw_root = raw_root,
            raw_duplicate = raw_duplicate
        );
        let report = scan_bytes("duplicate-ids.jsonl", input.as_bytes());
        let blocks = &report.timeline_blocks;
        assert_eq!(
            blocks
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "timeline-0",
                "timeline-1",
                "timeline-2",
                "timeline-3",
                "timeline-4",
                "timeline-5",
                "timeline-6",
            ]
        );
        assert_eq!(blocks[1].parent_id.as_deref(), Some("timeline-0"));
        assert_eq!(blocks[2].parent_id.as_deref(), Some("timeline-0"));
        assert_eq!(blocks[3].parent_id.as_deref(), Some("timeline-0"));
        assert!(
            blocks[4].parent_id.is_none(),
            "duplicate source parent is unsafe"
        );
        assert!(blocks[5].parent_id.is_none(), "cycle links are unsafe");
        assert!(blocks[6].parent_id.is_none(), "cycle links are unsafe");
        let encoded = serde_json::to_string(blocks).expect("blocks serialize");
        assert!(!encoded.contains(raw_root));
        assert!(!encoded.contains(raw_duplicate));
    }

    #[test]
    fn timeline_slices_are_bounded_chronological_and_page_without_overlap() {
        let mut input = String::from("{\"type\":\"session\",\"id\":\"session\"}\n");
        for index in 0..(TIMELINE_SLICE_MAX_LIMIT + 5) {
            input.push_str(&format!(
                "{{\"type\":\"message\",\"id\":\"source-{index}\",\"message\":{{\"role\":\"user\",\"content\":\"entry {index}\"}}}}\n"
            ));
        }
        let report = scan_bytes("pagination.jsonl", input.as_bytes());
        let latest = report.timeline_slice_latest(usize::MAX);
        assert_eq!(latest.total, TIMELINE_SLICE_MAX_LIMIT + 5);
        assert_eq!(latest.start, 5);
        assert_eq!(latest.end, TIMELINE_SLICE_MAX_LIMIT + 5);
        assert_eq!(latest.blocks.len(), TIMELINE_SLICE_MAX_LIMIT);
        assert_eq!(latest.blocks[0].id, "timeline-5");
        assert_eq!(
            latest.blocks.last().map(|block| block.id.as_str()),
            Some("timeline-204")
        );
        let older = report.timeline_slice_older(latest.start, 3);
        assert_eq!(
            (older.start, older.end, older.total),
            (2, 5, TIMELINE_SLICE_MAX_LIMIT + 5)
        );
        assert_eq!(
            older
                .blocks
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec!["timeline-2", "timeline-3", "timeline-4"]
        );
        let clamped = report.timeline_slice_older(usize::MAX, 2);
        assert_eq!(
            (clamped.start, clamped.end),
            (TIMELINE_SLICE_MAX_LIMIT + 3, TIMELINE_SLICE_MAX_LIMIT + 5)
        );
    }

    #[test]
    fn invalid_utf8_complete_frame_is_corrupt_but_tail_is_excluded() {
        let report = scan_bytes(
            "bytes.jsonl",
            b"{\"type\":\"session\",\"id\":\"s\"}\n\xff\n\xff",
        );
        assert_eq!(report.parse_state, ParseState::Corrupt);
        assert_eq!(report.partial_tail_bytes, 1);
        assert_eq!(report.diagnostics[0].code, "invalid-utf8");
    }

    #[test]
    fn project_identity_replacement_resets_trust_and_legacy_rows_fail_closed() {
        let root =
            std::env::temp_dir().join(format!("piui-index-project-identity-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let retained_original = root.join("retained-original");
        create_dir_all(&project_path).expect("creates project");
        let original = ProjectDirectory::resolve(&project_path).expect("resolves original");
        let original_identity = original.identity().clone();
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let registered = index
            .register_project_directory(&original, None, TrustState::Trusted)
            .expect("registers trusted project");
        assert!(
            index
                .verify_project_identity(&registered.id, &original_identity)
                .expect("verifies stored identity")
        );
        assert!(
            !serde_json::to_string(&registered)
                .expect("summary serializes")
                .contains(original.identity().storage_token().as_storage_str())
        );
        let session = root.join("cached-history.jsonl");
        write(
            &session,
            b"{\"type\":\"session\",\"id\":\"cached\",\"name\":\"Cached history\"}\n",
        )
        .expect("writes cached session");
        let cached = index
            .index_scan(
                &session,
                Some(&registered.id),
                &scan_file(&session).expect("scans cached session"),
                1,
            )
            .expect("indexes project cache row");
        assert_eq!(
            index
                .list_sessions(Some(&registered.id))
                .expect("lists cached project session")
                .len(),
            1
        );

        fs::rename(&project_path, &retained_original).expect("retains original object");
        create_dir_all(&project_path).expect("creates replacement at same spelling");
        let replacement = ProjectDirectory::resolve(&project_path).expect("resolves replacement");
        assert_ne!(replacement.identity(), &original_identity);
        let re_registered = index
            .register_project_directory(&replacement, None, TrustState::Trusted)
            .expect("registers replacement safely");
        assert_eq!(re_registered.id, registered.id);
        assert_eq!(re_registered.trust_state, TrustState::Restricted);
        assert!(
            index
                .list_sessions(Some(&registered.id))
                .expect("replacement cache listing is safe")
                .is_empty()
        );
        assert!(
            index
                .indexed_session_file_path(&cached.id)
                .expect("purged cache lookup is safe")
                .is_none()
        );
        assert!(session.is_file(), "replacement purge never touches JSONL");
        assert!(
            index
                .verify_project_identity(&registered.id, replacement.identity())
                .expect("verifies replacement identity")
        );
        assert!(
            !index
                .verify_project_identity(&registered.id, &original_identity)
                .expect("old identity no longer matches")
        );

        index
            .connection
            .execute(
                "UPDATE projects SET directory_identity = NULL WHERE id = ?1",
                params![registered.id],
            )
            .expect("simulates legacy project row");
        assert!(matches!(
            index.stored_project_identity(&re_registered.id),
            Err(IndexError::ProjectIdentityUnavailable)
        ));
        assert!(matches!(
            index.verify_project_identity(&re_registered.id, replacement.identity()),
            Err(IndexError::ProjectIdentityUnavailable)
        ));

        remove_dir_all(&root).expect("removes project fixture");
    }

    #[test]
    fn preferences_default_after_legacy_index_state_migration() {
        let database =
            std::env::temp_dir().join(format!("piui-index-preferences-{}.db", Uuid::new_v4()));
        {
            let connection = Connection::open(&database).expect("creates legacy database");
            connection
                .execute_batch(
                    "CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
                )
                .expect("creates legacy index state");
        }
        let index = ProjectIndex::open(&database).expect("migrates legacy database");
        assert_eq!(
            index.preferences().expect("loads default preferences"),
            Preferences::default()
        );
        drop(index);
        remove_file(&database).expect("removes fixture database");
    }

    #[test]
    fn v1_preferences_preserve_existing_values_and_default_new_appearance_controls() {
        let index = ProjectIndex::open_in_memory().expect("opens index");
        index
            .connection
            .execute(
                "INSERT INTO index_state (key, value) VALUES (?1, ?2)",
                params![PREFERENCES_STATE_KEY, "v1|light|compact|reduce"],
            )
            .expect("seeds v1 preferences");

        assert_eq!(
            index.preferences().expect("migrates v1 preferences"),
            Preferences {
                theme: ThemePreference::Light,
                density: DensityPreference::Compact,
                reduced_motion: ReducedMotionPreference::Reduce,
                font_size: FontSizePreference::Medium,
                chat_width: ChatWidthPreference::Wide,
            }
        );
    }

    #[test]
    fn preferences_round_trip_atomically_and_survive_projection_rebuild() {
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let preferences = Preferences {
            theme: ThemePreference::Dark,
            density: DensityPreference::Compact,
            reduced_motion: ReducedMotionPreference::Reduce,
            font_size: FontSizePreference::Large,
            chat_width: ChatWidthPreference::Focused,
        };
        assert_eq!(
            index
                .update_preferences(preferences)
                .expect("stores preferences atomically"),
            preferences
        );
        assert_eq!(
            index.preferences().expect("loads stored preferences"),
            preferences
        );
        index
            .rebuild_session_projection()
            .expect("rebuilds only session cache");
        assert_eq!(
            index
                .preferences()
                .expect("preferences survive projection rebuild"),
            preferences
        );
    }

    #[test]
    fn malformed_preferences_fail_closed_and_remain_path_free() {
        let root =
            std::env::temp_dir().join(format!("piui-index-preferences-path-{}", Uuid::new_v4()));
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        index
            .connection
            .execute(
                "INSERT INTO index_state (key, value) VALUES (?1, ?2)",
                params![PREFERENCES_STATE_KEY, "v1|dark|unsafe-density|reduce"],
            )
            .expect("seeds malformed preferences");
        assert_eq!(
            index.preferences().expect("malformed preferences are safe"),
            Preferences::default()
        );
        let preferences = Preferences {
            theme: ThemePreference::Light,
            density: DensityPreference::Comfortable,
            reduced_motion: ReducedMotionPreference::System,
            font_size: FontSizePreference::Small,
            chat_width: ChatWidthPreference::Centered,
        };
        index
            .update_preferences(preferences)
            .expect("replaces malformed state");
        let encoded = serde_json::to_string(&preferences).expect("preferences serialize");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        assert_eq!(index.preferences().expect("loads valid state"), preferences);
    }

    #[test]
    fn project_migration_adds_identity_and_pinned_columns_without_populating_legacy_rows() {
        let database = std::env::temp_dir().join(format!(
            "piui-index-project-migration-{}.db",
            Uuid::new_v4()
        ));
        {
            let connection = Connection::open(&database).expect("creates legacy database");
            connection
                .execute_batch(
                    "CREATE TABLE projects (
                        id TEXT PRIMARY KEY,
                        canonical_path TEXT NOT NULL UNIQUE,
                        display_path TEXT NOT NULL,
                        name TEXT NOT NULL,
                        order_key TEXT NOT NULL,
                        trust_state TEXT NOT NULL,
                        added_at INTEGER NOT NULL,
                        last_opened_at INTEGER,
                        missing_since INTEGER
                    );
                    INSERT INTO projects (id, canonical_path, display_path, name, order_key, trust_state, added_at)
                    VALUES ('legacy-project', 'private-path', '…/project', 'Project', '0', 'trusted', 0);",
                )
                .expect("creates legacy projects table");
        }
        let index = ProjectIndex::open(&database).expect("migrates legacy database");
        let column: Option<String> = index
            .connection
            .query_row(
                "SELECT name FROM pragma_table_info('projects') WHERE name = 'directory_identity'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("reads migrated schema");
        assert_eq!(column.as_deref(), Some("directory_identity"));
        let pinned_column: Option<String> = index
            .connection
            .query_row(
                "SELECT name FROM pragma_table_info('projects') WHERE name = 'pinned'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("reads pinned migration");
        assert_eq!(pinned_column.as_deref(), Some("pinned"));
        let active_order_index: Option<String> = index
            .connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_active_pinned_order'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("reads active-project index migration");
        assert_eq!(
            active_order_index.as_deref(),
            Some("projects_active_pinned_order")
        );
        assert!(!index.list_projects().expect("lists migrated project")[0].pinned);
        assert!(matches!(
            index.stored_project_identity("legacy-project"),
            Err(IndexError::ProjectIdentityUnavailable)
        ));
        drop(index);
        remove_file(&database).expect("removes legacy database");
    }

    #[test]
    fn project_metadata_rename_pin_and_order_are_path_safe() {
        let root =
            std::env::temp_dir().join(format!("piui-index-project-metadata-{}", Uuid::new_v4()));
        let paths = [root.join("alpha"), root.join("beta"), root.join("gamma")];
        for path in &paths {
            create_dir_all(path).expect("creates project fixture");
        }
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        for path in &paths {
            index
                .register_project(path, None, TrustState::Restricted)
                .expect("registers project");
        }
        let baseline = index.list_projects().expect("lists unpinned projects");
        let target_id = baseline[1].id.clone();
        let expected_unpinned: Vec<String> = baseline
            .iter()
            .filter(|project| project.id != target_id)
            .map(|project| project.id.clone())
            .collect();
        let pinned = index
            .set_project_pinned(&target_id, true)
            .expect("pins registered project")
            .expect("project exists");
        assert!(pinned.pinned);
        let ordered = index.list_projects().expect("lists pinned-first projects");
        assert_eq!(ordered[0].id, target_id);
        assert_eq!(
            ordered[1..]
                .iter()
                .map(|project| project.id.clone())
                .collect::<Vec<_>>(),
            expected_unpinned
        );
        let renamed = index
            .rename_project(&target_id, "\n  Renamed \u{0} Project\t")
            .expect("renames project")
            .expect("project exists");
        assert_eq!(renamed.name, "Renamed Project");
        assert!(renamed.pinned);
        assert!(matches!(
            index.rename_project(&target_id, "\n\t\u{0}"),
            Err(IndexError::InvalidProjectName)
        ));
        assert!(
            index
                .rename_project("missing-project", "Valid name")
                .expect("missing project is safe")
                .is_none()
        );
        assert!(
            !serde_json::to_string(&renamed)
                .expect("summary serializes")
                .contains(&root.to_string_lossy().to_string())
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn active_project_search_allowlist_is_capped_pinned_first_and_path_free() {
        let root =
            std::env::temp_dir().join(format!("piui-index-active-projects-{}", Uuid::new_v4()));
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        for sequence in 0..(SESSION_SEARCH_PROJECT_ID_LIMIT + 2) {
            let project_path = root.join(format!("project-{sequence}"));
            create_dir_all(&project_path).expect("creates project fixture");
            index
                .register_project(&project_path, None, TrustState::Restricted)
                .expect("registers project");
        }
        let baseline = index.list_projects().expect("lists registered projects");
        let missing_id = baseline[0].id.clone();
        let pinned_id = baseline
            .last()
            .expect("registered projects exist")
            .id
            .clone();
        index
            .mark_project_missing(&missing_id, true)
            .expect("marks project missing");
        index
            .set_project_pinned(&pinned_id, true)
            .expect("pins active project");
        let mut statement = index
            .connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT id FROM projects WHERE missing_since IS NULL ORDER BY pinned DESC, order_key, id LIMIT 64",
            )
            .expect("prepares active-project query plan");
        let plan = statement
            .query_map([], |row| row.get::<_, String>(3))
            .expect("reads active-project query plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("collects active-project query plan");
        assert!(
            plan.iter()
                .any(|detail| detail.contains("projects_active_pinned_order"))
        );
        assert!(
            plan.iter()
                .all(|detail| !detail.contains("USE TEMP B-TREE"))
        );
        let mut expected = vec![pinned_id.clone()];
        expected.extend(
            baseline
                .iter()
                .filter(|project| project.id != missing_id && project.id != pinned_id)
                .map(|project| project.id.clone())
                .take(SESSION_SEARCH_PROJECT_ID_LIMIT - 1),
        );
        let active = index
            .active_project_ids_for_search(usize::MAX)
            .expect("loads bounded active allowlist");
        assert_eq!(active, expected);
        assert_eq!(active.len(), SESSION_SEARCH_PROJECT_ID_LIMIT);
        assert!(!active.contains(&missing_id));
        assert_eq!(
            index
                .active_project_ids_for_search(1)
                .expect("honors smaller caller cap"),
            vec![pinned_id]
        );
        assert!(
            index
                .active_project_ids_for_search(0)
                .expect("zero cap is safe")
                .is_empty()
        );
        assert!(
            !serde_json::to_string(&active)
                .expect("allowlist serializes")
                .contains(&root.to_string_lossy().to_string())
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn removing_project_registry_entry_purges_cache_without_touching_jsonl() {
        let root =
            std::env::temp_dir().join(format!("piui-index-remove-project-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        create_dir_all(&project_path).expect("creates project");
        let session = project_path.join("history.jsonl");
        let session_bytes = b"{\"type\":\"session\",\"id\":\"remove\"}\n";
        write(&session, session_bytes).expect("writes session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Trusted)
            .expect("registers project");
        let indexed = index
            .index_scan(
                &session,
                Some(&project.id),
                &scan_file(&session).expect("scans session"),
                1,
            )
            .expect("indexes session");
        assert!(
            index
                .remove_project_registry_entry(&project.id)
                .expect("removes registry entry")
        );
        assert!(index.list_projects().expect("lists registry").is_empty());
        assert!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists purged cache")
                .is_empty()
        );
        assert!(
            index
                .indexed_session_file_path(&indexed.id)
                .expect("removed lookup is safe")
                .is_none()
        );
        assert!(
            project_path.is_dir(),
            "registry removal never removes folders"
        );
        assert_eq!(
            fs::read(&session).expect("reads unchanged JSONL"),
            session_bytes
        );
        assert!(
            !index
                .remove_project_registry_entry(&project.id)
                .expect("missing removal is safe")
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn project_session_purge_removes_only_cache_associations_and_stays_path_safe() {
        let root = std::env::temp_dir().join(format!("piui-index-trust-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let session = root.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n",
                serde_json::to_string(&root.to_string_lossy().to_string()).expect("encodes cwd")
            ),
        )
        .expect("writes session");

        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        let report = scan_file(&session).expect("scans fixture");
        let indexed = index
            .index_scan(&session, Some(&project.id), &report, 1)
            .expect("indexes session");

        let updated = index
            .update_project_trust(&project.id, TrustState::Trusted)
            .expect("updates existing trust")
            .expect("project exists");
        assert_eq!(updated.trust_state, TrustState::Trusted);
        let encoded = serde_json::to_string(&updated).expect("summary serializes");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        assert!(
            index
                .update_project_trust("missing-project", TrustState::Trusted)
                .expect("missing ID is not an error")
                .is_none()
        );

        let host_file = index
            .indexed_session_file_path(&indexed.id)
            .expect("looks up session")
            .expect("indexed file exists");
        assert_eq!(host_file.as_path(), session.as_path());
        assert!(!format!("{host_file:?}").contains(&root.to_string_lossy().to_string()));
        assert!(
            index
                .indexed_session_file_path("missing-session")
                .expect("missing ID is not an error")
                .is_none()
        );
        assert_eq!(
            index
                .purge_project_sessions(&project.id)
                .expect("purges project cache rows"),
            1
        );
        assert!(
            index
                .list_sessions(Some(&project.id))
                .expect("project sessions list after purge")
                .is_empty()
        );
        assert!(
            index
                .indexed_session_file_path(&indexed.id)
                .expect("purged session lookup is safe")
                .is_none()
        );
        assert!(session.is_file(), "purging never touches the JSONL file");

        remove_file(&session).expect("removes fixture");
        remove_dir_all(&root).expect("removes fixture directory");
    }

    #[test]
    fn project_session_metadata_search_is_unicode_literal_bounded_and_path_safe() {
        let root = std::env::temp_dir().join(format!("piui-index-search-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");

        let fixtures = [
            ("unicode.jsonl", "ЗАГОЛОВОК", None),
            ("percent.jsonl", "100% literal", None),
            ("percent-wildcard.jsonl", "100X literal", None),
            ("underscore.jsonl", "under_score", None),
            ("underscore-wildcard.jsonl", "underXscore", None),
            ("preview.jsonl", "ordinary", Some("Needle preview text")),
        ];
        for (file_name, name, preview) in fixtures {
            let session = root.join(file_name);
            let mut content = format!(
                "{{\"type\":\"session\",\"id\":\"{file_name}\",\"name\":{}}}\n",
                serde_json::to_string(name).expect("encodes name")
            );
            if let Some(preview) = preview {
                content.push_str(&format!(
                    "{{\"type\":\"message\",\"id\":\"message\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}\n",
                    serde_json::to_string(preview).expect("encodes preview")
                ));
            }
            write(&session, content).expect("writes search fixture");
            index
                .index_scan(
                    &session,
                    Some(&project.id),
                    &scan_file(&session).expect("scans search fixture"),
                    1,
                )
                .expect("indexes search fixture");
        }
        assert_eq!(
            index
                .search_project_sessions(&project.id, "заголовок")
                .expect("unicode case-insensitive search")[0]
                .title,
            "ЗАГОЛОВОК"
        );
        assert_eq!(
            index
                .search_project_sessions(&project.id, "100%")
                .expect("literal percent search")
                .iter()
                .map(|summary| summary.title.as_str())
                .collect::<Vec<_>>(),
            vec!["100% literal"]
        );
        assert_eq!(
            index
                .search_project_sessions(&project.id, "under_")
                .expect("literal underscore search")
                .iter()
                .map(|summary| summary.title.as_str())
                .collect::<Vec<_>>(),
            vec!["under_score"]
        );
        assert_eq!(
            index
                .search_project_sessions(&project.id, "needle preview")
                .expect("bounded preview search")[0]
                .title,
            "ordinary"
        );

        let mut expected = Vec::new();
        for value in 0..(SESSION_SEARCH_RESULT_LIMIT + 2) {
            let session = root.join(format!("batch-{value}.jsonl"));
            let content = format!(
                "{{\"type\":\"session\",\"id\":\"batch-{value}\",\"name\":\"batch\"}}\n{{\"type\":\"message\",\"id\":\"message-{value}\",\"timestamp\":\"2024-01-01T00:00:{value:02}Z\",\"message\":{{\"role\":\"user\",\"content\":\"batch\"}}}}\n"
            );
            write(&session, content).expect("writes batch fixture");
            expected.push(
                index
                    .index_scan(
                        &session,
                        Some(&project.id),
                        &scan_file(&session).expect("scans batch fixture"),
                        1,
                    )
                    .expect("indexes batch fixture"),
            );
        }
        expected.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let batch = index
            .search_project_sessions(&project.id, " batch ")
            .expect("trims and limits query");
        assert_eq!(batch, expected[..SESSION_SEARCH_RESULT_LIMIT as usize]);
        let encoded = serde_json::to_string(&batch).expect("search summaries serialize");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        assert!(matches!(
            index.search_project_sessions(&project.id, "  \t\n"),
            Err(IndexError::InvalidSessionSearchQuery)
        ));
        assert!(matches!(
            index.search_project_sessions(
                &project.id,
                &"x".repeat(SESSION_SEARCH_QUERY_MAX_CHARS + 1)
            ),
            Err(IndexError::InvalidSessionSearchQuery)
        ));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn allowlisted_session_search_is_isolated_globally_ordered_and_bounded() {
        let root =
            std::env::temp_dir().join(format!("piui-index-allowlist-search-{}", Uuid::new_v4()));
        let first_path = root.join("first-project");
        let second_path = root.join("second-project");
        let excluded_path = root.join("excluded-project");
        for path in [&first_path, &second_path, &excluded_path] {
            create_dir_all(path).expect("creates project");
        }
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let first_project = index
            .register_project(&first_path, None, TrustState::Restricted)
            .expect("registers first project");
        let second_project = index
            .register_project(&second_path, None, TrustState::Restricted)
            .expect("registers second project");
        let excluded_project = index
            .register_project(&excluded_path, None, TrustState::Restricted)
            .expect("registers excluded project");

        let first_session = root.join("first.jsonl");
        let second_session = root.join("second.jsonl");
        let excluded_session = root.join("excluded.jsonl");
        let fixtures = [
            (
                &first_session,
                &first_project,
                "first",
                "2024-01-01T00:00:01Z",
            ),
            (
                &second_session,
                &second_project,
                "second",
                "2024-01-01T00:00:03Z",
            ),
            (
                &excluded_session,
                &excluded_project,
                "excluded",
                "2024-01-01T00:00:09Z",
            ),
        ];
        let mut indexed = Vec::new();
        for (path, project, name, timestamp) in fixtures {
            let content = format!(
                "{{\"type\":\"session\",\"id\":\"{name}\",\"name\":\"needle {name}\"}}\n{{\"type\":\"message\",\"id\":\"message-{name}\",\"timestamp\":\"{timestamp}\",\"message\":{{\"role\":\"user\",\"content\":\"needle {name}\"}}}}\n"
            );
            write(path, content).expect("writes search fixture");
            indexed.push(
                index
                    .index_scan(
                        path,
                        Some(&project.id),
                        &scan_file(path).expect("scans search fixture"),
                        1,
                    )
                    .expect("indexes search fixture"),
            );
        }
        let allowlist = vec![first_project.id.clone(), second_project.id.clone()];
        let results = index
            .search_sessions_for_projects(&allowlist, "needle", 10)
            .expect("searches allowlisted projects");
        assert_eq!(results, vec![indexed[1].clone(), indexed[0].clone()]);
        assert!(
            results
                .iter()
                .all(|summary| summary.project_id.as_deref() != Some(excluded_project.id.as_str()))
        );
        assert_eq!(
            index
                .search_sessions_for_projects(&allowlist, "needle", 1)
                .expect("enforces caller result limit"),
            vec![indexed[1].clone()]
        );
        let no_projects: Vec<String> = Vec::new();
        assert!(
            index
                .search_sessions_for_projects(
                    &no_projects,
                    &"x".repeat(SESSION_SEARCH_QUERY_MAX_CHARS + 1),
                    10,
                )
                .expect("empty allowlist never broadens search")
                .is_empty()
        );
        assert_eq!(
            fs::read(&first_session).expect("reads unchanged JSONL"),
            b"{\"type\":\"session\",\"id\":\"first\",\"name\":\"needle first\"}\n{\"type\":\"message\",\"id\":\"message-first\",\"timestamp\":\"2024-01-01T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"needle first\"}}\n"
        );
        let encoded = serde_json::to_string(&results).expect("search summaries serialize");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn allowlisted_search_never_matches_beyond_its_candidate_row_budget() {
        let root =
            std::env::temp_dir().join(format!("piui-index-search-budget-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        for value in 0..=SESSION_SEARCH_CANDIDATE_ROW_BUDGET {
            let name = if value == 0 {
                "historic-only-match"
            } else {
                "recent-non-match"
            };
            index
                .connection
                .execute(
                    "INSERT INTO sessions_index (id, file_path, project_id, name, title_source, updated_at, entry_count, parse_state, file_revision, index_generation)
                     VALUES (?1, ?2, ?3, ?4, 'pi-name', ?5, 0, 'healthy', 'revision', 1)",
                    params![
                        format!("session-{value}"),
                        format!("private-cache-{value}"),
                        &project.id,
                        name,
                        format!("2024-01-01T00:00:{value:03}Z"),
                    ],
                )
                .expect("seeds cached metadata without JSONL");
        }
        let allowlist = vec![project.id.clone()];
        assert!(
            index
                .search_sessions_for_projects(&allowlist, "historic-only-match", 10)
                .expect("bounded search is safe")
                .is_empty(),
            "the oldest row is outside the documented candidate budget"
        );
        let recent = index
            .search_sessions_for_projects(&allowlist, "recent-non-match", 1)
            .expect("searches bounded candidates");
        assert_eq!(
            recent[0].updated_at.as_deref(),
            Some("2024-01-01T00:00:256Z")
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn bounded_host_rescan_caps_growth_redacts_errors_and_never_writes() {
        let root = std::env::temp_dir().join(format!("piui-index-rescan-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates fixture root");
        let session = root.join("history.jsonl");
        let original = b"{\"type\":\"session\",\"id\":\"s\"}\n".to_vec();
        write(&session, &original).expect("writes session");
        let report = scan_file(&session).expect("scans indexed content");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let summary = index
            .index_scan(&session, None, &report, 1)
            .expect("persists identity and revision");
        let host_file = index
            .indexed_session_file_path(&summary.id)
            .expect("looks up indexed file")
            .expect("indexed file exists");

        let report = scan_file_bounded(&host_file, 1_024).expect("bounded scan succeeds");
        assert_eq!(report.pi_session_id.as_deref(), Some("s"));
        assert_eq!(fs::read(&session).expect("reads fixture"), original);
        assert!(matches!(
            scan_file_bounded(&host_file, 10),
            Err(BoundedScanError::FileTooLarge { limit: 10 })
        ));

        let grown = [original.clone(), b"x".repeat(512)].concat();
        write(&session, &grown).expect("simulates concurrent growth");
        let error = scan_file_bounded(&host_file, 1_024).expect_err("growth is bounded");
        assert!(matches!(&error, BoundedScanError::RevisionMismatch));
        assert!(
            !error
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );
        assert_eq!(fs::read(&session).expect("scanner did not write"), grown);
        assert!(matches!(
            scan_file_bounded(&host_file, 0),
            Err(BoundedScanError::InvalidByteLimit)
        ));

        remove_file(&session).expect("removes fixture");
        remove_dir_all(&root).expect("removes fixture root");
    }

    #[test]
    fn indexed_identity_rejects_regular_replacement_and_legacy_rows() {
        let root = std::env::temp_dir().join(format!("piui-index-identity-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates fixture root");
        let session = root.join("history.jsonl");
        let bytes = b"{\"type\":\"session\",\"id\":\"s\"}\n";
        write(&session, bytes).expect("writes original session");
        let report = scan_file(&session).expect("scans original");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let summary = index
            .index_scan(&session, None, &report, 1)
            .expect("persists original identity");
        let host_file = index
            .indexed_session_file_path(&summary.id)
            .expect("looks up indexed file")
            .expect("indexed file exists");

        // Create the replacement while the original still exists. Removing and
        // immediately recreating one path can reuse the same inode on Unix,
        // which would make this identity test nondeterministic.
        let replacement_path = root.join("replacement.jsonl");
        write(&replacement_path, bytes).expect("writes distinct replacement");
        remove_file(&session).expect("removes original file");
        fs::rename(&replacement_path, &session).expect("moves replacement into place");
        let replacement = scan_file_bounded(&host_file, 1_024)
            .expect_err("same-content replacement has a different identity");
        assert!(matches!(&replacement, BoundedScanError::Changed));
        assert!(
            !replacement
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );

        index
            .connection
            .execute(
                "UPDATE sessions_index SET file_identity = NULL WHERE id = ?1",
                params![summary.id],
            )
            .expect("simulates a pre-migration row");
        let legacy = index
            .indexed_session_file_path(&summary.id)
            .expect_err("legacy row must be reindexed");
        assert!(matches!(&legacy, IndexError::SessionIdentityUnavailable));
        assert!(
            !legacy
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );

        remove_file(&session).expect("removes replacement");
        remove_dir_all(&root).expect("removes fixture root");
    }

    #[test]
    fn discovery_completeness_fails_closed_on_any_coverage_gap() {
        assert!(SessionDiscoveryStats::default().is_complete());
        let incomplete = [
            SessionDiscoveryStats {
                directory_limit_reached: true,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                entry_limit_reached: true,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                file_limit_reached: true,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                skipped_symlinks: 1,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                skipped_oversize_files: 1,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                skipped_depth_directories: 1,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                skipped_inaccessible_entries: 1,
                ..SessionDiscoveryStats::default()
            },
            SessionDiscoveryStats {
                unattributable_candidates: 1,
                ..SessionDiscoveryStats::default()
            },
        ];
        assert!(incomplete.iter().all(|stats| !stats.is_complete()));
    }

    #[test]
    fn complete_discovery_sweep_removes_only_unseen_project_cache_rows() {
        let root = std::env::temp_dir().join(format!("piui-index-sweep-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let stale = root.join("stale.jsonl");
        let retained = root.join("retained.jsonl");
        write(&stale, b"{\"type\":\"session\",\"id\":\"stale\"}\n").expect("writes stale session");
        write(&retained, b"{\"type\":\"session\",\"id\":\"retained\"}\n")
            .expect("writes retained session");
        let stale_bytes = fs::read(&stale).expect("reads stale sentinel");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates first pass");
        let stale_summary = index
            .index_scan(
                &stale,
                Some(&project.id),
                &scan_file(&stale).expect("scans stale session"),
                first_generation,
            )
            .expect("indexes stale cache row");
        index
            .index_scan(
                &retained,
                Some(&project.id),
                &scan_file(&retained).expect("scans retained session"),
                first_generation,
            )
            .expect("indexes retained cache row");
        let second_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates complete pass");
        let retained_summary = index
            .index_scan(
                &retained,
                Some(&project.id),
                &scan_file(&retained).expect("rescans retained session"),
                second_generation,
            )
            .expect("marks retained session seen");
        assert_eq!(
            index
                .sweep_project_sessions_if_complete(
                    &project.id,
                    second_generation,
                    &SessionDiscoveryStats::default(),
                )
                .expect("sweeps complete pass"),
            1
        );
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists reconciled sessions"),
            vec![retained_summary]
        );
        assert!(
            index
                .indexed_session_file_path(&stale_summary.id)
                .expect("stale lookup is safe")
                .is_none()
        );
        assert_eq!(
            fs::read(&stale).expect("reads unchanged JSONL"),
            stale_bytes
        );
        assert!(
            !serde_json::to_string(&project)
                .expect("summary serializes")
                .contains(&root.to_string_lossy().to_string())
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incomplete_discovery_never_sweeps_project_cache_rows() {
        let root = std::env::temp_dir().join(format!("piui-index-no-sweep-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let session = root.join("history.jsonl");
        write(&session, b"{\"type\":\"session\",\"id\":\"kept\"}\n").expect("writes session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates first pass");
        let indexed = index
            .index_scan(
                &session,
                Some(&project.id),
                &scan_file(&session).expect("scans session"),
                first_generation,
            )
            .expect("indexes session");
        let second_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates incomplete pass");
        let incomplete = SessionDiscoveryStats {
            entry_limit_reached: true,
            ..SessionDiscoveryStats::default()
        };
        assert_eq!(
            index
                .sweep_project_sessions_if_complete(&project.id, second_generation, &incomplete)
                .expect("incomplete pass is safe"),
            0
        );
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("keeps cached session"),
            vec![indexed]
        );
        assert!(
            session.is_file(),
            "incomplete reconciliation never touches JSONL"
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn unattributable_candidate_blocks_sweep_until_a_valid_project_cwd_returns() {
        let root = std::env::temp_dir().join(format!("piui-index-attribution-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates session root");
        let session = sessions.join("history.jsonl");
        let valid = format!(
            "{{\"type\":\"session\",\"id\":\"session\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes project cwd")
        );
        write(&session, &valid).expect("writes valid project session");

        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let first_pass = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers valid session");
        assert!(first_pass.stats.is_complete());
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates valid pass");
        let first = first_pass.sessions.first().expect("finds valid session");
        let cached = index
            .index_discovered_scan(
                &first.file,
                Some(&project.id),
                &first.report,
                first_generation,
            )
            .expect("indexes valid session");

        let unattributable = b"{\"type\":\"session\",\"cwd\":\n";
        write(&session, unattributable).expect("writes malformed no-cwd transition");
        let incomplete_pass = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("tolerates malformed candidate");
        assert!(incomplete_pass.sessions.is_empty());
        assert_eq!(incomplete_pass.stats.unattributable_candidates, 1);
        assert!(!incomplete_pass.stats.is_complete());
        let incomplete_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates incomplete pass");
        assert_eq!(
            index
                .sweep_project_sessions_if_complete(
                    &project.id,
                    incomplete_generation,
                    &incomplete_pass.stats,
                )
                .expect("unattributable pass does not sweep"),
            0
        );
        assert!(
            index
                .indexed_session_file_path(&cached.id)
                .expect("cached session lookup is safe")
                .is_some()
        );
        assert_eq!(
            fs::read(&session).expect("reads unchanged malformed JSONL"),
            unattributable
        );

        write(&session, &valid).expect("restores valid project session");
        let restored_pass = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers restored session");
        assert!(restored_pass.stats.is_complete());
        let restored_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates restored pass");
        let restored = restored_pass
            .sessions
            .first()
            .expect("finds restored session");
        let restored_summary = index
            .index_discovered_scan(
                &restored.file,
                Some(&project.id),
                &restored.report,
                restored_generation,
            )
            .expect("updates restored cache row");
        assert_eq!(restored_summary.id, cached.id);
        assert_eq!(
            index
                .sweep_project_sessions_if_complete(
                    &project.id,
                    restored_generation,
                    &restored_pass.stats,
                )
                .expect("restored complete pass sweeps safely"),
            0
        );
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("retains restored project session"),
            vec![restored_summary]
        );
        assert_eq!(
            fs::read(&session).expect("reads unchanged restored JSONL"),
            valid.as_bytes()
        );
        assert!(
            !serde_json::to_string(&cached)
                .expect("summary serializes")
                .contains(&root.to_string_lossy().to_string())
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incremental_discovery_skips_unchanged_catalog_sources_and_marks_generation() {
        let root = std::env::temp_dir().join(format!("piui-index-incremental-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string()).expect("encodes cwd")
            ),
        )
        .expect("writes session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let first = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &[],
        )
        .expect("discovers full source");
        assert_eq!(first.stats.full_content_scans, 1);
        let discovered = first.sessions.into_iter().next().expect("finds session");
        index
            .index_verified_discovered_session(discovered, Some(&project.id), first_generation)
            .expect("persists verified report without reparsing it");

        let known = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("loads catalog");
        assert_eq!(known.len(), 1);
        let generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let unchanged = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &known,
        )
        .expect("discovers unchanged source");
        assert!(unchanged.sessions.is_empty());
        assert_eq!(unchanged.stats.full_content_scans, 0);
        assert_eq!(unchanged.stats.unchanged_sources, 1);
        assert_eq!(
            index
                .mark_unchanged_sources_seen(&project.id, generation, &unchanged.unchanged_sources)
                .expect("marks weakly unchanged source"),
            1
        );
        assert_eq!(
            index
                .sweep_project_sessions_if_complete(&project.id, generation, &unchanged.stats)
                .expect("complete pass sweeps safely"),
            0
        );

        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incremental_discovery_falls_back_for_append_and_legacy_catalog_rows() {
        let root =
            std::env::temp_dir().join(format!("piui-index-incremental-change-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        let header = format!(
            "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes cwd")
        );
        write(&session, &header).expect("writes session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let first = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &[],
        )
        .expect("discovers source");
        let discovered = first.sessions.into_iter().next().expect("finds session");
        index
            .index_verified_discovered_session(discovered, Some(&project.id), generation)
            .expect("persists source");

        let known = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("loads catalog");
        write(&session, format!("{header}{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"appended\"}}}}\n"))
            .expect("appends session");
        let changed = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &known,
        )
        .expect("falls back for append");
        assert_eq!(changed.stats.full_content_scans, 1);
        assert!(changed.unchanged_sources.is_empty());
        let refreshed = changed
            .sessions
            .into_iter()
            .next()
            .expect("finds appended source");
        index
            .index_verified_discovered_session(refreshed, Some(&project.id), generation)
            .expect("persists appended source");
        let known_after_append = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("refreshes catalog");
        write(&session, format!("{header}{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"revised!\"}}}}\n"))
            .expect("rewrites same-sized tail");
        let rewritten = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &known_after_append,
        )
        .expect("falls back for same-sized rewrite");
        assert_eq!(rewritten.stats.full_content_scans, 1);
        assert!(rewritten.unchanged_sources.is_empty());

        index.connection.execute(
            "UPDATE sessions_index SET source_length = NULL, source_modified_stamp = NULL, source_continuity_digest = NULL, source_parser_version = NULL WHERE project_id = ?1",
            params![&project.id],
        ).expect("simulates legacy catalog row");
        let legacy = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("legacy fingerprint omitted");
        assert!(legacy.is_empty());
        let legacy_pass = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &legacy,
        )
        .expect("legacy row takes full path");
        assert_eq!(legacy_pass.stats.full_content_scans, 1);

        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn verified_discovery_persistence_rejects_replaced_source_without_full_reparse() {
        let root =
            std::env::temp_dir().join(format!("piui-index-verified-replace-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        let contents = |id: &str| {
            format!(
                "{{\"type\":\"session\",\"id\":{id:?},\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            )
        };
        write(&session, contents("original")).expect("writes original");
        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers source");
        let discovered = discovery.sessions.into_iter().next().expect("finds source");
        let retained = sessions.join("retained.jsonl");
        fs::rename(&session, &retained).expect("moves original identity away");
        write(&session, contents("replacement")).expect("replaces source");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        assert!(matches!(
            index.index_verified_discovered_session(discovered, None, 1),
            Err(IndexError::SessionIdentityChanged)
        ));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn verified_discovery_persistence_hashes_full_source_before_storing_report() {
        let root =
            std::env::temp_dir().join(format!("piui-index-verified-hash-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            ),
        )
        .expect("writes source");
        let mut discovered = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers source")
        .sessions
        .into_iter()
        .next()
        .expect("finds source");
        // The weak discovery fingerprint still matches, so only a complete
        // streamed hash can reject this tampered full projection revision.
        discovered.report.file_revision = "0".repeat(64);
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        assert!(matches!(
            index.index_verified_discovered_session(discovered, None, 1),
            Err(IndexError::SessionIdentityChanged)
        ));
        assert!(index.list_sessions(None).expect("lists cache").is_empty());
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn project_revision_verifier_hashes_bound_source_and_checks_canonical_header() {
        let root =
            std::env::temp_dir().join(format!("piui-index-timeline-verify-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let other_project = root.join("other");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&other_project).expect("creates other project");
        let session = root.join("history.jsonl");
        let contents = format!(
            "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes cwd")
        );
        write(&session, &contents).expect("writes source");
        let report = scan_file(&session).expect("scans source");
        let revision = report.file_revision.clone();
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let summary = index
            .index_scan(&session, None, &report, 1)
            .expect("indexes source");
        let host_file = index
            .indexed_session_file_path(&summary.id)
            .expect("looks up source")
            .expect("returns bound source");
        verify_project_file_revision_bounded(&host_file, &project_path, 1024, &revision)
            .expect("verifies cached timeline revision");
        assert!(matches!(
            verify_project_file_revision_bounded(&host_file, &project_path, 1024, &"0".repeat(64)),
            Err(ProjectRevisionVerificationError::File(
                BoundedScanError::RevisionMismatch
            ))
        ));
        assert!(matches!(
            verify_project_file_revision_bounded(&host_file, &other_project, 1024, &revision),
            Err(ProjectRevisionVerificationError::HeaderProjectMismatch)
        ));
        write(&session, format!("{contents}{{\"type\":\"message\"}}\n")).expect("changes source");
        assert!(matches!(
            verify_project_file_revision_bounded(&host_file, &project_path, 1024, &revision),
            Err(ProjectRevisionVerificationError::File(
                BoundedScanError::RevisionMismatch
            ))
        ));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn malformed_catalog_identity_is_omitted_without_failing_lookup() {
        let root =
            std::env::temp_dir().join(format!("piui-index-malformed-catalog-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            ),
        )
        .expect("writes source");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers source");
        index
            .index_verified_discovered_session(
                discovery.sessions.into_iter().next().expect("finds source"),
                Some(&project.id),
                1,
            )
            .expect("persists source");
        let foreign_identity = if cfg!(windows) {
            "unix:1:1"
        } else {
            "windows:1:1"
        };
        index
            .connection
            .execute(
                "UPDATE sessions_index SET file_identity = ?2 WHERE project_id = ?1",
                params![&project.id, foreign_identity],
            )
            .expect("stores platform-foreign private identity");
        assert!(
            index
                .known_project_catalog_fingerprints(&project.id)
                .expect("omits malformed identity")
                .is_empty()
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn verified_batch_commits_once_and_preserves_session_identity_and_generation() {
        let root = std::env::temp_dir().join(format!("piui-index-batch-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        let contents = || {
            format!(
                "{{\"type\":\"session\",\"id\":\"one\",\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            )
        };
        write(&session, contents()).expect("writes source");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let first = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers source");
        let first_batch =
            verify_discovered_sessions_batch(first.sessions).expect("verifies outside lock");
        let first_commit = index
            .commit_verified_project_discovery_batch(
                first_batch,
                &project.id,
                first_generation,
                &[],
                &first.stats,
            )
            .expect("commits one transaction");
        let first_id = first_commit.sessions[0].id.clone();
        assert_eq!(first_commit.swept_sessions, 0);
        assert!(first_commit.complete);

        let second_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let second = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("rediscovers source");
        let second_batch =
            verify_discovered_sessions_batch(second.sessions).expect("verifies outside lock");
        let second_commit = index
            .commit_verified_project_discovery_batch(
                second_batch,
                &project.id,
                second_generation,
                &[],
                &second.stats,
            )
            .expect("commits refresh atomically");
        assert_eq!(second_commit.sessions[0].id, first_id);
        assert!(second_commit.complete);
        let stored_generation: i64 = index
            .connection
            .query_row(
                "SELECT index_generation FROM sessions_index WHERE id = ?1",
                params![&first_id],
                |row| row.get(0),
            )
            .expect("reads generation");
        assert_eq!(stored_generation, second_generation);

        let known = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("loads catalog fingerprints");
        let third_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let unchanged = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &known,
        )
        .expect("discovers unchanged source");
        let unchanged_batch = verify_discovered_sessions_batch(unchanged.sessions)
            .expect("verifies empty full-scan batch");
        let unchanged_commit = index
            .commit_verified_project_discovery_batch(
                unchanged_batch,
                &project.id,
                third_generation,
                &unchanged.unchanged_sources,
                &unchanged.stats,
            )
            .expect("marks unchanged and sweeps in one transaction");
        assert!(unchanged_commit.sessions.is_empty());
        assert_eq!(unchanged_commit.unchanged_sources_marked, 1);
        assert_eq!(unchanged_commit.swept_sessions, 0);
        assert!(unchanged_commit.complete);
        let marked_generation: i64 = index
            .connection
            .query_row(
                "SELECT index_generation FROM sessions_index WHERE id = ?1",
                params![&first_id],
                |row| row.get(0),
            )
            .expect("reads unchanged generation");
        assert_eq!(marked_generation, third_generation);
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incremental_discovery_validates_each_zero_limit_and_exact_file_bound() {
        let root =
            std::env::temp_dir().join(format!("piui-index-incremental-limits-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let source = format!(
            "{{\"type\":\"session\",\"id\":\"limit\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes cwd")
        );
        let session = sessions.join("limit.jsonl");
        write(&session, &source).expect("writes source");
        for limits in [
            SessionDiscoveryLimits {
                max_files: 0,
                ..SessionDiscoveryLimits::default()
            },
            SessionDiscoveryLimits {
                max_directories: 0,
                ..SessionDiscoveryLimits::default()
            },
            SessionDiscoveryLimits {
                max_entries: 0,
                ..SessionDiscoveryLimits::default()
            },
            SessionDiscoveryLimits {
                max_file_bytes: 0,
                ..SessionDiscoveryLimits::default()
            },
        ] {
            assert!(matches!(
                discover_sessions_for_project_incremental(
                    std::slice::from_ref(&sessions),
                    &project_path,
                    limits,
                    &[],
                ),
                Err(DiscoveryError::InvalidLimits)
            ));
        }
        let exact_limit = SessionDiscoveryLimits {
            max_file_bytes: source.len(),
            ..SessionDiscoveryLimits::default()
        };
        let exact = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            exact_limit,
            &[],
        )
        .expect("exact source length stays within the inclusive bound");
        assert_eq!(exact.sessions.len(), 1);
        assert_eq!(exact.stats.skipped_oversize_files, 0);
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incremental_discovery_counts_nested_directories_and_respects_depth_limit() {
        let root = std::env::temp_dir().join(format!(
            "piui-index-incremental-directory-limits-{}",
            Uuid::new_v4()
        ));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        for directory in [
            sessions.join("first/grandchild"),
            sessions.join("second/grandchild"),
        ] {
            create_dir_all(directory).expect("creates nested fixture directories");
        }
        let discovery = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits {
                max_directories: 2,
                max_depth: 1,
                ..SessionDiscoveryLimits::default()
            },
            &[],
        )
        .expect("walks bounded directory inventory");
        assert_eq!(discovery.stats.visited_directories, 2);
        assert!(discovery.stats.directory_limit_reached);
        assert_eq!(discovery.stats.skipped_depth_directories, 1);
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn unmatched_unchanged_observation_blocks_complete_batch_sweep() {
        let root = std::env::temp_dir().join(format!(
            "piui-index-batch-unmatched-unchanged-{}",
            Uuid::new_v4()
        ));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"batch\",\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            ),
        )
        .expect("writes source");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let first_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates first generation");
        let first = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &[],
        )
        .expect("discovers initial source");
        index
            .commit_verified_project_discovery_batch(
                verify_discovered_sessions_batch(first.sessions).expect("verifies initial source"),
                &project.id,
                first_generation,
                &first.unchanged_sources,
                &first.stats,
            )
            .expect("commits initial source");
        let known = index
            .known_project_catalog_fingerprints(&project.id)
            .expect("loads known fingerprint");
        let second_generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates second generation");
        let unchanged = discover_sessions_for_project_incremental(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
            &known,
        )
        .expect("discovers unchanged source");
        assert_eq!(unchanged.unchanged_sources.len(), 1);
        // Simulate a stale observation CAS failure without changing JSONL.
        index
            .connection
            .execute(
                "UPDATE sessions_index SET source_continuity_digest = 'different' WHERE project_id = ?1",
                params![&project.id],
            )
            .expect("invalidates persisted weak evidence");
        let committed = index
            .commit_verified_project_discovery_batch(
                verify_discovered_sessions_batch(unchanged.sessions)
                    .expect("verifies empty full-scan batch"),
                &project.id,
                second_generation,
                &unchanged.unchanged_sources,
                &unchanged.stats,
            )
            .expect("retains stale catalog row rather than sweeping it");
        assert_eq!(committed.unchanged_sources_marked, 0);
        assert_eq!(committed.swept_sessions, 0);
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists retained cache")
                .len(),
            1
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn stale_verified_batch_is_rejected_before_any_sqlite_commit() {
        let root = std::env::temp_dir().join(format!("piui-index-batch-stale-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        let contents = |id: &str| {
            format!(
                "{{\"type\":\"session\",\"id\":{id:?},\"cwd\":{}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string())
                    .expect("encodes cwd")
            )
        };
        write(&session, contents("original")).expect("writes original");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let generation = index
            .allocate_project_discovery_generation(&project.id)
            .expect("allocates generation");
        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers source");
        let batch = verify_discovered_sessions_batch(discovery.sessions)
            .expect("verifies original outside lock");
        let retained = sessions.join("retained.jsonl");
        fs::rename(&session, &retained).expect("moves original identity away");
        write(&session, contents("replacement")).expect("replaces source");
        assert!(matches!(
            index.commit_verified_project_discovery_batch(
                batch,
                &project.id,
                generation,
                &[],
                &discovery.stats,
            ),
            Err(IndexError::SessionIdentityChanged)
        ));
        assert!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists cache")
                .is_empty()
        );
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn discovery_catalog_keeps_sidebar_summary_without_entry_tree_or_timeline() {
        let root =
            std::env::temp_dir().join(format!("piui-index-catalog-summary-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        write(
            &session,
            format!(
                "{{\"type\":\"session\",\"id\":\"pi-id\",\"name\":\"Catalog title\",\"cwd\":{},\"createdAt\":\"2024-01-01\",\"model\":\"header-model\"}}\n{{\"type\":\"message\",\"timestamp\":\"2024-01-02\",\"message\":{{\"role\":\"user\",\"content\":\"first prompt\"}}}}\n{{\"type\":\"message\",\"timestamp\":\"2024-01-03\",\"model\":\"last-model\",\"message\":{{\"role\":\"assistant\",\"content\":\"latest reply\"}}}}\n",
                serde_json::to_string(&project_path.to_string_lossy().to_string()).expect("encodes cwd")
            ),
        )
        .expect("writes source");
        let mut discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers catalog");
        let report = &discovery.sessions[0].report;
        assert_eq!(report.pi_session_id.as_deref(), Some("pi-id"));
        assert_eq!(report.session_name.as_deref(), Some("Catalog title"));
        assert_eq!(report.created_at.as_deref(), Some("2024-01-01"));
        assert_eq!(report.updated_at.as_deref(), Some("2024-01-03"));
        assert_eq!(report.first_user_preview.as_deref(), Some("first prompt"));
        assert_eq!(report.last_message_preview.as_deref(), Some("latest reply"));
        assert_eq!(report.model_ref.as_deref(), Some("last-model"));
        assert_eq!(report.entry_count, 2);
        assert!(report.entries.is_empty());
        assert!(report.tree.is_empty());
        assert!(report.timeline_blocks.is_empty());

        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let summary = index
            .index_verified_discovered_session(
                discovery.sessions.pop().expect("takes catalog"),
                Some(&project.id),
                1,
            )
            .expect("persists catalog metadata");
        assert_eq!(summary.branch_count, None);
        let stored_branch_count: Option<i64> = index
            .connection
            .query_row(
                "SELECT branch_count FROM sessions_index WHERE id = ?1",
                params![&summary.id],
                |row| row.get(0),
            )
            .expect("reads null branch count");
        assert!(stored_branch_count.is_none());
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn discovery_catalog_bounds_oversized_complete_frame() {
        let root =
            std::env::temp_dir().join(format!("piui-index-catalog-frame-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&sessions).expect("creates sessions");
        let session = sessions.join("history.jsonl");
        let header = format!(
            "{{\"type\":\"session\",\"id\":\"pi-id\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_path.to_string_lossy().to_string())
                .expect("encodes cwd")
        );
        write(
            &session,
            format!("{header}{}\n", "x".repeat(CATALOG_FRAME_MAX_BYTES + 1)),
        )
        .expect("writes oversized complete frame");
        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project_path,
            SessionDiscoveryLimits::default(),
        )
        .expect("catalog scan remains bounded");
        let report = &discovery.sessions[0].report;
        assert_eq!(report.parse_state, ParseState::Corrupt);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|item| item.code == "frame-too-large")
        );
        assert!(report.entries.is_empty());
        assert!(report.tree.is_empty());
        assert!(report.timeline_blocks.is_empty());
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn discovery_skips_foreign_complete_header_before_malformed_trailing_content() {
        let root = std::env::temp_dir().join(format!(
            "piui-index-discovery-header-prefix-{}",
            Uuid::new_v4()
        ));
        let requested_project = root.join("requested-project");
        let foreign_project = root.join("foreign-project");
        let sessions = root.join("sessions");
        for directory in [&requested_project, &foreign_project, &sessions] {
            create_dir_all(directory).expect("creates fixture directory");
        }
        let foreign = sessions.join("foreign.jsonl");
        let matching = sessions.join("matching.jsonl");
        write(
            &foreign,
            format!(
                "{{\"type\":\"session\",\"id\":\"foreign\",\"cwd\":{}}}\n{{malformed trailing content\n",
                serde_json::to_string(&foreign_project.to_string_lossy().to_string())
                    .expect("encodes foreign cwd")
            ),
        )
        .expect("writes foreign malformed fixture");
        write(
            &matching,
            format!(
                "{{\"type\":\"session\",\"id\":\"matching\",\"cwd\":{}}}\n",
                serde_json::to_string(&requested_project.to_string_lossy().to_string())
                    .expect("encodes requested cwd")
            ),
        )
        .expect("writes matching fixture");

        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &requested_project,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers requested session");
        assert_eq!(discovery.sessions.len(), 1);
        assert_eq!(
            discovery.sessions[0].report.pi_session_id.as_deref(),
            Some("matching")
        );
        assert_eq!(discovery.stats.scanned_files, 2);
        assert_eq!(discovery.stats.matched_files, 1);
        assert_eq!(discovery.stats.unattributable_candidates, 0);
        assert!(discovery.stats.is_complete());

        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn incomplete_or_ambiguous_header_prefixes_fall_back_and_block_sweep() {
        let root = std::env::temp_dir().join(format!(
            "piui-index-discovery-header-fallback-{}",
            Uuid::new_v4()
        ));
        let requested_project = root.join("requested-project");
        let foreign_project = root.join("foreign-project");
        let sessions = root.join("sessions");
        for directory in [&requested_project, &foreign_project, &sessions] {
            create_dir_all(directory).expect("creates fixture directory");
        }
        write(
            sessions.join("incomplete.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"incomplete\",\"cwd\":{}",
                serde_json::to_string(&foreign_project.to_string_lossy().to_string())
                    .expect("encodes foreign cwd")
            ),
        )
        .expect("writes incomplete header");
        write(
            sessions.join("ambiguous.jsonl"),
            "{\"type\":\"session\",\"id\":\"ambiguous\",\"cwd\":\"relative\"}\n",
        )
        .expect("writes ambiguous header");

        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &requested_project,
            SessionDiscoveryLimits::default(),
        )
        .expect("conservatively handles ambiguous candidates");
        assert!(discovery.sessions.is_empty());
        assert_eq!(discovery.stats.scanned_files, 2);
        assert_eq!(discovery.stats.matched_files, 0);
        assert_eq!(discovery.stats.unattributable_candidates, 2);
        assert!(!discovery.stats.is_complete());

        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn session_identity_preserves_ids_for_renames_but_not_path_replacements() {
        let root =
            std::env::temp_dir().join(format!("piui-index-file-identity-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates project");
        let renamed_from = root.join("before-rename.jsonl");
        let renamed_to = root.join("after-rename.jsonl");
        write(&renamed_from, b"{\"type\":\"session\",\"id\":\"rename\"}\n")
            .expect("writes renamed fixture");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        let original = index
            .index_scan(
                &renamed_from,
                Some(&project.id),
                &scan_file(&renamed_from).expect("scans original"),
                1,
            )
            .expect("indexes original");
        fs::rename(&renamed_from, &renamed_to).expect("renames JSONL outside index");
        let renamed = index
            .index_scan(
                &renamed_to,
                Some(&project.id),
                &scan_file(&renamed_to).expect("scans renamed file"),
                2,
            )
            .expect("reindexes renamed file");
        assert_eq!(renamed.id, original.id);
        assert_eq!(
            index
                .indexed_session_file_path(&renamed.id)
                .expect("looks up rename")
                .expect("renamed cache row exists")
                .as_path(),
            renamed_to.as_path()
        );

        let replacement = root.join("replacement.jsonl");
        let retained_original = root.join("retained-original.jsonl");
        write(&replacement, b"{\"type\":\"session\",\"id\":\"old\"}\n")
            .expect("writes original replacement fixture");
        let old = index
            .index_scan(
                &replacement,
                Some(&project.id),
                &scan_file(&replacement).expect("scans original replacement"),
                3,
            )
            .expect("indexes original replacement");
        fs::rename(&replacement, &retained_original).expect("retains original file identity");
        let replacement_bytes = b"{\"type\":\"session\",\"id\":\"new\"}\n";
        write(&replacement, replacement_bytes).expect("writes new file at old spelling");
        let replaced = index
            .index_scan(
                &replacement,
                Some(&project.id),
                &scan_file(&replacement).expect("scans replacement"),
                4,
            )
            .expect("indexes replacement with fresh identity");
        assert_ne!(replaced.id, old.id);
        assert!(
            index
                .indexed_session_file_path(&old.id)
                .expect("old replacement lookup is safe")
                .is_none()
        );
        assert_eq!(
            fs::read(&replacement).expect("reads unchanged replacement JSONL"),
            replacement_bytes
        );
        let encoded = serde_json::to_string(&replaced).expect("summary serializes");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn migration_adds_identity_column_without_rewriting_existing_session_rows() {
        let database =
            std::env::temp_dir().join(format!("piui-index-migration-{}.db", Uuid::new_v4()));
        {
            let connection = Connection::open(&database).expect("creates legacy database");
            connection
                .execute_batch(
                    "CREATE TABLE sessions_index (
                        id TEXT PRIMARY KEY,
                        file_path TEXT NOT NULL UNIQUE,
                        project_id TEXT,
                        pi_session_id TEXT,
                        name TEXT,
                        title_source TEXT NOT NULL,
                        created_at TEXT,
                        updated_at TEXT,
                        first_user_preview TEXT,
                        last_message_preview TEXT,
                        entry_count INTEGER NOT NULL,
                        branch_count INTEGER,
                        current_leaf_id TEXT,
                        model_ref TEXT,
                        parse_state TEXT NOT NULL,
                        file_revision TEXT NOT NULL,
                        index_generation INTEGER NOT NULL
                    );
                    INSERT INTO sessions_index (id, file_path, title_source, entry_count, parse_state, file_revision, index_generation)
                    VALUES ('legacy', 'private-path', 'date-id', 0, 'healthy', 'revision', 0);",
                )
                .expect("creates legacy schema and row");
        }
        let index = ProjectIndex::open(&database).expect("migrates legacy database");
        let identity_column: Option<String> = index
            .connection
            .query_row(
                "SELECT name FROM pragma_table_info('sessions_index') WHERE name = 'file_identity'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("reads migrated schema");
        assert_eq!(identity_column.as_deref(), Some("file_identity"));
        for column in [
            "source_length",
            "source_modified_stamp",
            "source_continuity_digest",
            "source_parser_version",
        ] {
            assert!(
                index
                    .table_has_column("sessions_index", column)
                    .expect("reads migration column")
            );
        }
        let search_index: Option<String> = index
            .connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_index_project_updated_id'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("reads search index migration");
        assert_eq!(
            search_index.as_deref(),
            Some("sessions_index_project_updated_id")
        );
        let legacy_identity: Option<String> = index
            .connection
            .query_row(
                "SELECT file_identity FROM sessions_index WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("reads preserved legacy row");
        assert!(legacy_identity.is_none());
        let legacy_fingerprint: Option<i64> = index
            .connection
            .query_row(
                "SELECT source_length FROM sessions_index WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("reads preserved legacy fingerprint");
        assert!(legacy_fingerprint.is_none());

        drop(index);
        remove_file(&database).expect("removes legacy database");
    }

    #[test]
    fn observing_project_file_accepts_append_but_preserves_identity_header_and_cache() {
        let root = std::env::temp_dir().join(format!("piui-index-observe-{}", Uuid::new_v4()));
        let project_path = root.join("project");
        let other_project = root.join("other-project");
        create_dir_all(&project_path).expect("creates project");
        create_dir_all(&other_project).expect("creates other project");
        let session = root.join("history.jsonl");
        let project_text = project_path.to_string_lossy().to_string();
        let initial = format!(
            "{{\"type\":\"session\",\"id\":\"session\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_text).expect("encodes cwd")
        );
        write(&session, &initial).expect("writes initial session");
        let initial_report = scan_file(&session).expect("scans initial session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let project = index
            .register_project(&project_path, None, TrustState::Restricted)
            .expect("registers project");
        let indexed = index
            .index_scan(&session, Some(&project.id), &initial_report, 1)
            .expect("indexes initial report");
        let host_file = index
            .indexed_session_file_path(&indexed.id)
            .expect("looks up session")
            .expect("host capability exists");

        let appended = format!(
            "{initial}{{\"type\":\"message\",\"id\":\"later\",\"message\":{{\"role\":\"user\",\"content\":\"external append\"}}}}\n"
        );
        write(&session, &appended).expect("externally appends session");
        let observed = observe_project_file_bounded(&host_file, &project_path, 1_024)
            .expect("observes changed same-identity session");
        assert_ne!(observed.file_revision, initial_report.file_revision);
        assert_eq!(observed.entry_count, 1);
        assert_eq!(
            fs::read(&session).expect("observer did not write"),
            appended.as_bytes()
        );
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("SQLite cache remains unchanged"),
            vec![indexed.clone()]
        );
        assert!(matches!(
            observe_project_file_bounded(&host_file, &other_project, 1_024),
            Err(ProjectBoundedScanError::HeaderProjectMismatch)
        ));

        let retained_original = root.join("retained-original.jsonl");
        fs::rename(&session, &retained_original).expect("moves original identity away");
        write(&session, &appended).expect("swaps replacement at indexed path");
        assert!(matches!(
            observe_project_file_bounded(&host_file, &project_path, 1_024),
            Err(ProjectBoundedScanError::File(BoundedScanError::Changed))
        ));
        remove_dir_all(&root).expect("removes fixture");
    }

    #[test]
    fn project_bound_rescan_revalidates_header_project_and_identity() {
        let root =
            std::env::temp_dir().join(format!("piui-index-project-rescan-{}", Uuid::new_v4()));
        let project = root.join("project");
        let other_project = root.join("other");
        create_dir_all(&project).expect("creates project");
        create_dir_all(&other_project).expect("creates other project");
        let session = root.join("history.jsonl");
        let project_text = project.to_string_lossy().to_string();
        let session_bytes = format!(
            "{{\"type\":\"session\",\"cwd\":{}}}\n",
            serde_json::to_string(&project_text).expect("encodes cwd")
        );
        write(&session, &session_bytes).expect("writes session");
        let report = scan_file(&session).expect("scans indexed content");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let summary = index
            .index_scan(&session, None, &report, 1)
            .expect("persists identity and revision");
        let host_file = index
            .indexed_session_file_path(&summary.id)
            .expect("looks up indexed file")
            .expect("indexed file exists");

        let report = scan_project_file_bounded(&host_file, &project, 1_024)
            .expect("matching project rescans");
        assert_eq!(report.project_cwd.as_deref(), Some(project_text.as_str()));
        let mismatch = scan_project_file_bounded(&host_file, &other_project, 1_024)
            .expect_err("wrong project is rejected");
        assert!(matches!(
            &mismatch,
            ProjectBoundedScanError::HeaderProjectMismatch
        ));
        assert!(
            !mismatch
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );

        let changed_bytes = format!("{session_bytes}{{\"type\":\"message\"}}\n");
        write(&session, &changed_bytes).expect("changes session after lookup");
        let changed = scan_project_file_bounded(&host_file, &project, 1_024)
            .expect_err("changed candidate is rejected");
        assert!(matches!(
            changed,
            ProjectBoundedScanError::File(BoundedScanError::RevisionMismatch)
        ));
        assert_eq!(
            fs::read(&session).expect("scanner did not write"),
            changed_bytes.as_bytes()
        );

        remove_file(&session).expect("removes session");
        remove_dir_all(&root).expect("removes fixture root");
    }

    #[cfg(unix)]
    #[test]
    fn bounded_host_rescan_rejects_post_discovery_symlink_replacement() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("piui-index-rescan-link-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates fixture root");
        let session = root.join("history.jsonl");
        let target = root.join("replacement.jsonl");
        write(&session, b"{\"type\":\"session\",\"id\":\"before\"}\n")
            .expect("writes original session");
        write(&target, b"{\"type\":\"session\",\"id\":\"target\"}\n")
            .expect("writes replacement target");
        let report = scan_file(&session).expect("scans original session");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let summary = index
            .index_scan(&session, None, &report, 1)
            .expect("persists original identity");
        let host_file = index
            .indexed_session_file_path(&summary.id)
            .expect("looks up indexed file")
            .expect("indexed file exists");

        remove_file(&session).expect("removes discovered file");
        symlink(&target, &session).expect("replaces it with a symlink");
        let error = scan_file_bounded(&host_file, 1_024).expect_err("rejects replacement link");
        assert!(matches!(&error, BoundedScanError::Symlink));
        assert!(matches!(
            observe_project_file_bounded(&host_file, &root, 1_024),
            Err(ProjectBoundedScanError::File(BoundedScanError::Symlink))
        ));
        assert!(
            !error
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );
        assert_eq!(
            fs::read(&target).expect("target remains unchanged"),
            b"{\"type\":\"session\",\"id\":\"target\"}\n"
        );

        remove_dir_all(&root).expect("removes fixture root");
    }

    #[test]
    fn errors_redact_raw_paths_from_display_values() {
        let missing = std::env::temp_dir().join(format!("piui-index-missing-{}", Uuid::new_v4()));
        let missing_text = missing.to_string_lossy().to_string();

        let scan_error = scan_file(&missing).expect_err("missing file is rejected");
        assert!(!scan_error.to_string().contains(&missing_text));
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let index_error = index
            .register_project(&missing, None, TrustState::Restricted)
            .expect_err("missing project is rejected");
        assert!(!index_error.to_string().contains(&missing_text));
        let discovery_error =
            match discover_sessions_for_project(&[], &missing, SessionDiscoveryLimits::default()) {
                Ok(_) => panic!("missing project cannot be discovered"),
                Err(error) => error,
            };
        assert_eq!(discovery_error, DiscoveryError::ProjectUnavailable);
        assert!(!discovery_error.to_string().contains(&missing_text));
    }

    #[test]
    fn bounded_discovery_matches_only_one_canonical_project_and_is_tolerant() {
        let root = std::env::temp_dir().join(format!("piui-index-discovery-{}", Uuid::new_v4()));
        let project = root.join("project");
        let other_project = root.join("other-project");
        let sessions = root.join("sessions");
        create_dir_all(&project).expect("creates project");
        create_dir_all(&other_project).expect("creates other project");
        create_dir_all(&sessions).expect("creates session root");

        let header = |cwd: &Path| {
            format!(
                "{{\"type\":\"session\",\"id\":\"s\",\"cwd\":{}}}\n",
                serde_json::to_string(&cwd.to_string_lossy().to_string()).expect("encodes cwd")
            )
        };
        write(sessions.join("match.jsonl"), header(&project)).expect("writes match");
        write(
            sessions.join("malformed.jsonl"),
            format!("{}{{\"broken\n", header(&project)),
        )
        .expect("writes malformed session");
        write(
            sessions.join("future.jsonl"),
            format!(
                "{}{{\"type\":\"future-entry\",\"payload\":true}}\n",
                header(&project)
            ),
        )
        .expect("writes future session");
        write(sessions.join("other.jsonl"), header(&other_project)).expect("writes other session");
        write(sessions.join("auth.json"), b"must never be scanned").expect("writes auth sentinel");
        write(sessions.join("config.jsonl"), header(&project)).expect("writes config sentinel");

        let discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers safely");
        assert_eq!(discovery.sessions.len(), 3);
        assert_eq!(discovery.stats.scanned_files, 4);
        assert!(
            discovery.stats.is_complete(),
            "a canonical CWD for another project is attributable, not a sweep blocker"
        );
        assert!(discovery.sessions.iter().all(|session| {
            session
                .file
                .as_path()
                .extension()
                .is_some_and(|ext| ext == "jsonl")
        }));
        assert!(
            discovery
                .sessions
                .iter()
                .any(|session| session.report.parse_state == ParseState::Corrupt)
        );
        assert!(
            discovery
                .sessions
                .iter()
                .any(|session| session.report.parse_state == ParseState::Unsupported)
        );
        assert!(discovery.sessions.iter().all(|session| {
            !format!("{:?}", session.file).contains(&root.to_string_lossy().to_string())
        }));

        remove_dir_all(&root).expect("removes discovery fixture");
    }

    #[test]
    fn bound_discovery_rejects_swap_before_indexing_without_target_preview() {
        let root =
            std::env::temp_dir().join(format!("piui-index-discovery-swap-{}", Uuid::new_v4()));
        let project = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project).expect("creates project");
        create_dir_all(&sessions).expect("creates session root");
        let project_text = project.to_string_lossy().to_string();
        let original = format!(
            "{{\"type\":\"session\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"safe\",\"message\":{{\"role\":\"user\",\"content\":\"safe preview\"}}}}\n",
            serde_json::to_string(&project_text).expect("encodes project")
        );
        let target_preview = "ATTACKER_TARGET_PREVIEW";
        let target = format!(
            "{{\"type\":\"session\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"target\",\"message\":{{\"role\":\"user\",\"content\":\"{target_preview}\"}}}}\n",
            serde_json::to_string(&project_text).expect("encodes project")
        );
        let session = sessions.join("history.jsonl");
        write(&session, &original).expect("writes original session");

        let mut discovery = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits::default(),
        )
        .expect("discovers verified original");
        let discovered = discovery.sessions.pop().expect("finds original session");
        assert!(
            discovered
                .report
                .last_message_preview
                .as_deref()
                .is_some_and(|preview| preview.contains("safe preview"))
        );
        assert!(
            !discovered
                .report
                .last_message_preview
                .as_deref()
                .is_some_and(|preview| preview.contains(target_preview))
        );

        remove_file(&session).expect("removes original after discovery");
        write(&session, &target).expect("swaps in attacker target");
        let mut index = ProjectIndex::open_in_memory().expect("opens index");
        let error = index
            .index_discovered_scan(&discovered.file, None, &discovered.report, 1)
            .expect_err("identity-bound discovery must reject the swap");
        assert!(matches!(&error, IndexError::SessionIdentityChanged));
        assert!(
            !error
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );
        assert!(index.list_sessions(None).expect("lists index").is_empty());

        remove_file(&session).expect("removes target");
        remove_dir_all(&root).expect("removes fixture root");
    }

    #[test]
    fn discovery_enforces_file_size_depth_and_file_count_limits() {
        let root = std::env::temp_dir().join(format!("piui-index-bounds-{}", Uuid::new_v4()));
        let project = root.join("project");
        let sessions = root.join("sessions");
        let nested = sessions.join("nested");
        create_dir_all(&project).expect("creates project");
        create_dir_all(&nested).expect("creates nested root");
        let header = format!(
            "{{\"type\":\"session\",\"cwd\":{}}}\n",
            serde_json::to_string(&project.to_string_lossy().to_string()).expect("encodes cwd")
        );
        write(sessions.join("direct.jsonl"), &header).expect("writes direct session");
        write(nested.join("deep.jsonl"), &header).expect("writes deep session");
        write(
            sessions.join("large.jsonl"),
            format!("{header}{}", "x".repeat(2_048)),
        )
        .expect("writes large session");

        let depth_limited = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits {
                max_files: 10,
                max_depth: 0,
                max_file_bytes: 1024,
                ..SessionDiscoveryLimits::default()
            },
        )
        .expect("discovers direct files only");
        assert_eq!(depth_limited.sessions.len(), 1);
        assert_eq!(depth_limited.stats.skipped_depth_directories, 1);
        assert_eq!(depth_limited.stats.skipped_oversize_files, 1);

        let file_limited = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits {
                max_files: 1,
                max_depth: 8,
                max_file_bytes: 1024,
                ..SessionDiscoveryLimits::default()
            },
        )
        .expect("enforces file limit");
        assert_eq!(file_limited.stats.scanned_files, 1);
        assert!(file_limited.stats.file_limit_reached);
        assert!(matches!(
            discover_sessions_for_project(
                std::slice::from_ref(&sessions),
                &project,
                SessionDiscoveryLimits {
                    max_files: 0,
                    ..SessionDiscoveryLimits::default()
                }
            ),
            Err(DiscoveryError::InvalidLimits)
        ));

        remove_dir_all(&root).expect("removes bounds fixture");
    }

    #[test]
    fn discovery_reports_directory_and_entry_work_limits_without_collecting() {
        let root = std::env::temp_dir().join(format!("piui-index-work-limit-{}", Uuid::new_v4()));
        let project = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(sessions.join("one")).expect("creates first child directory");
        create_dir_all(sessions.join("two")).expect("creates second child directory");
        create_dir_all(&project).expect("creates project");
        for index in 0..3 {
            write(
                sessions.join(format!("entry-{index}.txt")),
                b"not a session",
            )
            .expect("writes bounded-work fixture");
        }

        let directory_limited = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits {
                max_directories: 1,
                max_entries: 32,
                ..SessionDiscoveryLimits::default()
            },
        )
        .expect("directory limit is a safe outcome");
        assert_eq!(directory_limited.stats.visited_directories, 1);
        assert!(directory_limited.stats.directory_limit_reached);

        let entry_limited = discover_sessions_for_project(
            std::slice::from_ref(&sessions),
            &project,
            SessionDiscoveryLimits {
                max_entries: 1,
                ..SessionDiscoveryLimits::default()
            },
        )
        .expect("entry limit is a safe outcome");
        assert_eq!(entry_limited.stats.examined_entries, 1);
        assert!(entry_limited.stats.entry_limit_reached);

        remove_dir_all(&root).expect("removes work-limit fixture");
    }

    #[cfg(unix)]
    #[test]
    fn discovery_does_not_follow_symlinked_files_or_roots() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("piui-index-symlink-{}", Uuid::new_v4()));
        let project = root.join("project");
        let sessions = root.join("sessions");
        create_dir_all(&project).expect("creates project");
        create_dir_all(&sessions).expect("creates session root");
        let target = root.join("target.jsonl");
        write(
            &target,
            format!(
                "{{\"type\":\"session\",\"cwd\":{}}}\n",
                serde_json::to_string(&project.to_string_lossy().to_string()).expect("encodes cwd")
            ),
        )
        .expect("writes target");
        symlink(&target, sessions.join("linked.jsonl")).expect("creates file symlink");
        symlink(&sessions, root.join("linked-root")).expect("creates root symlink");

        let roots = vec![sessions.clone(), root.join("linked-root")];
        let discovery =
            discover_sessions_for_project(&roots, &project, SessionDiscoveryLimits::default())
                .expect("discovery skips links");
        assert!(discovery.sessions.is_empty());
        assert_eq!(discovery.stats.skipped_symlinks, 2);

        remove_dir_all(&root).expect("removes symlink fixture");
    }

    #[test]
    fn sqlite_registry_keeps_paths_private_and_projection_rebuildable() {
        let root = std::env::temp_dir().join(format!("piui-index-{}", Uuid::new_v4()));
        create_dir_all(&root).expect("creates test project");
        let session = root.join("history.jsonl");
        write(
            &session,
            b"{\"type\":\"session\",\"id\":\"s\",\"name\":\"History\"}\n",
        )
        .expect("writes synthetic fixture");
        let mut index = ProjectIndex::open_in_memory().expect("opens sqlite");
        let project = index
            .register_project(&root, None, TrustState::Restricted)
            .expect("registers project");
        assert_eq!(
            project.display_path,
            format!(
                "…/{}",
                root.file_name()
                    .and_then(|name| name.to_str())
                    .expect("test name")
            )
        );
        let report = scan_file(&session).expect("scans fixture");
        let summary = index
            .index_scan(&session, Some(&project.id), &report, 1)
            .expect("indexes scan");
        let encoded = serde_json::to_string(&summary).expect("serializes summary");
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        assert_eq!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists sessions"),
            vec![summary]
        );
        index
            .rebuild_session_projection()
            .expect("drops only cache rows");
        assert!(
            index
                .list_sessions(Some(&project.id))
                .expect("lists empty cache")
                .is_empty()
        );
        assert_eq!(index.list_projects().expect("keeps project").len(), 1);
        remove_file(&session).expect("removes fixture");
        remove_dir_all(&root).expect("removes test project");
    }
}
