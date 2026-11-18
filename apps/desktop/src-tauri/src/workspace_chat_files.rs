//! Chat files v1 (`workspace_chat_files_v1`, see `contracts/chat-files-v1.ts`,
//! ADR-074): files the agent writes, reads, generates or returns, shown in
//! the chat with a preview or a file card and the actions Open, Save as and
//! Open containing folder.
//!
//! The WebView never names a path. It sends a session id and an opaque file
//! id the host handed out. The host keeps, per session, a registry of the
//! files that session's own native events or native history reported (at most
//! 200). Every call opens the file first, names the file that handle really
//! is (`GetFinalPathNameByHandleW`; on Unix the canonical path whose device
//! and inode match the handle), and checks that final path: not a link, a
//! regular file, the same path as when it was first seen, and inside this
//! session's scope (below). The bytes are read from that one handle. A file's
//! kind comes from its magic bytes, never from its name. Bytes the agent only
//! returned inline (a read image, an MCP result) are stored by the host under
//! its app data, capped per session, and cleared at startup. Nothing is
//! written into a project.
//!
//! Scope (ADR-074): a registered path is served only when its final path is
//! inside (a) the session's verified working folder (its own worktree when it
//! has one), (b) the host's own inline store for the session, (c) a folder the
//! host resolves for the session's harness (Codex's generated images), or
//! (d) the agent itself wrote or generated it (origin `written` or
//! `generated`). A file the agent only read outside (a) to (c) is never
//! served. The check runs when a file is reported and on every operation.

use super::attachments::{display_path, sniff_image};
use super::*;
use base64::Engine as _;
use piui_index::workspace_history::{HistoryChatFile, HistoryChatFileOrigin};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Component;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The host event that tells the WebView a session's files changed
/// (`contracts/chat-files-v1.ts`); it carries no file, only the session.
pub const CHAT_FILES_EVENT: &str = "piui://chat-files-v1";
/// Changes within this window reach the WebView as one event.
const CHANGE_COALESCE: Duration = Duration::from_millis(250);

pub const CHAT_FILES_PROTOCOL: u8 = 1;
pub(crate) const CHAT_FILES_DIRECTORY: &str = "chat-files-v1";
/// Files one session's registry holds; the oldest one makes room.
pub(crate) const MAX_FILES_PER_SESSION: usize = 200;
/// Blocks remembered per file.
const MAX_BLOCKS_PER_FILE: usize = 32;
pub(crate) const MAX_IMAGE_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_MEDIA_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
/// Largest inline file the host stores.
const MAX_INLINE_FILE_BYTES: usize = 64 * 1024 * 1024;
/// Inline bytes and files kept per session.
const MAX_INLINE_BYTES_PER_SESSION: u64 = 128 * 1024 * 1024;
const MAX_INLINE_FILES_PER_SESSION: usize = 64;
const MAX_ID_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_NAME_BYTES: usize = 512;
/// Bytes read to identify a file.
const HEAD_BYTES: u64 = 4_096;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChatFilesCommand {
    List { session_id: String },
    Preview { session_id: String, file_id: String },
    Save { session_id: String, file_id: String },
    Reveal { session_id: String, file_id: String },
    Open { session_id: String, file_id: String },
    Resolve { session_id: String, name: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatFileKind {
    Image,
    Audio,
    Video,
    Pdf,
    Text,
    File,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatFileOrigin {
    Written,
    Read,
    Generated,
    Returned,
}

/// One file shown with one block (`ChatFileV1`).
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub id: String,
    pub block_id: String,
    pub name: String,
    pub kind: ChatFileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub origin: ChatFileOrigin,
    pub openable: bool,
    pub previewable: bool,
    pub revealable: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unavailable: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatFilesResult {
    Files {
        protocol: u8,
        session_id: String,
        files: Vec<ChatFile>,
    },
    Preview {
        protocol: u8,
        session_id: String,
        file_id: String,
        media_type: String,
        data: String,
    },
    Saved {
        protocol: u8,
        session_id: String,
        file_id: String,
        saved: bool,
    },
    Revealed {
        protocol: u8,
        session_id: String,
        file_id: String,
    },
    Opened {
        protocol: u8,
        session_id: String,
        file_id: String,
    },
    Resolved {
        protocol: u8,
        session_id: String,
        file: Option<ChatFile>,
    },
}

/// Why a file action did not happen. Never carries a path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatFilesError {
    /// An unknown or forged id, a deleted or replaced file, a link.
    Unavailable,
    NotPreviewable,
    OpenRefused,
    /// The system action did not start, or a copy failed.
    Failed,
    Invalid,
}

impl From<ChatFilesError> for WorkspaceError {
    fn from(error: ChatFilesError) -> Self {
        match error {
            ChatFilesError::Unavailable => Self {
                code: "CHAT_FILE_UNAVAILABLE",
                message: "This file is no longer available.",
                recoverable: true,
            },
            ChatFilesError::NotPreviewable => Self {
                code: "CHAT_FILE_NOT_PREVIEWABLE",
                message: "This file cannot be previewed. Open it or save a copy.",
                recoverable: true,
            },
            ChatFilesError::OpenRefused => Self {
                code: "CHAT_FILE_OPEN_REFUSED",
                message: "Nano Desktop does not open this kind of file. Save a copy or show it in its folder.",
                recoverable: true,
            },
            ChatFilesError::Failed => Self {
                code: "CHAT_FILE_FAILED",
                message: "The file action could not be completed.",
                recoverable: true,
            },
            ChatFilesError::Invalid => Self::invalid(),
        }
    }
}

// ---------------------------------------------------------------------------
// Identifying bytes
// ---------------------------------------------------------------------------

/// What the first bytes of a file prove it is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Sniffed {
    pub kind: ChatFileKind,
    pub mime: &'static str,
    /// A program (PE, ELF, Mach-O, a `#!` script): never opened by the host.
    pub executable: bool,
}

const fn sniffed(kind: ChatFileKind, mime: &'static str) -> Sniffed {
    Sniffed {
        kind,
        mime,
        executable: false,
    }
}

fn is_mp3(head: &[u8]) -> bool {
    if head.starts_with(b"ID3") {
        return true;
    }
    // An MPEG audio frame header: sync bits, a real version, a real layer.
    head.len() >= 2
        && head[0] == 0xff
        && head[1] & 0xe0 == 0xe0
        && head[1] & 0x18 != 0x08
        && head[1] & 0x06 != 0
}

fn is_executable(head: &[u8]) -> bool {
    (head.starts_with(b"MZ") && head.len() >= 0x40)
        || head.starts_with(b"\x7fELF")
        || head.starts_with(b"#!")
        || head.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || head.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || head.starts_with(&[0xce, 0xfa, 0xed, 0xfe])
        || head.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || head.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
}

fn is_text(head: &[u8]) -> bool {
    if head.is_empty() || head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // A multi-byte character cut by the end of the window is still text.
        Err(error) => error.error_len().is_none(),
    }
}

fn text_media_type(extension: Option<&str>) -> &'static str {
    match extension {
        Some("md" | "markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("html" | "htm") => "text/html",
        Some("xml") => "application/xml",
        Some("yaml" | "yml") => "application/yaml",
        _ => "text/plain",
    }
}

/// Identifies a file from its first bytes. The extension only picks the
/// media type of text and tells an SVG document from other text.
pub(crate) fn sniff_media(head: &[u8], extension: Option<&str>) -> Sniffed {
    if let Some(image) = sniff_image(head) {
        return sniffed(ChatFileKind::Image, image.mime_type());
    }
    if head.starts_with(b"%PDF-") {
        return sniffed(ChatFileKind::Pdf, "application/pdf");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") {
        match &head[8..12] {
            b"WAVE" => return sniffed(ChatFileKind::Audio, "audio/wav"),
            b"AVI " => return sniffed(ChatFileKind::File, "video/x-msvideo"),
            _ => {}
        }
    }
    if head.starts_with(b"OggS") {
        return sniffed(ChatFileKind::Audio, "audio/ogg");
    }
    if head.starts_with(b"fLaC") {
        return sniffed(ChatFileKind::Audio, "audio/flac");
    }
    if is_mp3(head) {
        return sniffed(ChatFileKind::Audio, "audio/mpeg");
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return match &head[8..12] {
            b"M4A " | b"M4B " | b"F4A " | b"F4B " => sniffed(ChatFileKind::Audio, "audio/mp4"),
            b"avif" | b"avis" => sniffed(ChatFileKind::File, "image/avif"),
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => {
                sniffed(ChatFileKind::File, "image/heic")
            }
            b"qt  " => sniffed(ChatFileKind::Video, "video/quicktime"),
            _ => sniffed(ChatFileKind::Video, "video/mp4"),
        };
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let window = &head[..head.len().min(64)];
        return if window.windows(4).any(|part| part == b"webm") {
            sniffed(ChatFileKind::Video, "video/webm")
        } else {
            sniffed(ChatFileKind::File, "video/x-matroska")
        };
    }
    if is_executable(head) {
        return Sniffed {
            kind: ChatFileKind::File,
            mime: "application/octet-stream",
            executable: true,
        };
    }
    if is_text(head) {
        let lowered = head
            .iter()
            .take(1_024)
            .map(u8::to_ascii_lowercase)
            .collect::<Vec<u8>>();
        let svg = extension == Some("svg") || lowered.windows(4).any(|part| part == b"<svg");
        // An SVG is a document that can carry script: a card, never an image.
        return if svg {
            sniffed(ChatFileKind::File, "image/svg+xml")
        } else {
            sniffed(ChatFileKind::Text, text_media_type(extension))
        };
    }
    sniffed(ChatFileKind::File, "application/octet-stream")
}

/// The lowercase extension, without Windows' ignored trailing dots and spaces.
fn extension_of(name: &str) -> Option<String> {
    let trimmed = name.trim_end_matches(['.', ' ']);
    let (stem, extension) = trimmed.rsplit_once('.')?;
    if stem.is_empty() || extension.is_empty() {
        return None;
    }
    Some(extension.to_ascii_lowercase())
}

/// Whether the system's default application may be started for this file.
/// An allowlist: only a document or media type whose extension AND bytes agree
/// (a `.png` that is a PNG, a `.txt` that is text). Programs, scripts,
/// shortcuts, installers and packages (`.exe`, `.msix`, `.appinstaller`,
/// `.lnk`, `.jar`, ...), web pages and SVG (they can run script) and Office
/// files (macros, linked content, DDE; an agent-written file carries no
/// "downloaded" mark) are never started: Save as and Open containing folder
/// stay.
pub(crate) fn open_allowed(extension: Option<&str>, sniffed: &Sniffed) -> bool {
    let Some(extension) = extension else {
        return false;
    };
    if sniffed.executable {
        return false;
    }
    let mime = match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" | "markdown" | "csv" | "json" => {
            return sniffed.kind == ChatFileKind::Text;
        }
        _ => return false,
    };
    sniffed.mime == mime
}

fn preview_limit(kind: ChatFileKind) -> Option<u64> {
    match kind {
        ChatFileKind::Image => Some(MAX_IMAGE_PREVIEW_BYTES),
        ChatFileKind::Audio | ChatFileKind::Video => Some(MAX_MEDIA_PREVIEW_BYTES),
        ChatFileKind::Pdf | ChatFileKind::Text | ChatFileKind::File => None,
    }
}

fn is_previewable(kind: ChatFileKind, size: u64) -> bool {
    size > 0 && preview_limit(kind).is_some_and(|limit| size <= limit)
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/// Where a reported file's bytes are.
pub(crate) enum ChatFileInput {
    Path(PathBuf),
    /// Bytes the agent returned without a file (a read image, an MCP result).
    Inline {
        mime: String,
        bytes: Vec<u8>,
    },
}

/// Where a session's files may be served from (see the module notes).
#[derive(Clone, Debug, Default)]
pub(crate) struct FileScope {
    /// The session's canonical working folder (its worktree when it has one).
    working: Option<PathBuf>,
    /// Canonical folders any path file may live in whatever its origin: the
    /// working folder and the folders the host resolves for the harness.
    roots: Vec<PathBuf>,
    /// The canonical folder of the host's inline store for this session.
    inline: Option<PathBuf>,
}

impl FileScope {
    fn contains(&self, canonical: &Path) -> bool {
        self.roots.iter().any(|root| within(canonical, root))
    }

    fn contains_inline(&self, canonical: &Path) -> bool {
        self.inline
            .as_ref()
            .is_some_and(|root| within(canonical, root))
    }

    /// The canonical working folder, when the session has a usable one.
    fn working(&self) -> Option<&Path> {
        self.working.as_deref()
    }
}

/// Whether `path` is `root` or below it (Windows ignores case). Both are
/// absolute; the verbatim prefix is dropped first.
fn within(path: &Path, root: &Path) -> bool {
    let (path, root) = (display_path(path), display_path(root));
    if cfg!(windows) {
        Path::new(&path.to_lowercase()).starts_with(root.to_lowercase())
    } else {
        Path::new(&path).starts_with(&root)
    }
}

/// The user's home folder, where the host looks for a harness's own folders.
fn home_directory() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
}

/// Folders a harness writes its own generated files to, resolved by the host
/// (never by the WebView or an event). Codex saves the images its
/// `imageGeneration` tool makes under `<Codex home>/generated_images/<thread>/`;
/// no other harness has such a folder.
pub(crate) fn output_roots(harness: HarnessKind) -> Vec<PathBuf> {
    match harness {
        HarnessKind::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .or_else(|| home_directory().map(|home| home.join(".codex")))
            .map(|home| home.join("generated_images"))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// Payload of [`CHAT_FILES_EVENT`]: the session whose files changed. The
/// WebView then asks `workspace_chat_files_v1` for the listing again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFilesChanged {
    pub protocol: u8,
    pub session_id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

impl ChatFilesChanged {
    pub(crate) fn new(session_id: &str) -> Self {
        Self {
            protocol: CHAT_FILES_PROTOCOL,
            session_id: session_id.to_owned(),
            kind: "changed",
        }
    }
}

pub(crate) type ChatFilesPublisher = Arc<dyn Fn(ChatFilesChanged) + Send + Sync>;

/// Coalesces "this session's files changed" into one host event per window.
/// Cheap to clone; safe to call from any thread inside the runtime.
#[derive(Clone)]
pub(crate) struct ChangeNotifier {
    inner: Arc<NotifierInner>,
}

struct NotifierInner {
    pending: AtomicBool,
    publish: Box<dyn Fn() + Send + Sync>,
}

impl ChangeNotifier {
    pub(crate) fn new(publish: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(NotifierInner {
                pending: AtomicBool::new(false),
                publish: Box::new(publish),
            }),
        }
    }

    /// Something in the registry changed: one event follows shortly after.
    pub(crate) fn changed(&self) {
        if self.inner.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            tokio::time::sleep(CHANGE_COALESCE).await;
            inner.pending.store(false, Ordering::Release);
            (inner.publish)();
        });
    }
}

/// Records a reported file without blocking the event forwarder: inline
/// bytes are written on the blocking pool, a path is only noted. A kept file
/// tells `notifier`, so the WebView lists again once the registry has it.
/// Called by the session event forwarder in `workspace_api.rs`.
pub(crate) fn record_report(
    registry: &Arc<ChatFileRegistry>,
    session_id: &str,
    report: ChatFileReport,
    base: Option<PathBuf>,
    scope: &FileScope,
    notifier: &ChangeNotifier,
) {
    match report.source {
        ChatFileInput::Path(_) => {
            if registry.record(session_id, report, base.as_deref(), scope) {
                notifier.changed();
            }
        }
        ChatFileInput::Inline { .. } => {
            let registry = Arc::clone(registry);
            let session_id = session_id.to_owned();
            let scope = scope.clone();
            let notifier = notifier.clone();
            tokio::task::spawn_blocking(move || {
                if registry.record(&session_id, report, None, &scope) {
                    notifier.changed();
                }
            });
        }
    }
}

/// Registers the files a closed chat's native history reported, on the
/// blocking thread that read the history. `base` joins a relative path.
pub(crate) fn record_history(
    registry: &ChatFileRegistry,
    session_id: &str,
    base: &Path,
    files: &[HistoryChatFile],
    scope: &FileScope,
) {
    for file in files {
        let origin = match file.origin {
            HistoryChatFileOrigin::Written => ChatFileOrigin::Written,
            HistoryChatFileOrigin::Read => ChatFileOrigin::Read,
            HistoryChatFileOrigin::Generated => ChatFileOrigin::Generated,
        };
        match (&file.path, &file.inline) {
            (Some(path), _) => {
                registry.register_path(session_id, &file.block_id, path, origin, Some(base), scope);
            }
            (None, Some((mime, bytes))) => {
                registry.register_inline(session_id, &file.block_id, mime, bytes, origin);
            }
            (None, None) => {}
        }
    }
}

/// One file reported by a session's native events or native history.
pub(crate) struct ChatFileReport {
    pub block_id: String,
    pub source: ChatFileInput,
    pub origin: ChatFileOrigin,
}

impl From<piui_runtime::chat_file::ChatFileEvent> for ChatFileReport {
    fn from(event: piui_runtime::chat_file::ChatFileEvent) -> Self {
        use piui_runtime::chat_file::{ChatFileOrigin as Native, ChatFileSource};
        Self {
            block_id: event.block_id,
            source: match event.source {
                ChatFileSource::Path(path) => ChatFileInput::Path(path),
                ChatFileSource::Inline { mime, bytes } => ChatFileInput::Inline { mime, bytes },
            },
            origin: match event.origin {
                Native::Written => ChatFileOrigin::Written,
                Native::Read => ChatFileOrigin::Read,
                Native::Generated => ChatFileOrigin::Generated,
                Native::Returned => ChatFileOrigin::Returned,
            },
        }
    }
}

#[derive(Clone, Debug)]
struct Entry {
    id: String,
    /// The absolute path as reported, without `.` and `..`.
    path: PathBuf,
    /// The canonical path first seen; every later call must find the same one.
    pinned: Option<PathBuf>,
    /// Stored by the host (inline bytes): not revealable.
    owned: bool,
    name: String,
    blocks: Vec<(String, ChatFileOrigin)>,
    inline_bytes: u64,
    /// SHA-256 of stored inline bytes: the same bytes of the same block are one file.
    digest: Option<[u8; 32]>,
}

/// Written or generated by the session's own agent.
fn agent_origin(origin: ChatFileOrigin) -> bool {
    matches!(origin, ChatFileOrigin::Written | ChatFileOrigin::Generated)
}

impl Entry {
    /// The agent itself wrote or generated this file in some block.
    fn agent_made(&self) -> bool {
        self.blocks.iter().any(|(_, origin)| agent_origin(*origin))
    }

    fn touch(&mut self, block_id: &str, origin: ChatFileOrigin) {
        if let Some(existing) = self.blocks.iter_mut().find(|(id, _)| id == block_id) {
            existing.1 = origin;
            return;
        }
        if self.blocks.len() >= MAX_BLOCKS_PER_FILE {
            self.blocks.remove(0);
        }
        self.blocks.push((block_id.to_owned(), origin));
    }
}

#[derive(Default)]
struct SessionFiles {
    /// Least recently reported first.
    entries: Vec<Entry>,
}

pub(crate) struct ChatFileRegistry {
    root: PathBuf,
    sessions: Mutex<HashMap<String, SessionFiles>>,
}

fn valid_file_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id)
}

fn valid_block_id(block_id: &str) -> bool {
    !block_id.is_empty()
        && block_id.len() <= MAX_ID_BYTES
        && !block_id.chars().any(char::is_control)
}

/// Whether two absolute paths name the same place (Windows ignores case).
fn same_path(left: &Path, right: &Path) -> bool {
    // Windows spells one path with and without its verbatim prefix.
    let (left, right) = (display_path(left), display_path(right));
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

/// Removes `.` and resolves `..` lexically; `None` when `..` leaves the root.
fn normalize(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Some(normalized)
}

/// Network and device paths would make the host contact another machine.
fn local_prefix(path: &Path) -> bool {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
        ),
        _ => true,
    }
}

/// The absolute, normalized, local path a report names.
fn absolute_path(path: &Path, base: Option<&Path>) -> Option<PathBuf> {
    let text = path.as_os_str().to_string_lossy();
    if text.is_empty() || text.len() > MAX_PATH_BYTES || text.contains('\0') {
        return None;
    }
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let base = base.filter(|base| base.is_absolute())?;
        base.join(path)
    };
    let normalized = normalize(&joined)?;
    (normalized.is_absolute() && local_prefix(&normalized)).then_some(normalized)
}

/// The base name of a path, when it is a plain name the host can show.
fn display_file_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name.is_empty() || name.chars().any(char::is_control) {
        return None;
    }
    // An NTFS alternate data stream is not a file of its own.
    if cfg!(windows) && name.contains(':') {
        return None;
    }
    Some(name)
}

fn inline_extension(sniffed: Sniffed) -> &'static str {
    match sniffed.mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/mp4" => "m4a",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "application/pdf" => "pdf",
        "text/markdown" => "md",
        "text/plain" => "txt",
        _ => "bin",
    }
}

fn inline_title(sniffed: Sniffed) -> &'static str {
    match sniffed.kind {
        ChatFileKind::Image => "image",
        ChatFileKind::Audio => "audio",
        ChatFileKind::Video => "video",
        ChatFileKind::Pdf => "document",
        ChatFileKind::Text | ChatFileKind::File => "file",
    }
}

impl ChatFileRegistry {
    /// Opens the registry and clears the inline files of an earlier run.
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let root = app_data_dir.join(CHAT_FILES_DIRECTORY);
        if let Ok(metadata) = fs::symlink_metadata(&root)
            && metadata.is_dir()
            && !metadata.file_type().is_symlink()
        {
            // Inline files last as long as the run that produced them.
            let _ = fs::remove_dir_all(&root);
        }
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    /// The scope of a session: its working folder, the folders the host
    /// resolved for its harness (`outputs`) and its own inline store. Folders
    /// that do not exist are left out, so they admit nothing.
    pub(crate) fn scope(
        &self,
        session_id: &str,
        working: Option<&Path>,
        outputs: &[PathBuf],
    ) -> FileScope {
        let working = working.and_then(|path| fs::canonicalize(path).ok());
        let mut roots: Vec<PathBuf> = working.iter().cloned().collect();
        roots.extend(
            outputs
                .iter()
                .filter_map(|path| fs::canonicalize(path).ok()),
        );
        let inline = Uuid::parse_str(session_id)
            .ok()
            .and_then(|_| fs::canonicalize(&self.root).ok())
            .map(|root| root.join(session_id));
        FileScope {
            working,
            roots,
            inline,
        }
    }

    /// Records one reported file for `session_id`. `base` resolves a relative
    /// path (the session's folder). Returns whether the file was kept.
    pub(crate) fn record(
        &self,
        session_id: &str,
        report: ChatFileReport,
        base: Option<&Path>,
        scope: &FileScope,
    ) -> bool {
        let ChatFileReport {
            block_id,
            source,
            origin,
        } = report;
        match source {
            ChatFileInput::Path(path) => {
                self.register_path(session_id, &block_id, &path, origin, base, scope)
            }
            ChatFileInput::Inline { mime, bytes } => {
                self.register_inline(session_id, &block_id, &mime, &bytes, origin)
            }
        }
    }

    /// Registers a reported path. A file the agent did not itself write or
    /// generate is kept only when it lies inside `scope`; the check is
    /// repeated, on the opened handle, on every operation.
    pub(crate) fn register_path(
        &self,
        session_id: &str,
        block_id: &str,
        path: &Path,
        origin: ChatFileOrigin,
        base: Option<&Path>,
        scope: &FileScope,
    ) -> bool {
        if !valid_block_id(block_id) || session_id.is_empty() {
            return false;
        }
        let Some(absolute) = absolute_path(path, base) else {
            return false;
        };
        let Some(name) = display_file_name(&absolute) else {
            return false;
        };
        // Outside the agent's own output only the session's folders count.
        // The path is resolved first, so a link cannot smuggle a file in.
        let inside = agent_origin(origin) || {
            let probe = fs::canonicalize(&absolute).unwrap_or_else(|_| absolute.clone());
            scope.contains(&probe)
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        let files = sessions.entry(session_id.to_owned()).or_default();
        if let Some(position) = files
            .entries
            .iter()
            .position(|entry| !entry.owned && same_path(&entry.path, &absolute))
        {
            if !inside && !files.entries[position].agent_made() {
                return false;
            }
            let mut entry = files.entries.remove(position);
            entry.touch(block_id, origin);
            files.entries.push(entry);
            return true;
        }
        if !inside {
            return false;
        }
        let evicted = push_entry(
            files,
            Entry {
                id: Uuid::new_v4().to_string(),
                path: absolute,
                pinned: None,
                owned: false,
                name,
                blocks: vec![(block_id.to_owned(), origin)],
                inline_bytes: 0,
                digest: None,
            },
        );
        drop(sessions);
        remove_stored(&evicted);
        true
    }

    pub(crate) fn register_inline(
        &self,
        session_id: &str,
        block_id: &str,
        _declared_mime: &str,
        bytes: &[u8],
        origin: ChatFileOrigin,
    ) -> bool {
        if !valid_block_id(block_id)
            || bytes.is_empty()
            || bytes.len() > MAX_INLINE_FILE_BYTES
            || Uuid::parse_str(session_id).is_err()
        {
            return false;
        }
        // The bytes decide what the file is; the declared type never does.
        let head = &bytes[..bytes.len().min(HEAD_BYTES as usize)];
        let kind = sniff_media(head, None);
        if kind.executable {
            return false;
        }
        // A chat reopened reports the same bytes again: one file, one id.
        let mut digest = [0_u8; 32];
        digest.copy_from_slice(&Sha256::digest(bytes));
        {
            let Ok(mut sessions) = self.sessions.lock() else {
                return false;
            };
            if let Some(files) = sessions.get_mut(session_id)
                && let Some(position) = files.entries.iter().position(|entry| {
                    entry.digest == Some(digest)
                        && entry.blocks.iter().any(|(id, _)| id == block_id)
                })
            {
                let mut entry = files.entries.remove(position);
                entry.touch(block_id, origin);
                files.entries.push(entry);
                return true;
            }
        }
        let id = Uuid::new_v4().to_string();
        let extension = inline_extension(kind);
        let directory = self.root.join(session_id);
        let path = directory.join(format!("{id}.{extension}"));
        let partial = directory.join(format!("{id}.part"));
        let written = fs::create_dir_all(&directory)
            .and_then(|()| fs::write(&partial, bytes))
            .and_then(|()| fs::rename(&partial, &path));
        if written.is_err() {
            let _ = fs::remove_file(&partial);
            return false;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            let _ = fs::remove_file(&path);
            return false;
        };
        let files = sessions.entry(session_id.to_owned()).or_default();
        let mut evicted = push_entry(
            files,
            Entry {
                id,
                path,
                pinned: None,
                owned: true,
                name: format!("{}.{extension}", inline_title(kind)),
                blocks: vec![(block_id.to_owned(), origin)],
                inline_bytes: bytes.len() as u64,
                digest: Some(digest),
            },
        );
        evicted.extend(trim_inline(files));
        drop(sessions);
        remove_stored(&evicted);
        true
    }

    /// Registers a workspace file a mention named, with no block: it can be
    /// previewed and opened by id but is listed with no message.
    fn register_mention(&self, session_id: &str, canonical: &Path) -> Option<Entry> {
        let absolute = absolute_path(canonical, None)?;
        let name = display_file_name(&absolute)?;
        let mut sessions = self.sessions.lock().ok()?;
        let files = sessions.entry(session_id.to_owned()).or_default();
        if let Some(position) = files
            .entries
            .iter()
            .position(|entry| !entry.owned && same_path(&entry.path, &absolute))
        {
            let entry = files.entries.remove(position);
            files.entries.push(entry.clone());
            return Some(entry);
        }
        let entry = Entry {
            id: Uuid::new_v4().to_string(),
            path: absolute.clone(),
            pinned: Some(absolute),
            owned: false,
            name,
            blocks: Vec::new(),
            inline_bytes: 0,
            digest: None,
        };
        let evicted = push_entry(files, entry.clone());
        drop(sessions);
        remove_stored(&evicted);
        Some(entry)
    }

    fn entries(&self, session_id: &str) -> Vec<Entry> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|files| files.entries.clone()))
            .unwrap_or_default()
    }

    fn find(&self, session_id: &str, file_id: &str) -> Option<Entry> {
        self.sessions
            .lock()
            .ok()?
            .get(session_id)?
            .entries
            .iter()
            .find(|entry| entry.id == file_id)
            .cloned()
    }

    /// Remembers the canonical path a file was first seen at.
    fn pin(&self, session_id: &str, file_id: &str, canonical: PathBuf) {
        if let Ok(mut sessions) = self.sessions.lock()
            && let Some(entry) = sessions
                .get_mut(session_id)
                .and_then(|files| files.entries.iter_mut().find(|entry| entry.id == file_id))
            && entry.pinned.is_none()
        {
            entry.pinned = Some(canonical);
        }
    }

    /// Forgets a session's files and deletes the bytes the host stored.
    pub(crate) fn forget_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        if Uuid::parse_str(session_id).is_ok() {
            let _ = fs::remove_dir_all(self.root.join(session_id));
        }
    }
}

/// Adds an entry, keeping the session within its file cap; returns the stored
/// files of the entries it dropped.
fn push_entry(files: &mut SessionFiles, entry: Entry) -> Vec<PathBuf> {
    files.entries.push(entry);
    let mut evicted = Vec::new();
    while files.entries.len() > MAX_FILES_PER_SESSION {
        let dropped = files.entries.remove(0);
        if dropped.owned {
            evicted.push(dropped.path);
        }
    }
    evicted
}

/// Drops the oldest inline files while the session holds too many.
fn trim_inline(files: &mut SessionFiles) -> Vec<PathBuf> {
    let mut evicted = Vec::new();
    loop {
        let count = files.entries.iter().filter(|entry| entry.owned).count();
        let bytes: u64 = files.entries.iter().map(|entry| entry.inline_bytes).sum();
        // The newest inline file always stays.
        if count <= 1
            || (count <= MAX_INLINE_FILES_PER_SESSION && bytes <= MAX_INLINE_BYTES_PER_SESSION)
        {
            return evicted;
        }
        let Some(position) = files.entries.iter().position(|entry| entry.owned) else {
            return evicted;
        };
        evicted.push(files.entries.remove(position).path);
    }
}

fn remove_stored(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Checking and reading a file
// ---------------------------------------------------------------------------

/// A file that passed every check, held open.
struct OpenedFile {
    file: fs::File,
    /// The final path of the opened handle itself (not a name looked up again).
    canonical: PathBuf,
    len: u64,
    #[cfg(unix)]
    executable_bit: bool,
}

/// The path of the file `file` really is. Windows asks the handle
/// (`GetFinalPathNameByHandleW`), so a path swapped after the open changes
/// nothing. Elsewhere the canonical path of `path` counts only when its device
/// and inode are the handle's.
#[cfg(windows)]
fn final_path(file: &fs::File, _path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };

    let handle = file.as_raw_handle();
    let mut buffer = vec![0_u16; 1_024];
    loop {
        // SAFETY: `handle` stays valid while `file` is borrowed; the buffer
        // pointer and its length in UTF-16 units describe one live allocation.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).ok()?,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if length == 0 || length > 32_768 {
            return None;
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Some(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(unix)]
fn final_path(file: &fs::File, path: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt as _;

    let canonical = fs::canonicalize(path).ok()?;
    let opened = file.metadata().ok()?;
    let named = fs::metadata(&canonical).ok()?;
    (opened.dev() == named.dev() && opened.ino() == named.ino()).then_some(canonical)
}

#[cfg(not(any(windows, unix)))]
fn final_path(_file: &fs::File, _path: &Path) -> Option<PathBuf> {
    None
}

/// Opens `entry` and checks the opened handle: the file is not a link, is a
/// regular file, is the path first seen, and its final path is inside `scope`.
/// The bytes are then read from this handle only. The open comes first, so a
/// path replaced between a check and a read cannot change what is served.
fn open_entry(entry: &Entry, scope: &FileScope) -> Result<OpenedFile, ChatFilesError> {
    let link = fs::symlink_metadata(&entry.path).map_err(|_| ChatFilesError::Unavailable)?;
    if link.file_type().is_symlink() {
        return Err(ChatFilesError::Unavailable);
    }
    let file = fs::File::open(&entry.path).map_err(|_| ChatFilesError::Unavailable)?;
    let metadata = file.metadata().map_err(|_| ChatFilesError::Unavailable)?;
    if !metadata.is_file() {
        return Err(ChatFilesError::Unavailable);
    }
    let canonical = final_path(&file, &entry.path).ok_or(ChatFilesError::Unavailable)?;
    if entry
        .pinned
        .as_ref()
        .is_some_and(|pinned| !same_path(pinned, &canonical))
    {
        return Err(ChatFilesError::Unavailable);
    }
    let allowed = if entry.owned {
        scope.contains_inline(&canonical)
    } else {
        entry.agent_made() || scope.contains(&canonical)
    };
    if !allowed {
        return Err(ChatFilesError::Unavailable);
    }
    Ok(OpenedFile {
        file,
        canonical,
        len: metadata.len(),
        #[cfg(unix)]
        executable_bit: {
            use std::os::unix::fs::PermissionsExt as _;
            metadata.permissions().mode() & 0o111 != 0
        },
    })
}

fn read_head(file: &fs::File) -> Result<Vec<u8>, ChatFilesError> {
    let mut head = Vec::new();
    file.take(HEAD_BYTES)
        .read_to_end(&mut head)
        .map_err(|_| ChatFilesError::Unavailable)?;
    Ok(head)
}

/// What a checked file is.
struct Inspected {
    sniffed: Sniffed,
    size: u64,
    openable: bool,
    canonical: PathBuf,
}

fn inspect_opened(entry: &Entry, opened: &OpenedFile) -> Result<Inspected, ChatFilesError> {
    let head = read_head(&opened.file)?;
    let extension = extension_of(&entry.name);
    let sniffed = sniff_media(&head, extension.as_deref());
    #[cfg(unix)]
    let program = opened.executable_bit;
    #[cfg(not(unix))]
    let program = false;
    // What opens is the file the handle is: its own name decides, not the label.
    let opened_extension = opened
        .canonical
        .file_name()
        .and_then(|name| extension_of(&name.to_string_lossy()));
    let openable = !program
        && opened_extension == extension
        && open_allowed(opened_extension.as_deref(), &sniffed);
    Ok(Inspected {
        sniffed,
        size: opened.len,
        openable,
        canonical: opened.canonical.clone(),
    })
}

fn unavailable_file(entry: &Entry, block_id: &str, origin: ChatFileOrigin) -> ChatFile {
    ChatFile {
        id: entry.id.clone(),
        block_id: block_id.to_owned(),
        name: entry.name.clone(),
        kind: ChatFileKind::File,
        media_type: None,
        size: None,
        origin,
        openable: false,
        previewable: false,
        revealable: false,
        unavailable: true,
    }
}

/// The contract entry of `entry` for one block, from a fresh check.
fn describe(
    entry: &Entry,
    inspected: &Result<Inspected, ChatFilesError>,
    block_id: &str,
    origin: ChatFileOrigin,
) -> ChatFile {
    match inspected {
        Err(_) => unavailable_file(entry, block_id, origin),
        Ok(inspected) => ChatFile {
            id: entry.id.clone(),
            block_id: block_id.to_owned(),
            name: entry.name.clone(),
            kind: inspected.sniffed.kind,
            media_type: Some(inspected.sniffed.mime.to_owned()),
            size: Some(inspected.size),
            origin,
            openable: inspected.openable,
            previewable: is_previewable(inspected.sniffed.kind, inspected.size),
            revealable: !entry.owned,
            unavailable: false,
        },
    }
}

fn inspect(entry: &Entry, scope: &FileScope) -> Result<Inspected, ChatFilesError> {
    let opened = open_entry(entry, scope)?;
    inspect_opened(entry, &opened)
}

/// Every file of a session with one entry per reporting block. Also returns
/// the canonical paths to pin.
fn list_files(entries: &[Entry], scope: &FileScope) -> (Vec<ChatFile>, Vec<(String, PathBuf)>) {
    let mut files = Vec::new();
    let mut pins = Vec::new();
    for entry in entries {
        if entry.blocks.is_empty() {
            continue;
        }
        let inspected = inspect(entry, scope);
        if let Ok(inspected) = &inspected
            && entry.pinned.is_none()
        {
            pins.push((entry.id.clone(), inspected.canonical.clone()));
        }
        for (block_id, origin) in &entry.blocks {
            files.push(describe(entry, &inspected, block_id, *origin));
        }
    }
    (files, pins)
}

/// The preview bytes of a file, read from the validated handle.
fn preview_bytes(
    entry: &Entry,
    scope: &FileScope,
) -> Result<(&'static str, Vec<u8>), ChatFilesError> {
    let mut opened = open_entry(entry, scope)?;
    let inspected = inspect_opened(entry, &opened)?;
    let limit = preview_limit(inspected.sniffed.kind).ok_or(ChatFilesError::NotPreviewable)?;
    if !is_previewable(inspected.sniffed.kind, inspected.size) {
        return Err(ChatFilesError::NotPreviewable);
    }
    opened
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|_| ChatFilesError::Unavailable)?;
    let mut bytes = Vec::new();
    (&opened.file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ChatFilesError::Unavailable)?;
    if bytes.len() as u64 > limit {
        return Err(ChatFilesError::NotPreviewable);
    }
    // The file may have changed since the check: identify the bytes served.
    let head = &bytes[..bytes.len().min(HEAD_BYTES as usize)];
    let served = sniff_media(head, extension_of(&entry.name).as_deref());
    if served.kind != inspected.sniffed.kind {
        return Err(ChatFilesError::NotPreviewable);
    }
    Ok((served.mime, bytes))
}

/// Copies the validated file to `destination` through a sibling temporary
/// file, so a failed copy or a destination that is the source never loses data.
fn copy_to(entry: &Entry, scope: &FileScope, destination: &Path) -> Result<(), ChatFilesError> {
    let mut opened = open_entry(entry, scope)?;
    let parent = destination.parent().ok_or(ChatFilesError::Failed)?;
    let name = destination.file_name().ok_or(ChatFilesError::Failed)?;
    let mut temporary_name: OsString = name.to_os_string();
    temporary_name.push(format!(".{}.part", Uuid::new_v4().simple()));
    let temporary = parent.join(temporary_name);
    let copied = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut output| {
            io::copy(&mut opened.file, &mut output)?;
            output.sync_all()
        });
    drop(opened);
    match copied.and_then(|()| fs::rename(&temporary, destination)) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err(ChatFilesError::Failed)
        }
    }
}

// ---------------------------------------------------------------------------
// System actions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub(crate) const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// A program start: separate arguments, and on Windows one raw tail that
/// Explorer's own `/select,` syntax needs.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct LaunchPlan {
    pub program: &'static str,
    pub args: Vec<OsString>,
    pub raw_tail: Option<String>,
}

/// Shows `path` in its folder. No shell string is ever built: Explorer gets
/// one quoted `/select,` argument (a comma or a space in the path cannot split
/// it), Finder `-R` and the path as separate arguments, and a Linux file
/// manager the parent folder.
pub(crate) fn reveal_plan(platform: Platform, path: &Path) -> Result<LaunchPlan, ChatFilesError> {
    match platform {
        Platform::Windows => {
            let text = display_path(path);
            if text.contains('"') || text.contains('\0') || text.is_empty() {
                return Err(ChatFilesError::Failed);
            }
            Ok(LaunchPlan {
                program: "explorer.exe",
                args: Vec::new(),
                raw_tail: Some(format!("/select,\"{text}\"")),
            })
        }
        Platform::MacOs => Ok(LaunchPlan {
            program: "open",
            args: vec![OsString::from("-R"), path.as_os_str().to_owned()],
            raw_tail: None,
        }),
        Platform::Linux => {
            let parent = path.parent().ok_or(ChatFilesError::Failed)?;
            Ok(LaunchPlan {
                program: "xdg-open",
                args: vec![parent.as_os_str().to_owned()],
                raw_tail: None,
            })
        }
    }
}

/// Opens `path` with the system default application; `None` on Windows,
/// which calls `ShellExecuteW` instead of starting a program.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn open_plan(platform: Platform, path: &Path) -> Option<LaunchPlan> {
    match platform {
        Platform::Windows => None,
        Platform::MacOs => Some(LaunchPlan {
            program: "open",
            args: vec![path.as_os_str().to_owned()],
            raw_tail: None,
        }),
        Platform::Linux => Some(LaunchPlan {
            program: "xdg-open",
            args: vec![path.as_os_str().to_owned()],
            raw_tail: None,
        }),
    }
}

fn launch(plan: &LaunchPlan) -> Result<(), ChatFilesError> {
    #[cfg(windows)]
    let program: PathBuf = if plan.program == "explorer.exe" {
        // The system's own Explorer, not whatever the search path finds first.
        std::env::var_os("SystemRoot")
            .map(|root| Path::new(&root).join("explorer.exe"))
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from(plan.program))
    } else {
        PathBuf::from(plan.program)
    };
    #[cfg(not(windows))]
    let program = PathBuf::from(plan.program);
    let mut command = Command::new(program);
    command.args(&plan.args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        if let Some(raw) = &plan.raw_tail {
            command.raw_arg(raw);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &plan.raw_tail;
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ChatFilesError::Failed)?;
    // Explorer reports failure through its exit code even when it worked:
    // reap the launcher without waiting for it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn shell_open(path: &Path) -> Result<(), ChatFilesError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = OsStr::new(&display_path(path))
        .encode_wide()
        .chain(Some(0))
        .collect();
    if target[..target.len() - 1].contains(&0) {
        return Err(ChatFilesError::Failed);
    }
    // SAFETY: `verb` and `target` are NUL-terminated UTF-16 buffers that
    // outlive the call; the remaining pointer arguments are documented as
    // optional and are null. The call does not retain any pointer.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // `ShellExecuteW` returns a value greater than 32 on success.
    if (result as usize) > 32 {
        Ok(())
    } else {
        Err(ChatFilesError::Failed)
    }
}

/// The system seam: production starts Explorer and the default application;
/// tests record what would have been started.
pub(crate) trait SystemActions: Send + Sync {
    fn reveal(&self, path: &Path) -> Result<(), ChatFilesError>;
    fn open(&self, path: &Path) -> Result<(), ChatFilesError>;
}

pub(crate) struct NativeActions;

impl SystemActions for NativeActions {
    fn reveal(&self, path: &Path) -> Result<(), ChatFilesError> {
        launch(&reveal_plan(Platform::current(), path)?)
    }

    fn open(&self, path: &Path) -> Result<(), ChatFilesError> {
        #[cfg(windows)]
        {
            shell_open(path)
        }
        #[cfg(not(windows))]
        {
            match open_plan(Platform::current(), path) {
                Some(plan) => launch(&plan),
                None => Err(ChatFilesError::Failed),
            }
        }
    }
}

/// The save dialog seam: gets the suggested file name and returns the chosen
/// destination, or `None` when the person cancelled.
pub(crate) type SaveDialog = Box<dyn FnOnce(String) -> Option<PathBuf> + Send>;

pub(crate) fn native_save_dialog() -> SaveDialog {
    Box::new(|name| rfd::FileDialog::new().set_file_name(name).save_file())
}

// ---------------------------------------------------------------------------
// Resolving a mention
// ---------------------------------------------------------------------------

/// The components of a name or workspace-relative path an agent mentions.
/// Absolute paths, drive letters, UNC paths and `..` are refused.
fn mention_components(name: &str) -> Result<Vec<String>, ChatFilesError> {
    if name.trim().is_empty() || name.len() > MAX_NAME_BYTES || name.chars().any(char::is_control) {
        return Err(ChatFilesError::Invalid);
    }
    let unified = name.trim().replace('\\', "/");
    let bytes = unified.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if unified.starts_with('/') || drive || unified.contains(':') {
        return Err(ChatFilesError::Invalid);
    }
    let mut components = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(ChatFilesError::Invalid),
            other => components.push(other.to_owned()),
        }
    }
    if components.is_empty() {
        return Err(ChatFilesError::Invalid);
    }
    Ok(components)
}

fn name_matches(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

/// Whether the reported path of `entry` ends with the mentioned components.
fn path_ends_with(entry: &Entry, components: &[String]) -> bool {
    let parts: Vec<String> = entry
        .path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    parts.len() >= components.len()
        && parts[parts.len() - components.len()..]
            .iter()
            .zip(components)
            .all(|(have, want)| name_matches(have, want))
}

/// The workspace file a relative mention names: inside the root, a regular
/// file, no link out of the root.
fn workspace_file(root: &Path, components: &[String]) -> Option<PathBuf> {
    let root = fs::canonicalize(root).ok()?;
    let mut candidate = root.clone();
    for part in components {
        candidate.push(part);
    }
    let link = fs::symlink_metadata(&candidate).ok()?;
    if link.file_type().is_symlink() {
        return None;
    }
    let canonical = fs::canonicalize(&candidate).ok()?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Where a mentioned name was found.
enum Resolution {
    /// A file this session already reported.
    Registered(ChatFile),
    /// A regular file inside the workspace root, to be registered.
    Workspace(PathBuf),
}

/// The session's scope, built from the verified project, its worktree and its
/// harness on every call, so a trust change or a removed worktree takes effect
/// at once.
fn files_scope(host: &HostState, session_id: &str) -> Result<FileScope, WorkspaceError> {
    validate_session_id(session_id)?;
    let record = host.workspace.record(session_id)?;
    let project = verified_project_directory(host, &record.workspace_id, true)?;
    let working = host
        .workspace
        .session_cwd(session_id, project.canonical_path());
    Ok(host.workspace.inner.chat_files.scope(
        session_id,
        working.as_deref(),
        &output_roots(record.harness),
    ))
}

fn known_entry(
    registry: &ChatFileRegistry,
    session_id: &str,
    file_id: &str,
) -> Result<Entry, WorkspaceError> {
    if !valid_file_id(file_id) {
        return Err(ChatFilesError::Invalid.into());
    }
    registry
        .find(session_id, file_id)
        .ok_or_else(|| ChatFilesError::Unavailable.into())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ChatFilesError> + Send + 'static,
) -> Result<T, WorkspaceError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| WorkspaceError::runtime())?
        .map_err(WorkspaceError::from)
}

fn resolved_file(entry: &Entry, scope: &FileScope) -> Option<ChatFile> {
    let origin = entry
        .blocks
        .last()
        .map_or(ChatFileOrigin::Returned, |(_, origin)| *origin);
    let inspected = inspect(entry, scope);
    inspected
        .as_ref()
        .ok()
        .map(|_| describe(entry, &inspected, "", origin))
}

/// The command without the Tauri boundary.
pub(crate) async fn run_chat_files(
    host: &HostState,
    command: ChatFilesCommand,
    dialog: SaveDialog,
    actions: Arc<dyn SystemActions>,
) -> Result<ChatFilesResult, WorkspaceError> {
    if host.safe_mode {
        return Err(WorkspaceError::safe_mode());
    }
    let registry = Arc::clone(&host.workspace.inner.chat_files);
    match command {
        ChatFilesCommand::List { session_id } => {
            let scope = files_scope(host, &session_id)?;
            let entries = registry.entries(&session_id);
            let (files, pins) = blocking(move || Ok(list_files(&entries, &scope))).await?;
            for (file_id, canonical) in pins {
                registry.pin(&session_id, &file_id, canonical);
            }
            Ok(ChatFilesResult::Files {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                files,
            })
        }
        ChatFilesCommand::Preview {
            session_id,
            file_id,
        } => {
            let scope = files_scope(host, &session_id)?;
            let entry = known_entry(&registry, &session_id, &file_id)?;
            let (media_type, bytes) = blocking(move || preview_bytes(&entry, &scope)).await?;
            Ok(ChatFilesResult::Preview {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                file_id,
                media_type: media_type.to_owned(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        }
        ChatFilesCommand::Save {
            session_id,
            file_id,
        } => {
            let scope = files_scope(host, &session_id)?;
            let entry = known_entry(&registry, &session_id, &file_id)?;
            // Refuse a missing or out-of-scope file before the dialog opens.
            {
                let (entry, scope) = (entry.clone(), scope.clone());
                blocking(move || open_entry(&entry, &scope).map(|_| ())).await?;
            }
            let suggested = entry.name.clone();
            // The dialog is modal to the person, not to other host operations.
            let chosen = tokio::task::spawn_blocking(move || dialog(suggested))
                .await
                .map_err(|_| WorkspaceError::runtime())?;
            let saved = match chosen {
                Some(destination) => {
                    // The dialog took time: check the file again, scope included,
                    // before copying.
                    blocking(move || copy_to(&entry, &scope, &destination)).await?;
                    true
                }
                None => false,
            };
            Ok(ChatFilesResult::Saved {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                file_id,
                saved,
            })
        }
        ChatFilesCommand::Reveal {
            session_id,
            file_id,
        } => {
            let scope = files_scope(host, &session_id)?;
            let entry = known_entry(&registry, &session_id, &file_id)?;
            if entry.owned {
                return Err(ChatFilesError::Failed.into());
            }
            // The path handed to the file manager is the final path of the
            // handle that passed the checks.
            let canonical =
                blocking(move || open_entry(&entry, &scope).map(|opened| opened.canonical)).await?;
            blocking(move || actions.reveal(&canonical)).await?;
            Ok(ChatFilesResult::Revealed {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                file_id,
            })
        }
        ChatFilesCommand::Open {
            session_id,
            file_id,
        } => {
            let scope = files_scope(host, &session_id)?;
            let entry = known_entry(&registry, &session_id, &file_id)?;
            blocking(move || {
                let inspected = inspect(&entry, &scope)?;
                if !inspected.openable {
                    return Err(ChatFilesError::OpenRefused);
                }
                actions.open(&inspected.canonical)
            })
            .await?;
            Ok(ChatFilesResult::Opened {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                file_id,
            })
        }
        ChatFilesCommand::Resolve { session_id, name } => {
            let scope = files_scope(host, &session_id)?;
            let components = mention_components(&name).map_err(WorkspaceError::from)?;
            let entries = registry.entries(&session_id);
            let found = {
                let scope = scope.clone();
                blocking(move || {
                    let last = components.last().cloned().unwrap_or_default();
                    let with_folders = components.len() > 1;
                    // The registry first: the latest file with this name wins.
                    for entry in entries.iter().rev() {
                        let matches = if with_folders {
                            path_ends_with(entry, &components)
                        } else {
                            name_matches(&entry.name, &last)
                        };
                        if matches && let Some(file) = resolved_file(entry, &scope) {
                            return Ok(Some(Resolution::Registered(file)));
                        }
                    }
                    Ok(scope
                        .working()
                        .and_then(|root| workspace_file(root, &components))
                        .map(Resolution::Workspace))
                })
                .await?
            };
            let file = match found {
                None => None,
                Some(Resolution::Registered(file)) => Some(file),
                Some(Resolution::Workspace(path)) => {
                    match registry.register_mention(&session_id, &path) {
                        Some(entry) => blocking(move || Ok(resolved_file(&entry, &scope))).await?,
                        None => None,
                    }
                }
            };
            Ok(ChatFilesResult::Resolved {
                protocol: CHAT_FILES_PROTOCOL,
                session_id,
                file,
            })
        }
    }
}

#[tauri::command]
pub async fn workspace_chat_files_v1(
    state: State<'_, HostState>,
    command: ChatFilesCommand,
) -> Result<ChatFilesResult, WorkspaceError> {
    run_chat_files(
        state.inner(),
        command,
        native_save_dialog(),
        Arc::new(NativeActions),
    )
    .await
}

#[cfg(test)]
#[path = "workspace_chat_files_tests.rs"]
mod tests;
