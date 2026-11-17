//! Read-only history projection for host-registered native workspace sessions.
//!
//! The trusted workspace host supplies the native transcript path and immutable
//! native session id from its private registry. This module never discovers,
//! launches, resumes, copies, converts, repairs, or writes native sessions.

use super::{
    BlockOrigin, BoundedScanError, GenericBlockKind, GenericBlockStatus, GenericTimelineBlock,
    OriginItem, ParseState, ScanReport, SessionDiscoveryLimits, UnknownEntrySummary,
    bounded_display, display_content, display_limit, is_session_jsonl, lf_frames,
    open_session_file_no_follow, redact_display_paths, scan_bytes_for_display_with_origins, sha256,
    string_field, trim_old_display,
};
use piui_platform::{ProjectDirectory, ProjectDirectoryError};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use thiserror::Error;

/// Native transcript grammar selected by trusted host registry metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceHistoryFormat {
    Pi,
    PrimeAgent,
    Codex,
    Hermes,
    /// Claude Code's own `<config>/projects/<cwd key>/<session id>.jsonl`.
    ClaudeCode,
}

/// A host-only native transcript reference.
///
/// This type deliberately has no serde implementation. Its debug form omits
/// the native id and path so it cannot become an IPC DTO or ordinary log value.
pub struct HostNativeHistorySource {
    path: PathBuf,
    expected_native_id: String,
    format: WorkspaceHistoryFormat,
}

impl HostNativeHistorySource {
    #[must_use]
    pub fn new(path: PathBuf, expected_native_id: String, format: WorkspaceHistoryFormat) -> Self {
        Self {
            path,
            expected_native_id,
            format,
        }
    }
}

impl std::fmt::Debug for HostNativeHistorySource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("HostNativeHistorySource(<redacted>)")
    }
}

#[derive(Debug, Error)]
pub enum WorkspaceHistoryError {
    #[error("native SQLite history is unavailable")]
    Database(#[from] rusqlite::Error),
    #[error("native history source path is invalid")]
    InvalidSourcePath,
    #[error("native history source must be a non-protected JSONL file")]
    InvalidSourceFile,
    #[error("{0}")]
    File(#[from] BoundedScanError),
    #[error("native history has a partial JSONL tail")]
    PartialTail,
    #[error("native history record {line} is malformed")]
    MalformedRecord { line: u64 },
    #[error("native history header is missing or unsupported")]
    InvalidHeader,
    #[error("native history header session id does not match the registry")]
    NativeSessionMismatch,
    #[error("native history header project directory is unavailable")]
    HeaderProjectUnavailable(#[source] ProjectDirectoryError),
    #[error("native history header does not belong to the registered project")]
    HeaderProjectMismatch,
    #[error("native history contains no readable timeline records")]
    NoTimelineRecords,
}

struct AssistantHistoryText {
    block_id: String,
    /// The `timeline-N` id this block had before blocks took their native
    /// identity. References stored under it keep resolving.
    legacy_id: String,
    sha256: String,
    text: String,
}

/// How a chat file relates to the block that names it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryChatFileOrigin {
    /// The agent wrote or edited it.
    Written,
    /// The agent read or viewed it.
    Read,
    /// The agent generated it (for example an image).
    Generated,
}

/// A file a closed chat's native history says its agent wrote, read or
/// generated, for the host's per-session file registry.
///
/// Host-private: no serde, and the debug form omits the path and the bytes. A
/// path is exactly as the native record spelled it (a relative one is joined to
/// the session's directory); the host must canonicalize and scope-check it
/// before use. Inline bytes are an image decoded from the history itself.
pub struct HistoryChatFile {
    /// The id of the history block that names the file, as in the projected
    /// timeline.
    pub block_id: String,
    pub path: Option<PathBuf>,
    /// Media type (sniffed from the bytes) and decoded bytes.
    pub inline: Option<(String, Vec<u8>)>,
    pub origin: HistoryChatFileOrigin,
}

impl std::fmt::Debug for HistoryChatFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistoryChatFile")
            .field("block_id", &self.block_id)
            .field("has_path", &self.path.is_some())
            .field(
                "inline_bytes",
                &self.inline.as_ref().map(|inline| inline.1.len()),
            )
            .field("origin", &self.origin)
            .finish()
    }
}

/// At most this many files are returned for one chat (the newest).
pub const HISTORY_CHAT_FILE_LIMIT: usize = 200;
/// An inline image larger than this is not returned.
pub const HISTORY_INLINE_FILE_LIMIT: usize = 20 * 1024 * 1024;
/// All inline images of one chat together stay under this (the newest win).
const HISTORY_INLINE_TOTAL_LIMIT: usize = 64 * 1024 * 1024;

/// UI-safe generic history plus exact host-private assistant text resolution.
///
/// The report uses the existing generic timeline projection. Exact assistant
/// text is intentionally private and available only through the lookup method
/// used to resolve an already validated orchestration dependency reference.
pub struct WorkspaceHistoryProjection {
    pub report: ScanReport,
    assistant_texts: Vec<AssistantHistoryText>,
    files: Vec<HistoryChatFile>,
}

impl std::fmt::Debug for WorkspaceHistoryProjection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceHistoryProjection")
            .field("report", &"<generic projection>")
            .field("assistant_text_count", &self.assistant_texts.len())
            .field("chat_file_count", &self.files.len())
            .finish()
    }
}

impl WorkspaceHistoryProjection {
    #[must_use]
    pub fn timeline_blocks(&self) -> &[GenericTimelineBlock] {
        &self.report.timeline_blocks
    }

    /// Files the native history says the agent wrote, read or generated, each
    /// tied to the id of a block of `timeline_blocks` (at most
    /// `HISTORY_CHAT_FILE_LIMIT`, newest last). Host-private: see
    /// `HistoryChatFile`.
    #[must_use]
    pub fn chat_files(&self) -> &[HistoryChatFile] {
        &self.files
    }

    /// Resolves exact source text. A block id (or the `timeline-N` id blocks
    /// had before they took their native identity) is accepted only when an
    /// optional hash also matches. If live runtime ids differ from scanner ids,
    /// the exact SHA-256 is the stable fallback. With neither selector, the
    /// newest assistant text is returned.
    #[must_use]
    pub fn final_assistant_text(
        &self,
        block_id: Option<&str>,
        content_hash: Option<&str>,
    ) -> Option<&str> {
        let valid_hash = content_hash.filter(|value| {
            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
        if content_hash.is_some() && valid_hash.is_none() {
            return None;
        }
        if let Some(block_id) = block_id
            && let Some(candidate) = self
                .assistant_texts
                .iter()
                .find(|candidate| candidate.block_id == block_id || candidate.legacy_id == block_id)
            && valid_hash.is_none_or(|hash| candidate.sha256.eq_ignore_ascii_case(hash))
        {
            return Some(candidate.text.as_str());
        }
        if let Some(hash) = valid_hash {
            return self
                .assistant_texts
                .iter()
                .rev()
                .find(|candidate| candidate.sha256.eq_ignore_ascii_case(hash))
                .map(|candidate| candidate.text.as_str());
        }
        if block_id.is_none() {
            return self
                .assistant_texts
                .last()
                .map(|candidate| candidate.text.as_str());
        }
        None
    }
}

/// Projects one host-registered native transcript without launching its
/// runtime. The byte bound is the index scanner's existing authoritative file
/// bound; callers cannot accidentally invent a different workspace-history
/// quota. Claude Code transcripts are the one exception: they are streamed
/// under their own, larger safety cap.
pub fn project_native_workspace_history(
    source: &HostNativeHistorySource,
    project: &ProjectDirectory,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    if source.format == WorkspaceHistoryFormat::Hermes {
        return project_hermes_history(source, project);
    }
    if source.format == WorkspaceHistoryFormat::ClaudeCode {
        return project_claude_code_history(source, project);
    }
    validate_source_path(&source.path)?;
    let max_bytes = SessionDiscoveryLimits::default().max_file_bytes;
    let (bytes, modified) = read_stable_bounded(&source.path, max_bytes)?;
    let (frames, tail_start) = lf_frames(&bytes);
    if tail_start != bytes.len() {
        return Err(WorkspaceHistoryError::PartialTail);
    }
    let (header_id, header_cwd) = parse_and_validate_header(frames.first(), source.format)?;
    if header_id != source.expected_native_id {
        return Err(WorkspaceHistoryError::NativeSessionMismatch);
    }
    let header_project = ProjectDirectory::resolve(Path::new(&header_cwd))
        .map_err(WorkspaceHistoryError::HeaderProjectUnavailable)?;
    if !header_project.same_directory(project) {
        return Err(WorkspaceHistoryError::HeaderProjectMismatch);
    }

    let source_name = source
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let mut projection = match source.format {
        WorkspaceHistoryFormat::Hermes | WorkspaceHistoryFormat::ClaudeCode => {
            return Err(WorkspaceHistoryError::InvalidHeader);
        }
        // Prime's bridge numbers its live blocks from the SDK message array,
        // which the JSONL does not carry: Prime keeps its position ids.
        WorkspaceHistoryFormat::Pi | WorkspaceHistoryFormat::PrimeAgent => project_pi_history(
            source_name,
            &bytes,
            Path::new(&header_cwd),
            source.format == WorkspaceHistoryFormat::Pi,
        )?,
        WorkspaceHistoryFormat::Codex => project_codex_history(
            source_name,
            &bytes,
            &header_id,
            &header_cwd,
            Path::new(&header_cwd),
        )?,
    };
    projection.report.source_modified = modified;
    if projection.report.timeline_blocks.is_empty() {
        return Err(WorkspaceHistoryError::NoTimelineRecords);
    }
    Ok(projection)
}

/// The files the native history of one registered chat says its agent wrote,
/// read or generated (the projection's `chat_files`, on its own), so the host's
/// per-session file registry can fill itself when the chat is reopened. A
/// path is host-private and unchecked; see `HistoryChatFile`.
pub fn history_chat_files(
    source: &HostNativeHistorySource,
    project: &ProjectDirectory,
) -> Result<Vec<HistoryChatFile>, WorkspaceHistoryError> {
    let mut projection = project_native_workspace_history(source, project)?;
    Ok(std::mem::take(&mut projection.files))
}

fn validate_source_path(path: &Path) -> Result<(), WorkspaceHistoryError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(WorkspaceHistoryError::InvalidSourcePath);
    }
    if !is_session_jsonl(path) {
        return Err(WorkspaceHistoryError::InvalidSourceFile);
    }
    Ok(())
}

fn read_stable_bounded(
    path: &Path,
    max_bytes: usize,
) -> Result<(Vec<u8>, Option<SystemTime>), BoundedScanError> {
    if max_bytes == 0 || max_bytes == usize::MAX {
        return Err(BoundedScanError::InvalidByteLimit);
    }
    let (file, opened_identity) = open_session_file_no_follow(path)?;
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

    let (final_file, final_identity) = open_session_file_no_follow(path)?;
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    if final_identity != opened_identity
        || opened_metadata.len() != bytes.len() as u64
        || final_metadata.len() != bytes.len() as u64
        || (opened_metadata.modified().ok().is_some()
            && final_metadata.modified().ok() != opened_metadata.modified().ok())
    {
        return Err(BoundedScanError::Changed);
    }
    Ok((bytes, final_metadata.modified().ok()))
}

fn parse_and_validate_header(
    first: Option<&(u64, &[u8])>,
    format: WorkspaceHistoryFormat,
) -> Result<(String, String), WorkspaceHistoryError> {
    let Some((line, frame)) = first else {
        return Err(WorkspaceHistoryError::InvalidHeader);
    };
    let decoded = std::str::from_utf8(frame)
        .map_err(|_| WorkspaceHistoryError::MalformedRecord { line: *line })?;
    let value: Value = serde_json::from_str(decoded)
        .map_err(|_| WorkspaceHistoryError::MalformedRecord { line: *line })?;
    let object = value
        .as_object()
        .ok_or(WorkspaceHistoryError::InvalidHeader)?;
    match format {
        WorkspaceHistoryFormat::Hermes | WorkspaceHistoryFormat::ClaudeCode => {
            Err(WorkspaceHistoryError::InvalidHeader)
        }
        WorkspaceHistoryFormat::Pi | WorkspaceHistoryFormat::PrimeAgent => {
            let entry_type = object.get("type").and_then(Value::as_str);
            if !matches!(entry_type, Some("session" | "session_meta")) {
                return Err(WorkspaceHistoryError::InvalidHeader);
            }
            let id = string_field(object, &["sessionId", "session_id", "id"])
                .filter(|id| !id.is_empty())
                .ok_or(WorkspaceHistoryError::InvalidHeader)?;
            let cwd = string_field(object, &["cwd"])
                .filter(|cwd| Path::new(cwd).is_absolute())
                .ok_or(WorkspaceHistoryError::InvalidHeader)?;
            Ok((id, cwd))
        }
        WorkspaceHistoryFormat::Codex => {
            if object.get("type").and_then(Value::as_str) != Some("session_meta") {
                return Err(WorkspaceHistoryError::InvalidHeader);
            }
            let payload = object
                .get("payload")
                .and_then(Value::as_object)
                .ok_or(WorkspaceHistoryError::InvalidHeader)?;
            // Codex's immutable app-server thread id is `id`; `session_id` is
            // a distinct execution-session identity in current rollouts.
            let id = string_field(payload, &["id"])
                .filter(|id| !id.is_empty())
                .ok_or(WorkspaceHistoryError::InvalidHeader)?;
            let cwd = string_field(payload, &["cwd"])
                .filter(|cwd| Path::new(cwd).is_absolute())
                .ok_or(WorkspaceHistoryError::InvalidHeader)?;
            Ok((id, cwd))
        }
    }
}

/// The ids the Pi bridge gives the same blocks when they are live: an answer
/// or thinking part by its message timestamp and rank
/// (`pi-assistant-*`, `pi-thinking-*`), a tool call by its id (`pi-tool-*`) and
/// anything else by its entry id (`pi-entry-*`). A block the transcript gives no
/// identity (or whose identity is already taken) keeps its position id.
fn pi_native_block_ids(blocks: &[GenericTimelineBlock], origins: &[BlockOrigin]) -> Vec<String> {
    let mut used = HashSet::<String>::new();
    let mut ids = Vec::with_capacity(blocks.len());
    for (index, block) in blocks.iter().enumerate() {
        let origin = origins.get(index);
        let mut candidates = Vec::new();
        if let Some(origin) = origin {
            let stamped = |prefix: &str, rank: usize| {
                origin
                    .message_timestamp
                    .filter(|timestamp| *timestamp > 0)
                    .map(|timestamp| opaque_id(prefix, &format!("{timestamp}:{rank}")))
            };
            match &origin.item {
                Some(OriginItem::Text { rank }) => {
                    candidates.extend(stamped("pi-assistant", *rank))
                }
                Some(OriginItem::Thinking { rank }) => {
                    candidates.extend(stamped("pi-thinking", *rank));
                }
                Some(OriginItem::ToolCall {
                    call_id: Some(call_id),
                    ..
                }) => candidates.push(opaque_id("pi-tool", call_id)),
                _ => {}
            }
            if let Some(entry_id) = &origin.entry_id {
                candidates.push(opaque_id("pi-entry", entry_id));
                candidates.push(opaque_id("pi-entry", &format!("{entry_id}:{index}")));
            }
        }
        candidates.push(block.id.clone());
        let id = candidates
            .into_iter()
            .find(|candidate| used.insert(candidate.clone()))
            .unwrap_or_else(|| format!("timeline-{index}"));
        ids.push(id);
    }
    ids
}

/// The files Pi's `write` and `edit` tool calls name.
fn pi_chat_files(
    blocks: &[GenericTimelineBlock],
    origins: &[BlockOrigin],
    root: &Path,
) -> Vec<HistoryChatFile> {
    let mut files = Vec::new();
    for (block, origin) in blocks.iter().zip(origins) {
        if let Some(OriginItem::ToolCall {
            name: Some(name),
            path: Some(path),
            ..
        }) = &origin.item
            && matches!(name.to_ascii_lowercase().as_str(), "write" | "edit")
            && let Some(path) = history_file_path(path, root)
        {
            files.push(HistoryChatFile {
                block_id: block.id.clone(),
                path: Some(path),
                inline: None,
                origin: HistoryChatFileOrigin::Written,
            });
        }
    }
    files
}

fn project_pi_history(
    source_name: &str,
    bytes: &[u8],
    display_project_root: &Path,
    bridge_ids: bool,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    let (mut report, origins) =
        scan_bytes_for_display_with_origins(source_name, bytes, Some(display_project_root));
    if report.partial_tail_bytes != 0 {
        return Err(WorkspaceHistoryError::PartialTail);
    }
    if let Some(diagnostic) = report.diagnostics.first() {
        return Err(WorkspaceHistoryError::MalformedRecord {
            line: diagnostic.line,
        });
    }
    let exact = exact_pi_assistant_texts(bytes)?;
    let native_ids = if bridge_ids {
        pi_native_block_ids(&report.timeline_blocks, &origins)
    } else {
        report
            .timeline_blocks
            .iter()
            .map(|block| block.id.clone())
            .collect()
    };
    let mut legacy_ids = Vec::new();
    for (block, native) in report.timeline_blocks.iter_mut().zip(native_ids) {
        legacy_ids.push(std::mem::replace(&mut block.id, native));
    }
    let assistant_texts = report
        .timeline_blocks
        .iter()
        .zip(&legacy_ids)
        .filter(|(block, _)| block.kind == GenericBlockKind::Assistant)
        .zip(exact)
        .map(|((block, legacy_id), text)| AssistantHistoryText {
            sha256: sha256(text.as_bytes()),
            block_id: block.id.clone(),
            legacy_id: legacy_id.clone(),
            text,
        })
        .collect();
    let files = finalize_chat_files(
        pi_chat_files(&report.timeline_blocks, &origins, display_project_root),
        &report.timeline_blocks,
    );
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts,
        files,
    })
}

fn exact_pi_assistant_texts(bytes: &[u8]) -> Result<Vec<String>, WorkspaceHistoryError> {
    let (frames, _) = lf_frames(bytes);
    let mut texts = Vec::new();
    for (line, frame) in frames.into_iter().skip(1) {
        let decoded = std::str::from_utf8(frame)
            .map_err(|_| WorkspaceHistoryError::MalformedRecord { line })?;
        let value: Value = serde_json::from_str(decoded)
            .map_err(|_| WorkspaceHistoryError::MalformedRecord { line })?;
        let object = value
            .as_object()
            .ok_or(WorkspaceHistoryError::MalformedRecord { line })?;
        if object.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = object.get("message").and_then(Value::as_object);
        let role = message
            .and_then(|message| message.get("role"))
            .or_else(|| object.get("role"))
            .and_then(Value::as_str);
        if role != Some("assistant") {
            continue;
        }
        let content = message
            .and_then(|message| message.get("content"))
            .or_else(|| object.get("content"))
            .or_else(|| object.get("text"));
        match content {
            Some(Value::Array(items)) => {
                let mut found_detail = false;
                for item in items {
                    let Some(item) = item.as_object() else {
                        continue;
                    };
                    if matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("text" | "markdown")
                    ) && let Some(text) = item.get("text").and_then(Value::as_str)
                    {
                        texts.push(text.to_owned());
                        found_detail = true;
                    }
                }
                if !found_detail && let Some(text) = exact_display_scalar(content) {
                    texts.push(text);
                }
            }
            _ => {
                if let Some(text) = exact_display_scalar(content) {
                    texts.push(text);
                }
            }
        }
    }
    Ok(texts)
}

fn exact_display_scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .or_else(|| object.get("output"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(Value::as_object)
                .filter(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("text" | "markdown" | "toolResult" | "bashExecution")
                    )
                })
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .or_else(|| item.get("output"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Same shape as the runtime bridges' `opaque`: a prefix and the first 24 hex
/// digits of the SHA-256 of the value. Block ids built here must equal the ids
/// the bridges give the same block when it is live.
fn opaque_id(prefix: &str, value: &str) -> String {
    let digest = sha256(value.as_bytes());
    format!("{prefix}-{}", &digest[..24])
}

/// A native identity is usable as a block id when the host accepts it back as a
/// branch point (non-empty, at most 256 characters, no control characters).
fn usable_native_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control)
}

struct CodexProjectionBuilder<'a> {
    project_root: &'a Path,
    blocks: Vec<GenericTimelineBlock>,
    assistants: Vec<AssistantHistoryText>,
    /// Native call id (or tool-use id) of a tool block to its index.
    tools: HashMap<String, usize>,
    /// Every block id handed out, to its index. Native ids are used as they
    /// are; a block without one (or with a repeated one) is `timeline-N`.
    index_by_id: HashMap<String, usize>,
    unknown_entries: Vec<UnknownEntrySummary>,
    last_visible: Option<(GenericBlockKind, String, CodexTextSource)>,
    /// The last block, when it is a user prompt that carried only attachments,
    /// and which kind of record made it.
    last_attachment_only: Option<(usize, CodexTextSource)>,
    image_entry_count: usize,
    compaction_entry_count: usize,
    /// Candidate chat files, tied to block ids; filtered when the projection
    /// is finished (see `finalize_chat_files`).
    files: Vec<HistoryChatFile>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CodexTextSource {
    Response,
    Event,
}

impl<'a> CodexProjectionBuilder<'a> {
    fn new(project_root: &'a Path) -> Self {
        Self {
            project_root,
            blocks: Vec::new(),
            assistants: Vec::new(),
            tools: HashMap::new(),
            index_by_id: HashMap::new(),
            unknown_entries: Vec::new(),
            last_visible: None,
            last_attachment_only: None,
            image_entry_count: 0,
            compaction_entry_count: 0,
            files: Vec::new(),
        }
    }

    /// The id for the block about to be pushed: the native identity when it is
    /// usable and free, else the position-based `timeline-N`.
    fn next_id(&mut self, native: Option<&str>) -> String {
        let index = self.blocks.len();
        let mut id = match native {
            Some(native) if usable_native_id(native) && !self.index_by_id.contains_key(native) => {
                native.to_owned()
            }
            _ => format!("timeline-{index}"),
        };
        while self.index_by_id.contains_key(&id) {
            id.push('_');
        }
        self.index_by_id.insert(id.clone(), index);
        id
    }

    /// Gives the last block a native identity when it only has a position id
    /// (a record seen twice, the second copy being the one that carries the id).
    fn adopt_native_id(&mut self, native: &str) {
        let Some(index) = self.blocks.len().checked_sub(1) else {
            return;
        };
        if !usable_native_id(native)
            || self.index_by_id.contains_key(native)
            || !self.blocks[index].id.starts_with("timeline-")
        {
            return;
        }
        let old = std::mem::replace(&mut self.blocks[index].id, native.to_owned());
        self.index_by_id.remove(&old);
        self.index_by_id.insert(native.to_owned(), index);
        for assistant in &mut self.assistants {
            if assistant.block_id == old {
                assistant.block_id = native.to_owned();
            }
        }
    }

    fn push_text(
        &mut self,
        kind: GenericBlockKind,
        source_type: &str,
        created_at: Option<String>,
        text: String,
        source: CodexTextSource,
        native_id: Option<&str>,
    ) {
        // The same native record can be persisted twice (a response item and
        // its typed event); the native id names both.
        if let Some(native) = native_id
            && let Some(&index) = self.index_by_id.get(native)
            && self.blocks[index].kind == kind
        {
            if index + 1 == self.blocks.len() {
                self.last_visible = Some((kind, text, source));
            }
            return;
        }
        // Codex 0.147 persists user/assistant/reasoning projections in both
        // response_item and event_msg records. Collapse only the adjacent
        // opposite-source copy so equal text in later turns remains visible.
        if self
            .last_visible
            .as_ref()
            .is_some_and(|(last_kind, last_text, last_source)| {
                *last_kind == kind && *last_source != source && last_text == &text
            })
        {
            if let Some(native) = native_id {
                self.adopt_native_id(native);
            }
            self.last_visible = Some((kind, text, source));
            return;
        }
        let legacy_id = format!("timeline-{}", self.blocks.len());
        let id = self.next_id(native_id);
        let (preview, truncated) = bounded_display(Some(&text), display_limit(kind));
        let preview = preview.map(|value| redact_display_paths(&value, Some(self.project_root)));
        self.blocks.push(GenericTimelineBlock {
            id: id.clone(),
            parent_id: None,
            kind,
            source_type: source_type.to_owned(),
            created_at,
            preview,
            has_image: false,
            attachment_count: 0,
            title: (kind == GenericBlockKind::Thinking).then(|| "Reasoning".into()),
            tool_name: None,
            collapsible: kind == GenericBlockKind::Thinking,
            truncated,
            fallback: false,
            status: GenericBlockStatus::Complete,
        });
        if kind == GenericBlockKind::Assistant {
            self.assistants.push(AssistantHistoryText {
                block_id: id,
                legacy_id,
                sha256: sha256(text.as_bytes()),
                text: text.clone(),
            });
        }
        self.last_visible = Some((kind, text, source));
    }

    /// A user prompt that carried only attachments: there is no text to show,
    /// but the prompt still opens its turn.
    fn push_attachment_only_user(
        &mut self,
        source_type: &str,
        created_at: Option<String>,
        source: CodexTextSource,
        native_id: Option<&str>,
    ) {
        // Codex records one prompt twice (a response item and its typed
        // event): the adjacent copy from the other kind of record is it.
        if let Some((index, last_source)) = self.last_attachment_only
            && index + 1 == self.blocks.len()
            && last_source != source
        {
            if let Some(native) = native_id {
                self.adopt_native_id(native);
            }
            self.last_attachment_only = Some((index, source));
            return;
        }
        self.last_attachment_only = Some((self.blocks.len(), source));
        let id = self.next_id(native_id);
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::User,
            source_type: source_type.to_owned(),
            created_at,
            preview: None,
            has_image: false,
            attachment_count: 0,
            title: None,
            tool_name: None,
            collapsible: false,
            truncated: false,
            fallback: false,
            status: GenericBlockStatus::Complete,
        });
        self.last_visible = None;
    }

    /// Marks the user block pushed since `before` (if any) as carrying
    /// `count` images or attachments; the bytes are never projected.
    fn mark_user_attachments(&mut self, before: usize, count: usize) {
        if count > 0
            && self.blocks.len() > before
            && let Some(block) = self.blocks.last_mut()
            && block.kind == GenericBlockKind::User
        {
            block.has_image = true;
            block.attachment_count = block.attachment_count.max(count);
            self.image_entry_count = self.image_entry_count.saturating_add(1);
        }
    }

    /// Pushes a tool block. `call_key` is the native id its result names;
    /// `native_id` is the block's own identity. A call already seen (the same
    /// call recorded as a response item and as an event) is not shown twice.
    fn push_tool(
        &mut self,
        created_at: Option<String>,
        name: Option<&str>,
        call_key: Option<&str>,
        native_id: Option<&str>,
    ) {
        if let Some(call_key) = call_key
            && self.tools.contains_key(call_key)
        {
            return;
        }
        let id = self.next_id(native_id);
        let title = name
            .filter(|name| !name.is_empty())
            .map(|name| super::safe_text(name, super::TYPE_LIMIT))
            .or_else(|| Some("Tool".into()));
        let index = self.blocks.len();
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Tool,
            source_type: "codex_tool_call".into(),
            created_at,
            preview: None,
            has_image: false,
            attachment_count: 0,
            title: title.clone(),
            tool_name: title,
            collapsible: true,
            truncated: false,
            fallback: false,
            status: GenericBlockStatus::Running,
        });
        if let Some(call_key) = call_key {
            self.tools.insert(call_key.to_owned(), index);
        }
        self.last_visible = None;
    }

    fn finish_tool(&mut self, call_id: Option<&str>, output: Option<String>, failed: bool) {
        if let Some(index) = call_id.and_then(|call_id| self.tools.get(call_id).copied()) {
            let block = &mut self.blocks[index];
            if let Some(output) = output {
                let (preview, truncated) =
                    bounded_display(Some(&output), display_limit(GenericBlockKind::Tool));
                block.preview =
                    preview.map(|value| redact_display_paths(&value, Some(self.project_root)));
                block.truncated |= truncated;
            }
            // A failure recorded by one copy of a record is not undone by the
            // other copy that only carries the output.
            block.status = if failed || block.status == GenericBlockStatus::Failed {
                GenericBlockStatus::Failed
            } else {
                GenericBlockStatus::Complete
            };
        } else {
            let id = self.next_id(None);
            let (preview, truncated) =
                bounded_display(output.as_deref(), display_limit(GenericBlockKind::Tool));
            let preview =
                preview.map(|value| redact_display_paths(&value, Some(self.project_root)));
            self.blocks.push(GenericTimelineBlock {
                id,
                parent_id: None,
                kind: GenericBlockKind::Tool,
                source_type: "codex_tool_result".into(),
                created_at: None,
                preview,
                has_image: false,
                attachment_count: 0,
                title: Some("Tool result".into()),
                tool_name: None,
                collapsible: true,
                truncated,
                fallback: true,
                status: if failed {
                    GenericBlockStatus::Failed
                } else {
                    GenericBlockStatus::Complete
                },
            });
        }
        self.last_visible = None;
    }

    /// A tool whose typed completion record names it by id: it finishes the
    /// call that is already shown, or is shown for the first time.
    fn complete_tool(
        &mut self,
        created_at: Option<String>,
        id: &str,
        name: Option<&str>,
        preview: Option<String>,
        failed: bool,
    ) {
        if !self.tools.contains_key(id) {
            self.push_tool(created_at, name, Some(id), Some(id));
        }
        self.finish_tool(Some(id), preview, failed);
    }

    /// The id of the tool block a call key names.
    fn tool_block_id(&self, call_key: &str) -> Option<String> {
        self.tools
            .get(call_key)
            .map(|index| self.blocks[*index].id.clone())
    }

    fn push_compaction(
        &mut self,
        created_at: Option<String>,
        text: Option<String>,
        native: Option<&str>,
    ) {
        // The typed item and the `compacted` record describe one compaction;
        // two in a row with nothing between them are one.
        if self
            .blocks
            .last()
            .is_some_and(|block| block.kind == GenericBlockKind::Compaction)
        {
            return;
        }
        let id = self.next_id(native);
        let (preview, truncated) =
            bounded_display(text.as_deref(), display_limit(GenericBlockKind::Compaction));
        let preview = preview.map(|value| redact_display_paths(&value, Some(self.project_root)));
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Compaction,
            source_type: "codex_compacted".into(),
            created_at,
            preview,
            has_image: false,
            attachment_count: 0,
            title: Some("Context compacted".into()),
            tool_name: None,
            collapsible: true,
            truncated,
            fallback: false,
            status: GenericBlockStatus::Complete,
        });
        self.compaction_entry_count = self.compaction_entry_count.saturating_add(1);
        self.last_visible = None;
    }

    fn push_unknown(
        &mut self,
        line: u64,
        frame: &[u8],
        source_type: &str,
        created_at: Option<String>,
    ) {
        self.unknown_entries.push(UnknownEntrySummary {
            line,
            entry_type: super::safe_text(source_type, super::TYPE_LIMIT),
            byte_length: frame.len(),
            sha256: sha256(frame),
        });
        let id = self.next_id(None);
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Unknown,
            source_type: "codex_unknown".into(),
            created_at,
            preview: None,
            has_image: false,
            attachment_count: 0,
            title: Some("Unrecognized session entry".into()),
            tool_name: None,
            collapsible: true,
            truncated: false,
            fallback: true,
            status: GenericBlockStatus::Complete,
        });
        self.last_visible = None;
    }

    /// Notes a file the block `block_id` names. A relative path is joined to
    /// the session's directory; nothing is checked here (the host does).
    fn note_path(&mut self, block_id: &str, raw_path: &str, origin: HistoryChatFileOrigin) {
        if let Some(path) = history_file_path(raw_path, self.project_root) {
            self.files.push(HistoryChatFile {
                block_id: block_id.to_owned(),
                path: Some(path),
                inline: None,
                origin,
            });
        }
    }

    /// Notes an image the history carries as base64 (returned only when it
    /// decodes within the per-file bound and is a known image format).
    fn note_inline_image(&mut self, block_id: &str, base64: &str, origin: HistoryChatFileOrigin) {
        if let Some(inline) = decode_inline_image(base64) {
            self.files.push(HistoryChatFile {
                block_id: block_id.to_owned(),
                path: None,
                inline: Some(inline),
                origin,
            });
        }
    }
}

/// A native path as a `PathBuf`: absolute as written, relative joined to the
/// session's directory. Over-long, empty and NUL-carrying values are refused.
fn history_file_path(raw: &str, root: &Path) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return None;
    }
    let path = Path::new(raw);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

/// Decodes standard (or URL-safe) base64, ignoring whitespace and padding.
fn decode_base64(input: &str, limit: usize) -> Option<Vec<u8>> {
    // Decoded size is at most 3/4 of the encoded size.
    if input.len() / 4 * 3 > limit.saturating_add(3) {
        return None;
    }
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut accumulator = 0_u32;
    let mut bits = 0_u32;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    (output.len() <= limit).then_some(output)
}

/// The media type of a PNG, JPEG, GIF or WebP, judged by its magic bytes.
fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// An inline image from base64 text, or a `data:` URL carrying it.
fn decode_inline_image(text: &str) -> Option<(String, Vec<u8>)> {
    let payload = match text.strip_prefix("data:") {
        Some(rest) => rest.split_once(',')?.1,
        None => text,
    };
    let bytes = decode_base64(payload, HISTORY_INLINE_FILE_LIMIT)?;
    let media_type = sniff_image_media_type(&bytes)?;
    Some((media_type.to_owned(), bytes))
}

/// Keeps the files of blocks that finished, drops repeats, and applies the
/// per-chat caps: the newest `HISTORY_CHAT_FILE_LIMIT` files, and the newest
/// inline images within `HISTORY_INLINE_TOTAL_LIMIT`.
fn finalize_chat_files(
    files: Vec<HistoryChatFile>,
    blocks: &[GenericTimelineBlock],
) -> Vec<HistoryChatFile> {
    let status_by_id = blocks
        .iter()
        .map(|block| (block.id.as_str(), block.status))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    // Newest first, so the caps drop the oldest.
    for file in files.into_iter().rev() {
        // A call that failed, was interrupted or never reported back did not
        // necessarily produce the file.
        if status_by_id.get(file.block_id.as_str()) != Some(&GenericBlockStatus::Complete) {
            continue;
        }
        if let Some(path) = &file.path
            && !seen.insert((file.block_id.clone(), path.clone()))
        {
            continue;
        }
        kept.push(file);
        if kept.len() >= HISTORY_CHAT_FILE_LIMIT {
            break;
        }
    }
    let mut inline_total = 0_usize;
    for file in &mut kept {
        let size = file.inline.as_ref().map(|(_, bytes)| bytes.len());
        if let Some(size) = size {
            if inline_total.saturating_add(size) > HISTORY_INLINE_TOTAL_LIMIT {
                file.inline = None;
            } else {
                inline_total += size;
            }
        }
    }
    kept.retain(|file| file.path.is_some() || file.inline.is_some());
    kept.reverse();
    kept
}

fn project_codex_history(
    source_name: &str,
    bytes: &[u8],
    header_id: &str,
    header_cwd: &str,
    project_root: &Path,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    let (frames, tail_start) = lf_frames(bytes);
    if tail_start != bytes.len() {
        return Err(WorkspaceHistoryError::PartialTail);
    }
    let mut builder = CodexProjectionBuilder::new(project_root);
    let mut updated_at = None;
    for (line, frame) in frames.into_iter().skip(1) {
        if frame.is_empty() {
            return Err(WorkspaceHistoryError::MalformedRecord { line });
        }
        let decoded = std::str::from_utf8(frame)
            .map_err(|_| WorkspaceHistoryError::MalformedRecord { line })?;
        let value: Value = serde_json::from_str(decoded)
            .map_err(|_| WorkspaceHistoryError::MalformedRecord { line })?;
        let object = value
            .as_object()
            .ok_or(WorkspaceHistoryError::MalformedRecord { line })?;
        let created_at = string_field(object, &["timestamp"]);
        updated_at = created_at.clone().or(updated_at);
        let entry_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = object.get("payload").and_then(Value::as_object);
        match (entry_type, payload) {
            ("response_item", Some(payload)) => {
                project_codex_response_item(&mut builder, line, frame, payload, created_at)
            }
            ("event_msg", Some(payload)) => {
                project_codex_event(&mut builder, line, frame, payload, created_at)
            }
            ("compacted", Some(payload)) => builder.push_compaction(
                created_at,
                payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                None,
            ),
            // These are source controls or potentially sensitive execution
            // context, never user-visible transcript blocks. A token usage
            // record is accounting, not conversation.
            (
                "session_meta"
                | "turn_context"
                | "world_state"
                | "token_usage_record"
                | "inter_agent_communication_metadata"
                | "inter_agent_communication",
                _,
            ) => {}
            _ => builder.push_unknown(line, frame, entry_type, created_at),
        }
    }
    trim_old_display(&mut builder.blocks);

    let mut report = super::scan_bytes(source_name, bytes);
    report.pi_session_id = Some(header_id.to_owned());
    report.project_cwd = Some(header_cwd.to_owned());
    report.created_at = first_timestamp(bytes);
    report.updated_at = updated_at.or_else(|| report.created_at.clone());
    report.first_user_preview = builder.blocks.iter().find_map(|block| {
        (block.kind == GenericBlockKind::User)
            .then(|| block.preview.clone())
            .flatten()
    });
    report.last_message_preview = builder.blocks.iter().rev().find_map(|block| {
        matches!(
            block.kind,
            GenericBlockKind::User | GenericBlockKind::Assistant
        )
        .then(|| block.preview.clone())
        .flatten()
    });
    report.entry_count = builder.blocks.len();
    report.image_entry_count = builder.image_entry_count;
    report.compaction_entry_count = builder.compaction_entry_count;
    report.branch_count = 0;
    report.current_leaf_id = None;
    report.roots.clear();
    report.orphan_ids.clear();
    report.cycle_ids.clear();
    report.entries.clear();
    report.tree.clear();
    report.diagnostics.clear();
    report.unknown_entries = builder.unknown_entries;
    report.parse_state = if report.unknown_entries.is_empty() {
        ParseState::Healthy
    } else {
        ParseState::Unsupported
    };
    let files = finalize_chat_files(builder.files, &builder.blocks);
    report.timeline_blocks = builder.blocks;
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts: builder.assistants,
        files,
    })
}

/// A record type spelled any way (`CommandExecution`, `commandExecution`,
/// `command_execution`) as one lowercase word.
fn codex_kind(value: &str) -> String {
    value
        .chars()
        .filter(|character| *character != '_' && *character != '-')
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// Text Codex adds to the conversation as a user message for its own use:
/// instruction files, environment and skill context and notifications. These
/// are not what the person typed.
fn is_codex_contextual_user_text(text: &str) -> bool {
    let text = text.trim_start();
    if text.starts_with("# AGENTS.md instructions for ") {
        return true;
    }
    [
        "<environment_context>",
        "<user_instructions>",
        "<skill>",
        "<subagent_notification>",
        "<turn_aborted>",
    ]
    .iter()
    .any(|marker| text.starts_with(marker))
}

fn project_codex_response_item(
    builder: &mut CodexProjectionBuilder<'_>,
    line: u64,
    frame: &[u8],
    payload: &Map<String, Value>,
    created_at: Option<String>,
) {
    let item_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    let native_id = payload.get("id").and_then(Value::as_str);
    match item_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str);
            // System/developer records contain native instructions and runtime
            // context. They are never transcript content.
            if matches!(role, Some("system" | "developer")) {
                return;
            }
            let (text, image_count) = codex_message_content(payload.get("content"));
            if role == Some("user") && text.as_deref().is_some_and(is_codex_contextual_user_text) {
                return;
            }
            let Some(text) = text else {
                if role == Some("user") && image_count > 0 {
                    let before = builder.blocks.len();
                    builder.push_attachment_only_user(
                        "codex_response_message",
                        created_at,
                        CodexTextSource::Response,
                        None,
                    );
                    builder.mark_user_attachments(before, image_count);
                }
                return;
            };
            match role {
                Some("user") => {
                    let before = builder.blocks.len();
                    // The typed event names a user prompt; the response item
                    // does not.
                    builder.push_text(
                        GenericBlockKind::User,
                        "codex_response_message",
                        created_at,
                        text,
                        CodexTextSource::Response,
                        None,
                    );
                    builder.mark_user_attachments(before, image_count);
                }
                Some("assistant") => builder.push_text(
                    GenericBlockKind::Assistant,
                    "codex_response_message",
                    created_at,
                    text,
                    CodexTextSource::Response,
                    native_id,
                ),
                _ => builder.push_unknown(line, frame, "response_item.message", created_at),
            }
        }
        "reasoning" => {
            if let Some(text) = codex_reasoning_summary(payload.get("summary")) {
                builder.push_text(
                    GenericBlockKind::Thinking,
                    "codex_reasoning",
                    created_at,
                    text,
                    CodexTextSource::Response,
                    native_id,
                );
            }
            // encrypted_content and raw reasoning content are deliberately ignored.
        }
        "function_call" | "custom_tool_call" => {
            let name = payload.get("name").and_then(Value::as_str);
            let call_id = payload.get("call_id").and_then(Value::as_str);
            builder.push_tool(created_at, name, call_id, call_id.or(native_id));
            if name == Some("apply_patch")
                && let Some(block_id) = call_id.and_then(|call| builder.tool_block_id(call))
            {
                for path in apply_patch_paths(payload) {
                    builder.note_path(&block_id, &path, HistoryChatFileOrigin::Written);
                }
            }
        }
        "local_shell_call" => {
            let call_id = payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str);
            builder.push_tool(created_at, Some("Command"), call_id, call_id);
        }
        "function_call_output" | "custom_tool_call_output" => {
            let output = codex_tool_output(payload.get("output"));
            builder.finish_tool(
                payload.get("call_id").and_then(Value::as_str),
                output,
                false,
            );
        }
        "web_search_call" => {
            builder.push_tool(created_at, Some("Web search"), native_id, native_id)
        }
        "image_generation_call" => {
            let Some(key) = native_id else {
                builder.push_unknown(
                    line,
                    frame,
                    "response_item.image_generation_call",
                    created_at,
                );
                return;
            };
            let failed = payload.get("status").and_then(Value::as_str) == Some("failed");
            builder.complete_tool(created_at, key, Some("Image generation"), None, failed);
            if let Some(block_id) = builder.tool_block_id(key)
                && let Some(result) = payload.get("result").and_then(Value::as_str)
            {
                builder.note_inline_image(&block_id, result, HistoryChatFileOrigin::Generated);
            }
        }
        // Inter-agent messages and configuration changes are native control
        // records, not conversation. Compaction ciphertext and tool
        // declarations contain no readable transcript text and can include
        // private native configuration.
        "agent_message"
        | "configuration_update"
        | "compaction_trigger"
        | "compaction"
        | "context_compaction"
        | "additional_tools"
        | "tool_search_call"
        | "tool_search_output" => {}
        _ => builder.push_unknown(line, frame, "response_item", created_at),
    }
}

/// Paths an `apply_patch` call adds or updates, read from the patch text its
/// input (or JSON arguments) carries.
fn apply_patch_paths(payload: &Map<String, Value>) -> Vec<String> {
    fn collect(value: &Value, depth: usize, out: &mut Vec<String>) {
        if depth > 4 {
            return;
        }
        match value {
            Value::String(text) => {
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(path) = line
                        .strip_prefix("*** Add File: ")
                        .or_else(|| line.strip_prefix("*** Update File: "))
                        && out.len() < 64
                    {
                        out.push(path.trim().to_owned());
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, depth + 1, out)),
            Value::Object(object) => object
                .values()
                .for_each(|item| collect(item, depth + 1, out)),
            _ => {}
        }
    }
    let mut paths = Vec::new();
    if let Some(input) = payload.get("input") {
        collect(input, 0, &mut paths);
    }
    if let Some(Value::String(arguments)) = payload.get("arguments") {
        match serde_json::from_str::<Value>(arguments) {
            Ok(parsed) => collect(&parsed, 0, &mut paths),
            Err(_) => collect(&Value::String(arguments.clone()), 0, &mut paths),
        }
    }
    paths
}

fn project_codex_event(
    builder: &mut CodexProjectionBuilder<'_>,
    line: u64,
    frame: &[u8],
    payload: &Map<String, Value>,
    created_at: Option<String>,
) {
    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "user_message" => {
            let before = builder.blocks.len();
            let image_count = ["images", "local_images"]
                .iter()
                .filter_map(|key| payload.get(*key).and_then(Value::as_array))
                .map(Vec::len)
                .sum::<usize>();
            match payload.get("message").and_then(Value::as_str) {
                Some(text) if !text.is_empty() => builder.push_text(
                    GenericBlockKind::User,
                    "codex_user_message",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
                    None,
                ),
                _ if image_count > 0 => builder.push_attachment_only_user(
                    "codex_user_message",
                    created_at,
                    CodexTextSource::Event,
                    None,
                ),
                _ => {}
            }
            builder.mark_user_attachments(before, image_count);
        }
        "agent_message" => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                builder.push_text(
                    GenericBlockKind::Assistant,
                    "codex_agent_message",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
                    None,
                );
            }
        }
        "agent_reasoning" => {
            if let Some(text) = payload.get("text").and_then(Value::as_str) {
                builder.push_text(
                    GenericBlockKind::Thinking,
                    "codex_agent_reasoning",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
                    None,
                );
            }
        }
        // Raw chain-of-thought is not a user-facing reasoning summary.
        "agent_reasoning_raw_content" | "agent_reasoning_section_break" => {}
        "item_completed" => match payload.get("item").and_then(Value::as_object) {
            Some(item) => project_codex_item(builder, line, frame, item, created_at),
            None => builder.push_unknown(line, frame, "event_msg.item_completed", created_at),
        },
        "exec_command_begin" => {
            let call_id = payload.get("call_id").and_then(Value::as_str);
            builder.push_tool(created_at, Some("Command"), call_id, call_id);
        }
        "exec_command_end" => {
            let output = payload
                .get("aggregated_output")
                .or_else(|| payload.get("formatted_output"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            // A record without an exit code proves no failure.
            let failed = payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0);
            builder.finish_tool(
                payload.get("call_id").and_then(Value::as_str),
                output,
                failed,
            );
        }
        "mcp_tool_call_begin" => {
            let name = payload
                .get("invocation")
                .and_then(Value::as_object)
                .and_then(|invocation| invocation.get("tool"))
                .and_then(Value::as_str);
            let call_id = payload.get("call_id").and_then(Value::as_str);
            builder.push_tool(created_at, name, call_id, call_id);
        }
        "mcp_tool_call_end" => {
            let failed = payload.get("result").is_some_and(|result| {
                result
                    .as_object()
                    .is_some_and(|object| object.contains_key("Err"))
                    || result.as_str().is_some()
            });
            builder.finish_tool(payload.get("call_id").and_then(Value::as_str), None, failed);
        }
        "context_compacted" => builder.push_compaction(created_at, None, None),
        // Known lifecycle/settings/error events get no content block. Error
        // payloads can include native environment or provider details.
        "task_started"
        | "turn_started"
        | "task_complete"
        | "turn_complete"
        | "turn_aborted"
        | "token_count"
        | "session_configured"
        | "thread_settings_applied"
        | "thread_goal_updated"
        | "error"
        | "warning"
        | "mcp_startup_update"
        | "mcp_startup_complete" => {}
        _ => builder.push_unknown(line, frame, "event_msg", created_at),
    }
}

/// A typed `item_completed` event: the finished form of one thread item, the
/// way Codex 0.15x persists it next to the raw response items.
fn project_codex_item(
    builder: &mut CodexProjectionBuilder<'_>,
    line: u64,
    frame: &[u8],
    item: &Map<String, Value>,
    created_at: Option<String>,
) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let id = item.get("id").and_then(Value::as_str);
    let status = item.get("status").and_then(Value::as_str);
    let status_failed = matches!(status, Some("failed" | "declined"));
    match codex_kind(item_type).as_str() {
        "usermessage" => {
            let (text, image_count) = codex_item_content(item.get("content"));
            let before = builder.blocks.len();
            match text {
                Some(text) => builder.push_text(
                    GenericBlockKind::User,
                    "codex_item_user_message",
                    created_at,
                    text,
                    CodexTextSource::Event,
                    id,
                ),
                None if image_count > 0 => builder.push_attachment_only_user(
                    "codex_item_user_message",
                    created_at,
                    CodexTextSource::Event,
                    id,
                ),
                None => {}
            }
            builder.mark_user_attachments(before, image_count);
        }
        "agentmessage" => {
            if let (Some(text), _) = codex_item_content(item.get("content")) {
                builder.push_text(
                    GenericBlockKind::Assistant,
                    "codex_item_agent_message",
                    created_at,
                    text,
                    CodexTextSource::Event,
                    id,
                );
            }
        }
        "reasoning" => {
            if let Some(text) = codex_string_list(item.get("summary_text").or(item.get("summary")))
            {
                builder.push_text(
                    GenericBlockKind::Thinking,
                    "codex_item_reasoning",
                    created_at,
                    text,
                    CodexTextSource::Event,
                    id,
                );
            }
        }
        "plan" => {
            if let Some(text) = item.get("text").and_then(Value::as_str)
                && !text.trim().is_empty()
            {
                builder.push_text(
                    GenericBlockKind::Thinking,
                    "codex_item_plan",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
                    id,
                );
            }
        }
        "commandexecution" => {
            let Some(id) = id else {
                builder.push_unknown(line, frame, "event_msg.item_completed", created_at);
                return;
            };
            let exit_code = item.get("exit_code").and_then(Value::as_i64);
            // A record without an exit code proves no failure.
            let failed = status_failed || exit_code.is_some_and(|code| code != 0);
            let mut lines = Vec::new();
            if let Some(command) = codex_command_text(item.get("command")) {
                lines.push(format!("Command: {command}"));
            }
            if let Some(output) = item
                .get("aggregated_output")
                .and_then(Value::as_str)
                .filter(|output| !output.is_empty())
            {
                lines.push(output.to_owned());
            }
            if let Some(code) = exit_code.filter(|code| *code != 0) {
                lines.push(format!("Exit code: {code}"));
            }
            let preview = (!lines.is_empty()).then(|| lines.join("\n"));
            builder.complete_tool(created_at, id, Some("Command"), preview, failed);
        }
        "filechange" => {
            let Some(id) = id else {
                builder.push_unknown(line, frame, "event_msg.item_completed", created_at);
                return;
            };
            let changes = codex_file_changes(item.get("changes"));
            let preview = (!changes.is_empty()).then(|| {
                changes
                    .iter()
                    .map(|(kind, path)| format!("{kind} {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            builder.complete_tool(created_at, id, Some("File change"), preview, status_failed);
            if let Some(block_id) = builder.tool_block_id(id) {
                for (kind, path) in &changes {
                    if kind != "delete" {
                        builder.note_path(&block_id, path, HistoryChatFileOrigin::Written);
                    }
                }
            }
        }
        "imageview" => {
            let Some(id) = id else {
                builder.push_unknown(line, frame, "event_msg.item_completed", created_at);
                return;
            };
            let path = item.get("path").and_then(Value::as_str);
            builder.complete_tool(
                created_at,
                id,
                Some("Image view"),
                path.map(|path| format!("Path: {path}")),
                status_failed,
            );
            if let (Some(path), Some(block_id)) = (path, builder.tool_block_id(id)) {
                builder.note_path(&block_id, path, HistoryChatFileOrigin::Read);
            }
        }
        "imagegeneration" => {
            let Some(id) = id else {
                builder.push_unknown(line, frame, "event_msg.item_completed", created_at);
                return;
            };
            builder.complete_tool(
                created_at,
                id,
                Some("Image generation"),
                None,
                status_failed || item.get("failure").is_some_and(|value| !value.is_null()),
            );
            if let Some(block_id) = builder.tool_block_id(id) {
                let saved = ["saved_path", "savedPath"]
                    .iter()
                    .find_map(|key| item.get(*key).and_then(Value::as_str));
                if let Some(path) = saved {
                    builder.note_path(&block_id, path, HistoryChatFileOrigin::Generated);
                } else if let Some(result) = item.get("result").and_then(Value::as_str) {
                    builder.note_inline_image(&block_id, result, HistoryChatFileOrigin::Generated);
                }
            }
        }
        "mcptoolcall"
        | "dynamictoolcall"
        | "collabagenttoolcall"
        | "subagentactivity"
        | "websearch"
        | "extension" => {
            let Some(id) = id else {
                builder.push_unknown(line, frame, "event_msg.item_completed", created_at);
                return;
            };
            let name = match codex_kind(item_type).as_str() {
                "mcptoolcall" | "dynamictoolcall" => item.get("tool").and_then(Value::as_str),
                "websearch" => Some("Web search"),
                "extension" => item
                    .get("kind")
                    .and_then(Value::as_str)
                    .or(Some("Extension")),
                _ => Some("Agent"),
            };
            let result_failed = item
                .get("result")
                .and_then(Value::as_object)
                .is_some_and(|result| result.contains_key("error"))
                || item.get("success").and_then(Value::as_bool) == Some(false);
            builder.complete_tool(created_at, id, name, None, status_failed || result_failed);
        }
        "contextcompaction" => builder.push_compaction(created_at, None, id),
        // Review-mode markers and sleeps are lifecycle, not conversation.
        "sleep" | "enteredreviewmode" | "exitedreviewmode" => {}
        _ => builder.push_unknown(line, frame, "event_msg.item_completed", created_at),
    }
}

/// The text and the image or attachment count of a typed item's `content`
/// (`[{"type":"text","text":..},{"type":"local_image",..}]`).
fn codex_item_content(content: Option<&Value>) -> (Option<String>, usize) {
    let Some(items) = content.and_then(Value::as_array) else {
        return (None, 0);
    };
    let mut texts = Vec::new();
    let mut images = 0_usize;
    for item in items.iter().filter_map(Value::as_object) {
        match codex_kind(item.get("type").and_then(Value::as_str).unwrap_or("")).as_str() {
            "text" | "inputtext" | "outputtext" => {
                if let Some(text) = item.get("text").and_then(Value::as_str)
                    && !is_codex_image_wrapper(text)
                {
                    texts.push(text);
                }
            }
            "image" | "localimage" | "inputimage" => images += 1,
            _ => {}
        }
    }
    let text = texts.join("\n");
    ((!text.trim().is_empty()).then_some(text), images)
}

/// An `<image ...>` or `</image>` text part Codex puts around an image.
fn is_codex_image_wrapper(text: &str) -> bool {
    let text = text.trim();
    text.len() <= 200
        && (text == "</image>"
            || (text.starts_with("<image") && text.ends_with('>') && !text.contains('\n')))
}

/// A list of strings (or `{text}` objects) joined by newlines.
fn codex_string_list(value: Option<&Value>) -> Option<String> {
    let text = value
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| item.get("text").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// The command a command item ran: an argv list or a single string.
fn codex_command_text(command: Option<&Value>) -> Option<String> {
    let text = match command? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// The `(kind, path)` pairs of a file-change item: `changes` is an object
/// keyed by path (`{path: {"type": "update"|"add"|"delete", ..}}`) in rollouts
/// and an array of `{path, kind: {"type": ..}}` over the app-server protocol.
fn codex_file_changes(changes: Option<&Value>) -> Vec<(String, String)> {
    let kind_of = |value: &Value| {
        value
            .get("type")
            .or_else(|| value.get("kind").and_then(|kind| kind.get("type")))
            .or_else(|| value.get("kind"))
            .and_then(Value::as_str)
            .map_or_else(|| "update".to_owned(), str::to_ascii_lowercase)
    };
    let mut result = Vec::new();
    match changes {
        Some(Value::Object(map)) => {
            for (path, change) in map.iter().take(64) {
                result.push((kind_of(change), path.clone()));
            }
        }
        Some(Value::Array(list)) => {
            for change in list.iter().take(64) {
                if let Some(path) = change.get("path").and_then(Value::as_str) {
                    result.push((kind_of(change), path.to_owned()));
                }
            }
        }
        _ => {}
    }
    result
}

/// The text of a response message and how many images or audio clips it
/// carried. The `<image ...>` wrapper parts Codex adds around an image are not
/// text the person wrote.
fn codex_message_content(content: Option<&Value>) -> (Option<String>, usize) {
    let Some(items) = content.and_then(Value::as_array) else {
        return (None, 0);
    };
    let mut texts = Vec::new();
    let mut images = 0_usize;
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str)
                    && !is_codex_image_wrapper(text)
                {
                    texts.push(text);
                }
            }
            Some("input_image" | "input_audio") => images += 1,
            _ => {}
        }
    }
    let text = texts.join("\n");
    ((!text.is_empty()).then_some(text), images)
}

fn codex_reasoning_summary(summary: Option<&Value>) -> Option<String> {
    let text = summary
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_object)
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("summary_text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn codex_tool_output(output: Option<&Value>) -> Option<String> {
    match output? {
        Value::String(text) => Some(text.clone()),
        Value::Array(_) | Value::Object(_) => display_content(output),
        _ => None,
    }
}

fn first_timestamp(bytes: &[u8]) -> Option<String> {
    let (frames, _) = lf_frames(bytes);
    frames.into_iter().find_map(|(_, frame)| {
        let value = serde_json::from_slice::<Value>(frame).ok()?;
        string_field(value.as_object()?, &["timestamp"])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn new() -> Self {
            let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "piui-index-workspace-history-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test directory can be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn write_fixture(&self, name: &str, fixture: &str) -> PathBuf {
            let cwd = serde_json::to_string(self.path.to_string_lossy().as_ref())
                .expect("cwd serializes");
            let body = fixture.replace("__PIUI_CWD__", &cwd[1..cwd.len() - 1]);
            let path = self.path.join(name);
            fs::write(&path, body).expect("fixture writes");
            path
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn project(directory: &TemporaryDirectory) -> ProjectDirectory {
        ProjectDirectory::resolve(directory.path()).expect("project resolves")
    }

    fn fixture(name: &str) -> &'static str {
        match name {
            "pi-prime" => include_str!("../tests/fixtures/workspace-history/pi-prime.jsonl"),
            "codex" => {
                include_str!("../tests/fixtures/workspace-history/codex-0.147-rollout.jsonl")
            }
            "claude" => include_str!("../tests/fixtures/workspace-history/claude-code-2.1.jsonl"),
            _ => panic!("unknown fixture"),
        }
    }

    const CLAUDE_SESSION: &str = "7b0c2a4e-1f3d-4c5b-9a8e-2d6f0e1c3b5a";

    fn claude_source(path: PathBuf, id: &str) -> HostNativeHistorySource {
        HostNativeHistorySource::new(path, id.into(), WorkspaceHistoryFormat::ClaudeCode)
    }

    fn claude_line(directory: &TemporaryDirectory, value: serde_json::Value) -> String {
        let mut value = value;
        if let Some(object) = value.as_object_mut() {
            object
                .entry("sessionId")
                .or_insert_with(|| serde_json::json!(CLAUDE_SESSION));
            object
                .entry("cwd")
                .or_insert_with(|| serde_json::json!(directory.path().to_string_lossy()));
        }
        value.to_string()
    }

    #[test]
    fn projects_the_active_claude_code_branch_read_only() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture(&format!("{CLAUDE_SESSION}.jsonl"), fixture("claude"));
        let before = fs::read(&path).expect("fixture bytes");
        let projection = project_native_workspace_history(
            &claude_source(path.clone(), CLAUDE_SESSION),
            &project(&directory),
        )
        .expect("Claude Code history projects");
        assert_eq!(
            fs::read(&path).expect("fixture bytes"),
            before,
            "never written"
        );
        let blocks = projection.timeline_blocks();
        let summary = blocks
            .iter()
            .map(|block| {
                (
                    block.kind,
                    block.status,
                    block.preview.clone().unwrap_or_default(),
                    block.title.clone().unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();
        use GenericBlockKind as K;
        use GenericBlockStatus as S;
        let expected = [
            (K::User, S::Complete, "Fix the build", ""),
            (
                K::Thinking,
                S::Complete,
                "Check the logs first",
                "Reasoning",
            ),
            (
                K::Tool,
                S::Failed,
                "build failed at <workspace>/src/main.rs",
                "Bash",
            ),
            // A parallel call: its result hangs beside the active branch.
            (K::Tool, S::Complete, "src/main.rs", "Glob"),
            (K::Unknown, S::Complete, "", "Unrecognized session entry"),
            (K::Assistant, S::Complete, "Retrying.", ""),
            (K::User, S::Complete, "Try a different fix", ""),
            (K::Compaction, S::Complete, "", "Context compacted"),
            (K::User, S::Complete, "Continue please", ""),
            (K::Custom, S::Failed, CLAUDE_API_ERROR_NOTICE, "Error"),
            (
                K::Assistant,
                S::Complete,
                "Fixed at <workspace>/out.txt",
                "",
            ),
            (K::Tool, S::Interrupted, "", "Read"),
            (K::Unknown, S::Complete, "", "Unrecognized session entry"),
            (K::Unknown, S::Complete, "", "Unrecognized session entry"),
            (K::Assistant, S::Complete, "Done.", ""),
        ];
        assert_eq!(
            summary,
            expected
                .iter()
                .map(|(kind, status, preview, title)| {
                    (*kind, *status, (*preview).to_owned(), (*title).to_owned())
                })
                .collect::<Vec<_>>()
        );
        let visible = format!("{:?}", blocks);
        for hidden in [
            "SECRET",
            "An abandoned branch",
            "Abandoned answer",
            "Request interrupted",
            "command-name",
            "torn",
        ] {
            assert!(!visible.contains(hidden), "{hidden} must stay hidden");
        }
        assert!(blocks.iter().filter(|block| block.fallback).count() == 3);
        let unknown = projection
            .report
            .unknown_entries
            .iter()
            .map(|entry| entry.entry_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            unknown,
            [
                "unreadable",
                "future-chain-entry",
                "future-chain-entry",
                "content:server_tool_use"
            ]
        );
        assert_eq!(projection.report.parse_state, ParseState::Unsupported);
        assert_eq!(projection.report.image_entry_count, 1);
        // The prompt that carried the image is marked; its bytes stay hidden.
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.has_image)
                .map(|block| block.preview.as_deref())
                .collect::<Vec<_>>(),
            [Some("Continue please")]
        );
        assert_eq!(projection.report.compaction_entry_count, 1);
        assert_eq!(projection.report.branch_count, 1);
        assert_eq!(
            projection.report.pi_session_id.as_deref(),
            Some(CLAUDE_SESSION)
        );

        // Exact, unredacted assistant text resolves dependency references.
        let exact = format!("Fixed at {}/out.txt", directory.path().display());
        assert_eq!(
            projection.final_assistant_text(None, Some(&sha256(exact.as_bytes()))),
            Some(exact.as_str())
        );
        assert_eq!(projection.final_assistant_text(None, None), Some("Done."));
        assert_eq!(
            projection.final_assistant_text(None, Some(&sha256(b"Abandoned answer"))),
            None,
            "abandoned branches never resolve"
        );
    }

    #[test]
    fn claude_code_history_rejects_foreign_names_sessions_and_projects() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture(&format!("{CLAUDE_SESSION}.jsonl"), fixture("claude"));
        let other_id = "11111111-2222-4333-8444-555555555555";
        assert!(matches!(
            project_native_workspace_history(
                &claude_source(path.clone(), other_id),
                &project(&directory)
            ),
            Err(WorkspaceHistoryError::NativeSessionMismatch)
        ));
        let renamed = directory.write_fixture(&format!("{other_id}.jsonl"), fixture("claude"));
        assert!(matches!(
            project_native_workspace_history(
                &claude_source(renamed, other_id),
                &project(&directory)
            ),
            Err(WorkspaceHistoryError::NativeSessionMismatch)
        ));
        let not_uuid = directory.write_fixture("not-a-uuid.jsonl", fixture("claude"));
        assert!(matches!(
            project_native_workspace_history(
                &claude_source(not_uuid, "not-a-uuid"),
                &project(&directory)
            ),
            Err(WorkspaceHistoryError::NativeSessionMismatch)
        ));
        let other = TemporaryDirectory::new();
        assert!(matches!(
            project_native_workspace_history(
                &claude_source(path.clone(), CLAUDE_SESSION),
                &project(&other)
            ),
            Err(WorkspaceHistoryError::HeaderProjectMismatch)
        ));

        let metadata_only = directory
            .path()
            .join("22222222-2222-4333-8444-555555555555.jsonl");
        fs::write(
            &metadata_only,
            "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"sessionId\":\"22222222-2222-4333-8444-555555555555\"}\n",
        )
        .expect("metadata fixture");
        assert!(matches!(
            project_native_workspace_history(
                &claude_source(metadata_only, "22222222-2222-4333-8444-555555555555"),
                &project(&directory)
            ),
            Err(WorkspaceHistoryError::NoTimelineRecords)
        ));
    }

    #[test]
    fn claude_code_history_keeps_a_torn_tail_readable_and_bounds_tool_output() {
        let directory = TemporaryDirectory::new();
        let path = directory.path().join(format!("{CLAUDE_SESSION}.jsonl"));
        let huge = format!("head {} tail", "x".repeat(40 * 1024));
        let lines = [
            claude_line(
                &directory,
                serde_json::json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"Read the log"}}),
            ),
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_log","name":"Read","input":{}}]}}),
            ),
            claude_line(
                &directory,
                serde_json::json!({"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_log","content":[{"type":"text","text":huge},{"type":"image","source":{"data":"SECRET"}}]}]}}),
            ),
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":[{"type":"text","text":"Summarized."}]}}),
            ),
        ];
        // A crash tore the final line: the conversation stays readable.
        let torn = "{\"type\":\"assistant\",\"uuid\":\"a3\"";
        fs::write(&path, format!("{}\n{torn}", lines.join("\n"))).expect("torn fixture");
        let projection = project_native_workspace_history(
            &claude_source(path.clone(), CLAUDE_SESSION),
            &project(&directory),
        )
        .expect("a torn tail is not fatal");
        let blocks = projection.timeline_blocks();
        let tool = blocks
            .iter()
            .find(|block| block.kind == GenericBlockKind::Tool)
            .expect("tool block");
        assert_eq!(tool.status, GenericBlockStatus::Complete);
        assert!(tool.truncated);
        let preview = tool.preview.as_deref().expect("bounded preview");
        assert!(preview.starts_with("head "));
        assert!(preview.len() <= super::super::DISPLAY_DETAIL_LIMIT);
        assert_eq!(
            blocks.last().map(|block| block.kind),
            Some(GenericBlockKind::Unknown),
            "the torn line is shown as unreadable"
        );
        assert_eq!(
            projection.final_assistant_text(None, None),
            Some("Summarized.")
        );
        assert_eq!(projection.report.partial_tail_bytes, torn.len());

        // A complete final entry without its LF is kept as an entry.
        fs::write(&path, lines.join("\n")).expect("unterminated fixture");
        let projection = project_native_workspace_history(
            &claude_source(path, CLAUDE_SESSION),
            &project(&directory),
        )
        .expect("an unterminated complete entry projects");
        assert_eq!(
            projection
                .timeline_blocks()
                .last()
                .and_then(|block| block.preview.as_deref()),
            Some("Summarized.")
        );
        assert!(projection.report.unknown_entries.is_empty());
    }

    #[test]
    fn claude_code_history_streams_large_side_entries_without_the_scanner_bound() {
        use std::io::Write;
        // The projection no longer reads through the scanner's 128 MiB bound;
        // its own safety cap is far above it. A fixture over 128 MiB on every
        // test run would be too heavy, so a few MiB stand in for it.
        assert!(
            ClaudeReadLimits::PRODUCTION.max_file_bytes
                > SessionDiscoveryLimits::default().max_file_bytes
        );
        let directory = TemporaryDirectory::new();
        let path = directory.path().join(format!("{CLAUDE_SESSION}.jsonl"));
        let bound = 3 * 1024 * 1024;
        let mut file = std::io::BufWriter::new(fs::File::create(&path).expect("transcript"));
        let mut write = |value: serde_json::Value| -> usize {
            let line = claude_line(&directory, value);
            writeln!(file, "{line}").expect("transcript line");
            line.len() + 1
        };
        write(
            serde_json::json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"Open the build log"}}),
        );
        write(
            serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Opened."}]}}),
        );
        // Large results beside the active chain make the file bigger than the
        // scanner bound without adding to what is projected.
        let filler = "y".repeat(1024 * 1024);
        let mut written = 0_usize;
        let mut index = 0_u32;
        while written <= bound {
            written += write(
                serde_json::json!({"type":"user","uuid":format!("side-{index}"),"parentUuid":"a1","isSidechain":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("toolu_side_{index}"),"content":filler}]}}),
            );
            index += 1;
        }
        write(
            serde_json::json!({"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"Thanks"}}),
        );
        write(
            serde_json::json!({"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}),
        );
        file.flush().expect("transcript flush");
        drop(file);
        let length = fs::metadata(&path).expect("transcript metadata").len();
        assert!(
            length > bound as u64,
            "the fixture holds several large side entries"
        );

        let projection = project_native_workspace_history(
            &claude_source(path.clone(), CLAUDE_SESSION),
            &project(&directory),
        )
        .expect("a transcript with large side entries projects");
        let previews = projection
            .timeline_blocks()
            .iter()
            .map(|block| block.preview.as_deref().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            previews,
            ["Open the build log", "Opened.", "Thanks", "Done."]
        );
        assert_eq!(projection.final_assistant_text(None, None), Some("Done."));
        assert_eq!(projection.report.complete_bytes as u64, length);
        assert_eq!(projection.report.partial_tail_bytes, 0);
        assert!(projection.report.unknown_entries.is_empty());
        fs::remove_file(&path).expect("large fixture is removed");
    }

    #[test]
    fn claude_code_history_refuses_a_transcript_over_the_safety_cap() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture(&format!("{CLAUDE_SESSION}.jsonl"), fixture("claude"));
        let limits = ClaudeReadLimits {
            max_file_bytes: 100,
            ..ClaudeReadLimits::PRODUCTION
        };
        assert!(matches!(
            project_claude_code_history_with_limits(
                &claude_source(path, CLAUDE_SESSION),
                &project(&directory),
                limits
            ),
            Err(WorkspaceHistoryError::File(
                BoundedScanError::FileTooLarge { limit: 100 }
            ))
        ));
    }

    #[test]
    fn claude_code_history_shows_an_overlong_line_as_unreadable() {
        let directory = TemporaryDirectory::new();
        let path = directory.path().join(format!("{CLAUDE_SESSION}.jsonl"));
        let overlong = claude_line(
            &directory,
            serde_json::json!({"type":"user","uuid":"big","parentUuid":"a1","isSidechain":true,"message":{"role":"user","content":"z".repeat(3000)}}),
        );
        let lines = [
            claude_line(
                &directory,
                serde_json::json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"First"}}),
            ),
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"First reply"}]}}),
            ),
            overlong.clone(),
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":"a2","parentUuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"Second reply"}]}}),
            ),
        ];
        assert!(
            lines[..2]
                .iter()
                .chain(&lines[3..])
                .all(|line| line.len() <= 1024)
        );
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("fixture");
        let limits = ClaudeReadLimits {
            max_line_bytes: 1024,
            ..ClaudeReadLimits::PRODUCTION
        };
        let projection = project_claude_code_history_with_limits(
            &claude_source(path, CLAUDE_SESSION),
            &project(&directory),
            limits,
        )
        .expect("an overlong line does not fail the projection");
        let kinds = projection
            .timeline_blocks()
            .iter()
            .map(|block| block.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                GenericBlockKind::User,
                GenericBlockKind::Assistant,
                GenericBlockKind::Unknown,
                GenericBlockKind::Assistant
            ]
        );
        assert_eq!(
            projection.final_assistant_text(None, None),
            Some("Second reply")
        );
        assert!(matches!(
            projection.report.parse_state,
            ParseState::Unsupported
        ));
        let [summary] = projection.report.unknown_entries.as_slice() else {
            panic!("exactly the overlong line is unreadable");
        };
        assert_eq!(summary.line, 3);
        assert_eq!(summary.entry_type, "unreadable");
        assert_eq!(summary.byte_length, overlong.len());
        assert_eq!(summary.sha256, sha256(overlong.as_bytes()));
    }

    #[test]
    fn claude_line_assembler_caps_a_line_without_buffering_it() {
        let mut assembler = ClaudeLineAssembler::new(4);
        assembler.push(b"ab");
        assembler.push(b"cd");
        assert!(matches!(assembler.line(), ClaudeRawLine::Frame(b"abcd")));
        assembler.reset();
        assert!(assembler.is_empty());
        assembler.push(b"ab");
        assembler.push(b"cde");
        assembler.push(b"fg");
        assert!(
            assembler.buffer.is_empty(),
            "nothing is buffered once over the cap"
        );
        let ClaudeRawLine::Oversized {
            byte_length,
            sha256: digest,
        } = assembler.line()
        else {
            panic!("a seven byte line is over a four byte cap");
        };
        assert_eq!(byte_length, 7);
        assert_eq!(digest, sha256(b"abcdefg"));
        assembler.reset();
        assert!(assembler.is_empty());
    }

    #[test]
    fn claude_transcript_stream_is_independent_of_the_chunk_size() {
        let directory = TemporaryDirectory::new();
        let complete = [
            claude_line(
                &directory,
                serde_json::json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"Hi"}}),
            ),
            "not json".to_owned(),
            String::new(),
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}),
            ),
        ];
        let torn = "{\"type\":\"assistant\",\"uuid\":\"a2\"";
        let bytes = format!("{}\n{torn}", complete.join("\n")).into_bytes();
        let complete_bytes = bytes.len() - torn.len();
        for chunk in [1, 3, 7, 4096] {
            let transcript = stream_claude_transcript(
                BufReader::with_capacity(chunk, bytes.as_slice()),
                CLAUDE_SESSION,
                CLAUDE_MAX_LINE_BYTES,
            )
            .expect("transcript streams");
            assert_eq!(transcript.entries.len(), 2, "chunk {chunk}");
            assert_eq!(transcript.entries[1].line, 4, "chunk {chunk}");
            let lines = transcript
                .unreadable
                .iter()
                .map(|summary| summary.line)
                .collect::<Vec<_>>();
            assert_eq!(lines, [2, 5], "the malformed line and the torn tail");
            assert_eq!(transcript.unreadable[1].byte_length, torn.len());
            assert_eq!(transcript.total_bytes, bytes.len());
            assert_eq!(transcript.complete_bytes, complete_bytes);
            assert_eq!(transcript.revision, sha256(&bytes), "chunk {chunk}");
        }
    }

    #[test]
    fn claude_code_history_starts_a_long_chain_later_behind_one_notice() {
        let directory = TemporaryDirectory::new();
        let path = directory.path().join(format!("{CLAUDE_SESSION}.jsonl"));
        let user = |id: &str, parent: Option<&str>, second: u32, text: &str| {
            claude_line(
                &directory,
                serde_json::json!({"type":"user","uuid":id,"parentUuid":parent,"timestamp":format!("2026-01-01T00:00:0{second}Z"),"message":{"role":"user","content":text}}),
            )
        };
        let assistant = |id: &str, parent: &str, second: u32, text: &str| {
            claude_line(
                &directory,
                serde_json::json!({"type":"assistant","uuid":id,"parentUuid":parent,"timestamp":format!("2026-01-01T00:00:0{second}Z"),"message":{"role":"assistant","content":[{"type":"text","text":text}]}}),
            )
        };
        let lines = [
            user("u1", None, 1, "First prompt"),
            assistant("a1", "u1", 2, "Reply one"),
            claude_line(
                &directory,
                serde_json::json!({"type":"system","subtype":"compact_boundary","uuid":"c1","parentUuid":"a1"}),
            ),
            user("u2", Some("c1"), 3, "Second prompt"),
            assistant("a2", "u2", 4, "Reply two"),
            user("u3", Some("a2"), 5, "Third prompt"),
            assistant("a3", "u3", 6, "Reply three"),
        ];
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("fixture");
        let source = claude_source(path, CLAUDE_SESSION);

        let whole = project_claude_code_history_with_limits(
            &source,
            &project(&directory),
            ClaudeReadLimits::PRODUCTION,
        )
        .expect("the whole chain projects");
        assert!(
            whole
                .timeline_blocks()
                .iter()
                .all(|block| block.source_type != "claude_history_trimmed")
        );
        assert_eq!(whole.report.compaction_entry_count, 1);

        // Room for the newest two entries (12 + 11 bytes) but not the third.
        let limits = ClaudeReadLimits {
            chain_text_budget: 25,
            ..ClaudeReadLimits::PRODUCTION
        };
        let trimmed =
            project_claude_code_history_with_limits(&source, &project(&directory), limits)
                .expect("the newest part of the chain projects");
        let blocks = trimmed.timeline_blocks();
        let previews = blocks
            .iter()
            .map(|block| block.preview.as_deref().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            previews,
            [CLAUDE_HISTORY_TRIMMED_NOTICE, "Third prompt", "Reply three"]
        );
        assert_eq!(blocks[0].kind, GenericBlockKind::Custom);
        assert_eq!(blocks[0].source_type, "claude_history_trimmed");
        assert_eq!(
            trimmed.final_assistant_text(None, None),
            Some("Reply three")
        );
        // The report still describes the whole conversation.
        let report = &trimmed.report;
        assert_eq!(report.first_user_preview.as_deref(), Some("First prompt"));
        assert_eq!(report.created_at.as_deref(), Some("2026-01-01T00:00:01Z"));
        assert_eq!(report.updated_at.as_deref(), Some("2026-01-01T00:00:06Z"));
        assert_eq!(report.compaction_entry_count, 1);
        assert_eq!(report.file_revision, whole.report.file_revision);
    }

    #[test]
    fn projects_pi_prime_through_existing_generic_redacted_renderer() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture("prime.jsonl", fixture("pi-prime"));
        let source = HostNativeHistorySource::new(
            path,
            "prime-native-session".into(),
            WorkspaceHistoryFormat::PrimeAgent,
        );
        let source_debug = format!("{source:?}");
        assert!(!source_debug.contains("prime-native-session"));
        assert!(!source_debug.contains(directory.path.to_string_lossy().as_ref()));
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("native history projects");

        assert_eq!(
            projection.report.pi_session_id.as_deref(),
            Some("prime-native-session")
        );
        assert!(
            projection
                .timeline_blocks()
                .iter()
                .any(|block| block.kind == GenericBlockKind::User)
        );
        let assistant = projection
            .timeline_blocks()
            .iter()
            .find(|block| block.kind == GenericBlockKind::Assistant)
            .expect("assistant block");
        assert!(
            assistant
                .preview
                .as_deref()
                .is_some_and(|text| text.contains("<workspace>"))
        );
        let exact = format!(
            "Final Pi result at {}/result.txt",
            directory.path().display()
        );
        assert_eq!(
            projection.final_assistant_text(Some(&assistant.id), None),
            Some(exact.as_str())
        );
        let hash = sha256(exact.as_bytes()).to_uppercase();
        assert_eq!(
            projection.final_assistant_text(Some("live-runtime-id"), Some(&hash)),
            Some(exact.as_str())
        );
        assert!(
            projection
                .timeline_blocks()
                .iter()
                .any(|block| block.kind == GenericBlockKind::Unknown && block.fallback)
        );
    }

    #[test]
    fn projects_codex_rollout_without_duplicate_text_or_native_prompts() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture("rollout.jsonl", fixture("codex"));
        let source = HostNativeHistorySource::new(
            path,
            "codex-native-thread".into(),
            WorkspaceHistoryFormat::Codex,
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("Codex history projects");
        let blocks = projection.timeline_blocks();

        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.kind == GenericBlockKind::User)
                .count(),
            1
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.kind == GenericBlockKind::Assistant)
                .count(),
            1
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.kind == GenericBlockKind::Thinking)
                .count(),
            1
        );
        assert!(
            blocks
                .iter()
                .all(|block| block.preview.as_deref() != Some("SYSTEM SECRET"))
        );
        assert!(
            blocks
                .iter()
                .all(|block| block.preview.as_deref() != Some("DEVELOPER SECRET"))
        );
        let tool = blocks
            .iter()
            .find(|block| block.kind == GenericBlockKind::Tool)
            .expect("tool block");
        assert_eq!(tool.status, GenericBlockStatus::Complete);
        assert!(
            tool.preview
                .as_deref()
                .is_some_and(|text| text.contains("<workspace>"))
        );
        assert!(
            blocks
                .iter()
                .any(|block| block.kind == GenericBlockKind::Unknown && block.fallback)
        );

        let exact = format!(
            "Final Codex result at {}/out.txt",
            directory.path().display()
        );
        let hash = sha256(exact.as_bytes());
        assert_eq!(
            projection.final_assistant_text(Some("app-server-item-id"), Some(&hash)),
            Some(exact.as_str())
        );
        assert_eq!(projection.report.parse_state, ParseState::Unsupported);
    }

    #[test]
    fn rejects_forged_id_wrong_project_traversal_missing_and_wrong_extension() {
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture("valid.jsonl", fixture("pi-prime"));
        let forged = HostNativeHistorySource::new(
            path.clone(),
            "forged-native-id".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&forged, &project(&directory)),
            Err(WorkspaceHistoryError::NativeSessionMismatch)
        ));

        let other = TemporaryDirectory::new();
        let valid = HostNativeHistorySource::new(
            path.clone(),
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&valid, &project(&other)),
            Err(WorkspaceHistoryError::HeaderProjectMismatch)
        ));

        let traversal = HostNativeHistorySource::new(
            directory.path.join("child").join("..").join("valid.jsonl"),
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&traversal, &project(&directory)),
            Err(WorkspaceHistoryError::InvalidSourcePath)
        ));

        let missing = HostNativeHistorySource::new(
            directory.path.join("missing.jsonl"),
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&missing, &project(&directory)),
            Err(WorkspaceHistoryError::File(BoundedScanError::Read(_)))
        ));

        let wrong_extension = HostNativeHistorySource::new(
            directory.path.join("auth.json"),
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&wrong_extension, &project(&directory)),
            Err(WorkspaceHistoryError::InvalidSourceFile)
        ));

        let protected = directory.path.join("auth.jsonl");
        fs::write(&protected, fixture("pi-prime")).unwrap();
        let protected = HostNativeHistorySource::new(
            protected,
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&protected, &project(&directory)),
            Err(WorkspaceHistoryError::InvalidSourceFile)
        ));
    }

    #[test]
    fn unknown_codex_records_get_a_generic_fallback_instead_of_false_empty_success() {
        let directory = TemporaryDirectory::new();
        let cwd = serde_json::to_string(directory.path.to_string_lossy().as_ref()).unwrap();
        let path = directory.path.join("unknown.jsonl");
        fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"now\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"id\",\"cwd\":{cwd}}}}}\n{{\"type\":\"future_rollout_record\",\"payload\":{{\"prompt\":\"must stay hidden\"}}}}\n"
            ),
        )
        .unwrap();
        let source = HostNativeHistorySource::new(path, "id".into(), WorkspaceHistoryFormat::Codex);
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("unknown record has safe fallback");
        assert_eq!(projection.timeline_blocks().len(), 1);
        assert!(projection.timeline_blocks()[0].fallback);
        assert_eq!(projection.timeline_blocks()[0].preview, None);
        assert_eq!(projection.report.parse_state, ParseState::Unsupported);
    }

    #[test]
    fn a_codex_command_without_an_exit_code_is_not_a_failure() {
        let directory = TemporaryDirectory::new();
        let cwd = serde_json::to_string(directory.path.to_string_lossy().as_ref()).unwrap();
        let path = directory.path.join("exit-codes.jsonl");
        let event = |kind: &str, call: &str, extra: &str| {
            format!(
                "{{\"timestamp\":\"now\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"{kind}\",\"call_id\":\"{call}\"{extra}}}}}\n"
            )
        };
        let mut rollout = format!(
            "{{\"timestamp\":\"now\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"id\",\"cwd\":{cwd}}}}}\n"
        );
        rollout.push_str(&event("exec_command_begin", "missing", ""));
        rollout.push_str(&event("exec_command_end", "missing", ""));
        rollout.push_str(&event("exec_command_begin", "zero", ""));
        rollout.push_str(&event("exec_command_end", "zero", ",\"exit_code\":0"));
        rollout.push_str(&event("exec_command_begin", "two", ""));
        rollout.push_str(&event("exec_command_end", "two", ",\"exit_code\":2"));
        fs::write(&path, rollout).unwrap();
        let source = HostNativeHistorySource::new(path, "id".into(), WorkspaceHistoryFormat::Codex);
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("Codex command history projects");
        let statuses = projection
            .timeline_blocks()
            .iter()
            .filter(|block| block.kind == GenericBlockKind::Tool)
            .map(|block| block.status)
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            [
                GenericBlockStatus::Complete,
                GenericBlockStatus::Complete,
                GenericBlockStatus::Failed
            ]
        );
    }

    #[test]
    fn malformed_and_partial_histories_fail_instead_of_returning_empty() {
        let directory = TemporaryDirectory::new();
        let cwd = serde_json::to_string(directory.path.to_string_lossy().as_ref()).unwrap();
        let malformed_path = directory.path.join("malformed.jsonl");
        fs::write(
            &malformed_path,
            format!("{{\"type\":\"session\",\"id\":\"id\",\"cwd\":{cwd}}}\n{{broken}}\n"),
        )
        .unwrap();
        let malformed =
            HostNativeHistorySource::new(malformed_path, "id".into(), WorkspaceHistoryFormat::Pi);
        assert!(matches!(
            project_native_workspace_history(&malformed, &project(&directory)),
            Err(WorkspaceHistoryError::MalformedRecord { line: 2 })
        ));

        let codex_malformed_path = directory.path.join("codex-malformed.jsonl");
        fs::write(
            &codex_malformed_path,
            format!(
                "{{\"timestamp\":\"now\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"id\",\"cwd\":{cwd}}}}}\n{{broken}}\n"
            ),
        )
        .unwrap();
        let codex_malformed = HostNativeHistorySource::new(
            codex_malformed_path,
            "id".into(),
            WorkspaceHistoryFormat::Codex,
        );
        assert!(matches!(
            project_native_workspace_history(&codex_malformed, &project(&directory)),
            Err(WorkspaceHistoryError::MalformedRecord { line: 2 })
        ));

        let partial_path = directory.path.join("partial.jsonl");
        fs::write(
            &partial_path,
            format!(
                "{{\"type\":\"session\",\"id\":\"id\",\"cwd\":{cwd}}}\n{{\"type\":\"message\"}}"
            ),
        )
        .unwrap();
        let partial =
            HostNativeHistorySource::new(partial_path, "id".into(), WorkspaceHistoryFormat::Pi);
        assert!(matches!(
            project_native_workspace_history(&partial, &project(&directory)),
            Err(WorkspaceHistoryError::PartialTail)
        ));

        let empty_path = directory.path.join("empty.jsonl");
        fs::write(
            &empty_path,
            format!("{{\"type\":\"session\",\"id\":\"id\",\"cwd\":{cwd}}}\n"),
        )
        .unwrap();
        let empty =
            HostNativeHistorySource::new(empty_path, "id".into(), WorkspaceHistoryFormat::Pi);
        assert!(matches!(
            project_native_workspace_history(&empty, &project(&directory)),
            Err(WorkspaceHistoryError::NoTimelineRecords)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_sources() {
        use std::os::unix::fs::symlink;
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture("real.jsonl", fixture("pi-prime"));
        let link = directory.path.join("link.jsonl");
        symlink(path, &link).expect("symlink created");
        let source = HostNativeHistorySource::new(
            link,
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&source, &project(&directory)),
            Err(WorkspaceHistoryError::File(BoundedScanError::Symlink))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_symbolic_link_sources_when_platform_allows_test_creation() {
        use std::os::windows::fs::symlink_file;
        let directory = TemporaryDirectory::new();
        let path = directory.write_fixture("real.jsonl", fixture("pi-prime"));
        let link = directory.path.join("link.jsonl");
        if symlink_file(path, &link).is_err() {
            return;
        }
        let source = HostNativeHistorySource::new(
            link,
            "prime-native-session".into(),
            WorkspaceHistoryFormat::Pi,
        );
        assert!(matches!(
            project_native_workspace_history(&source, &project(&directory)),
            Err(WorkspaceHistoryError::File(BoundedScanError::Symlink))
        ));
    }

    // ---- Stable ids, typed Codex items, Claude markers and images, chat files ----

    fn at(record: serde_json::Value, kind: &str) -> serde_json::Value {
        serde_json::json!({"timestamp": "2026-11-18T10:00:01Z", "type": kind, "payload": record})
    }

    fn response(payload: serde_json::Value) -> serde_json::Value {
        at(payload, "response_item")
    }

    fn event(payload: serde_json::Value) -> serde_json::Value {
        at(payload, "event_msg")
    }

    fn item_completed(item: serde_json::Value) -> serde_json::Value {
        event(serde_json::json!({
            "type": "item_completed", "thread_id": "t", "turn_id": "x", "item": item
        }))
    }

    fn codex_source(
        directory: &TemporaryDirectory,
        records: &[serde_json::Value],
    ) -> HostNativeHistorySource {
        let header = serde_json::json!({
            "timestamp": "2026-11-18T10:00:00Z",
            "type": "session_meta",
            "payload": {"id": "codex-thread", "cwd": directory.path().to_string_lossy()}
        });
        let mut body = format!("{header}\n");
        for record in records {
            body.push_str(&format!("{record}\n"));
        }
        let path = directory.path().join("rollout.jsonl");
        fs::write(&path, body).expect("rollout writes");
        HostNativeHistorySource::new(path, "codex-thread".into(), WorkspaceHistoryFormat::Codex)
    }

    fn pi_source(
        directory: &TemporaryDirectory,
        records: &[serde_json::Value],
    ) -> HostNativeHistorySource {
        let header = serde_json::json!({
            "type": "session", "version": 3, "id": "pi-native",
            "cwd": directory.path().to_string_lossy(),
            "createdAt": "2026-11-18T10:00:00Z"
        });
        let mut body = format!("{header}\n");
        for record in records {
            body.push_str(&format!("{record}\n"));
        }
        let path = directory.path().join("pi.jsonl");
        fs::write(&path, body).expect("pi session writes");
        HostNativeHistorySource::new(path, "pi-native".into(), WorkspaceHistoryFormat::Pi)
    }

    /// Writes a Claude Code chain: every entry hangs off the one before it.
    fn claude_chain(
        directory: &TemporaryDirectory,
        entries: &[serde_json::Value],
    ) -> HostNativeHistorySource {
        let mut body = String::new();
        let mut parent: Option<String> = None;
        for entry in entries {
            let mut entry = entry.clone();
            if let Some(object) = entry.as_object_mut() {
                object.insert("parentUuid".into(), serde_json::json!(parent));
                parent = object
                    .get("uuid")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            body.push_str(&claude_line(directory, entry));
            body.push('\n');
        }
        let path = directory.path().join(format!("{CLAUDE_SESSION}.jsonl"));
        fs::write(&path, body).expect("claude transcript writes");
        claude_source(path, CLAUDE_SESSION)
    }

    fn claude_user(uuid: &str, content: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "type": "user", "uuid": uuid, "message": {"role": "user", "content": content}
        })
    }

    fn claude_assistant(
        uuid: &str,
        message_id: Option<&str>,
        content: serde_json::Value,
    ) -> serde_json::Value {
        let mut message = serde_json::json!({"role": "assistant", "content": content});
        if let Some(id) = message_id {
            message["id"] = serde_json::json!(id);
        }
        serde_json::json!({"type": "assistant", "uuid": uuid, "message": message})
    }

    fn claude_tool_result(uuid: &str, tool_use_id: &str, failed: bool) -> serde_json::Value {
        claude_user(
            uuid,
            serde_json::json!([
                {"type": "tool_result", "tool_use_id": tool_use_id, "content": "ok", "is_error": failed}
            ]),
        )
    }

    fn ids(projection: &WorkspaceHistoryProjection) -> Vec<&str> {
        projection
            .timeline_blocks()
            .iter()
            .map(|block| block.id.as_str())
            .collect()
    }

    #[test]
    fn modern_codex_items_fold_into_one_turn_and_accounting_is_dropped() {
        let directory = TemporaryDirectory::new();
        let source = codex_source(
            &directory,
            &[
                // Codex's own context is not what the person typed.
                response(
                    serde_json::json!({"type":"message","role":"user","content":[
                    {"type":"input_text","text":"# AGENTS.md instructions for /project\n\nbody"}]}),
                ),
                response(
                    serde_json::json!({"type":"message","role":"user","content":[
                    {"type":"input_text","text":"<environment_context>\n<cwd>/project</cwd>\n</environment_context>"}]}),
                ),
                response(
                    serde_json::json!({"type":"message","role":"user","content":[
                    {"type":"input_text","text":"Add the feature"}]}),
                ),
                item_completed(
                    serde_json::json!({"type":"UserMessage","id":"user-item-1","content":[
                    {"type":"text","text":"Add the feature"}]}),
                ),
                response(serde_json::json!({"type":"reasoning","id":"rs_1","summary":[]})),
                item_completed(serde_json::json!({"type":"Reasoning","id":"rs_1",
                    "summary_text":["Plan the change"],"raw_content":[]})),
                serde_json::json!({"timestamp":"2026-11-18T10:00:02Z","type":"token_usage_record",
                    "payload":{"thread_id":"t","usage":{"input_tokens":1,"total_tokens":2}}}),
                response(
                    serde_json::json!({"type":"function_call","id":"fc_1","name":"js",
                    "call_id":"call_mcp","arguments":"{}"}),
                ),
                item_completed(serde_json::json!({"type":"McpToolCall","id":"call_mcp",
                    "server":"s","tool":"search","status":"failed"})),
                response(
                    serde_json::json!({"type":"function_call_output","call_id":"call_mcp",
                    "output":"nothing found"}),
                ),
                item_completed(
                    serde_json::json!({"type":"CommandExecution","id":"call-run-1",
                    "command":["cargo test"],"cwd":"/project","status":"completed",
                    "aggregated_output":"1 failed","exit_code":101}),
                ),
                item_completed(
                    serde_json::json!({"type":"CommandExecution","id":"call-run-2",
                    "command":["cargo fmt"],"status":"completed","aggregated_output":"ok","exit_code":0}),
                ),
                item_completed(
                    serde_json::json!({"type":"CommandExecution","id":"call-run-3",
                    "command":["rm -rf x"],"status":"failed"}),
                ),
                item_completed(
                    serde_json::json!({"type":"AgentMessage","id":"msg_1","phase":"final_answer",
                    "content":[{"type":"Text","text":"All done."}]}),
                ),
                response(
                    serde_json::json!({"type":"message","role":"assistant","id":"msg_1",
                    "content":[{"type":"output_text","text":"All done."}]}),
                ),
                response(
                    serde_json::json!({"type":"agent_message","id":"am_1","author":"/root",
                    "recipient":"/root/w","content":[]}),
                ),
                response(
                    serde_json::json!({"type":"configuration_update","reasoning":{"effort":"high"}}),
                ),
                event(serde_json::json!({"type":"thread_goal_updated","threadId":"t"})),
                event(
                    serde_json::json!({"type":"turn_aborted","turn_id":"x","reason":"interrupted"}),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("modern Codex history projects");
        let blocks = projection.timeline_blocks();

        use GenericBlockKind as K;
        use GenericBlockStatus as S;
        assert_eq!(
            blocks
                .iter()
                .map(|block| (block.id.as_str(), block.kind, block.status))
                .collect::<Vec<_>>(),
            [
                ("user-item-1", K::User, S::Complete),
                ("rs_1", K::Thinking, S::Complete),
                // The failure the typed item recorded survives the later output.
                ("call_mcp", K::Tool, S::Failed),
                ("call-run-1", K::Tool, S::Failed),
                ("call-run-2", K::Tool, S::Complete),
                ("call-run-3", K::Tool, S::Failed),
                ("msg_1", K::Assistant, S::Complete),
            ]
        );
        assert_eq!(blocks[0].preview.as_deref(), Some("Add the feature"));
        assert_eq!(blocks[2].preview.as_deref(), Some("nothing found"));
        let failed = blocks[3].preview.as_deref().expect("command preview");
        assert!(failed.contains("cargo test") && failed.contains("1 failed"));
        assert!(failed.contains("Exit code: 101"));
        assert_eq!(projection.report.parse_state, ParseState::Healthy);
        assert!(projection.report.unknown_entries.is_empty());
        assert!(blocks.iter().all(|block| !block.fallback));
        let visible = format!("{blocks:?}");
        assert!(!visible.contains("AGENTS.md") && !visible.contains("environment_context"));
        assert!(!visible.contains("input_tokens"));

        // The answer resolves by its native id and by the id it had before.
        assert_eq!(
            projection.final_assistant_text(Some("msg_1"), None),
            Some("All done.")
        );
        assert_eq!(
            projection.final_assistant_text(Some("timeline-6"), None),
            Some("All done.")
        );
        assert_eq!(
            projection.final_assistant_text(Some("timeline-0"), None),
            None
        );
    }

    #[test]
    fn a_codex_record_without_a_native_id_keeps_its_position_id() {
        let directory = TemporaryDirectory::new();
        let source = codex_source(
            &directory,
            &[
                event(
                    serde_json::json!({"type":"user_message","message":"Hello","images":[],"local_images":[]}),
                ),
                event(serde_json::json!({"type":"agent_message","message":"Hi there"})),
                // A repeated native id never makes two blocks share an id.
                item_completed(
                    serde_json::json!({"type":"CommandExecution","id":"dup","status":"completed"}),
                ),
                item_completed(
                    serde_json::json!({"type":"CommandExecution","id":"dup","status":"completed"}),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        assert_eq!(ids(&projection), ["timeline-0", "timeline-1", "dup"]);
    }

    #[test]
    fn a_codex_prompt_of_only_images_still_opens_its_turn() {
        let directory = TemporaryDirectory::new();
        let source = codex_source(
            &directory,
            &[
                response(
                    serde_json::json!({"type":"message","role":"user","content":[
                    {"type":"input_text","text":"<image name=[Image #1]>"},
                    {"type":"input_image","image_url":"data:image/png;base64,AAAA"},
                    {"type":"input_text","text":"</image>"}]}),
                ),
                item_completed(
                    serde_json::json!({"type":"UserMessage","id":"u-img","content":[
                    {"type":"local_image","path":"/tmp/x.png"}]}),
                ),
                item_completed(serde_json::json!({"type":"AgentMessage","id":"msg_a",
                    "content":[{"type":"Text","text":"I see it."}]})),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let blocks = projection.timeline_blocks();
        assert_eq!(ids(&projection), ["u-img", "msg_a"]);
        assert_eq!(blocks[0].kind, GenericBlockKind::User);
        assert_eq!(blocks[0].preview, None);
        assert!(blocks[0].has_image);
        assert_eq!(blocks[0].attachment_count, 1);
        assert_eq!(projection.report.image_entry_count, 1);
    }

    #[test]
    fn codex_history_lists_the_files_its_agent_wrote_viewed_and_generated() {
        let directory = TemporaryDirectory::new();
        let dir = directory.path().to_string_lossy().into_owned();
        let source = codex_source(
            &directory,
            &[
                item_completed(
                    serde_json::json!({"type":"FileChange","id":"call-fc-1","status":"completed",
                    "changes":{
                        format!("{dir}/src/new.rs"): {"type":"add","content":"x"},
                        format!("{dir}/src/old.rs"): {"type":"update","unified_diff":"@@","move_path":null},
                        format!("{dir}/gone.rs"): {"type":"delete","content":"y"}}}),
                ),
                item_completed(
                    serde_json::json!({"type":"FileChange","id":"call-fc-2","status":"failed",
                    "changes":{format!("{dir}/bad.rs"): {"type":"add","content":""}}}),
                ),
                item_completed(serde_json::json!({"type":"ImageView","id":"call-iv-1",
                    "path": format!("{dir}/shot.png")})),
                response(
                    serde_json::json!({"type":"image_generation_call","id":"ig_1",
                    "status":"completed","revised_prompt":"a cat","result":"iVBORw0KGgoAAAANSUhEUg=="}),
                ),
                response(
                    serde_json::json!({"type":"custom_tool_call","id":"ctc_1","status":"completed",
                    "call_id":"call_patch","name":"apply_patch",
                    "input":"*** Begin Patch\n*** Add File: docs/added.md\n+x\n*** Update File: src/main.rs\n@@\n-a\n+b\n*** Delete File: old.txt\n*** End Patch"}),
                ),
                response(
                    serde_json::json!({"type":"custom_tool_call_output","call_id":"call_patch","output":"Done"}),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let root = directory.path();
        let listed = projection
            .chat_files()
            .iter()
            .map(|file| {
                (
                    file.block_id.clone(),
                    file.path.clone(),
                    file.inline
                        .as_ref()
                        .map(|(media, bytes)| (media.clone(), bytes.len())),
                    file.origin,
                )
            })
            .collect::<Vec<_>>();
        let expected = vec![
            (
                "call-fc-1".to_owned(),
                Some(root.join("src/new.rs")),
                None,
                HistoryChatFileOrigin::Written,
            ),
            (
                "call-fc-1".to_owned(),
                Some(root.join("src/old.rs")),
                None,
                HistoryChatFileOrigin::Written,
            ),
            (
                "call-iv-1".to_owned(),
                Some(root.join("shot.png")),
                None,
                HistoryChatFileOrigin::Read,
            ),
            (
                "ig_1".to_owned(),
                None,
                Some(("image/png".to_owned(), 16)),
                HistoryChatFileOrigin::Generated,
            ),
            (
                "call_patch".to_owned(),
                Some(root.join("docs/added.md")),
                None,
                HistoryChatFileOrigin::Written,
            ),
            (
                "call_patch".to_owned(),
                Some(root.join("src/main.rs")),
                None,
                HistoryChatFileOrigin::Written,
            ),
        ];
        // A deleted file, a failed change and the patch's own delete are not listed.
        assert_eq!(listed.len(), expected.len());
        for item in &expected {
            assert!(listed.contains(item), "{item:?} is listed");
        }
        // Every file names a block of the projected timeline.
        let block_ids = ids(&projection);
        assert!(
            projection
                .chat_files()
                .iter()
                .all(|file| block_ids.contains(&file.block_id.as_str()))
        );
        // The debug form never shows a path or bytes.
        let debug = format!("{:?}", projection.chat_files());
        assert!(!debug.contains("new.rs") && !debug.contains(&dir));
        // The convenience function agrees.
        assert_eq!(
            history_chat_files(&source, &project(&directory))
                .expect("files list")
                .len(),
            6
        );
    }

    #[test]
    fn chat_files_are_capped_to_the_newest_and_inline_images_are_bounded() {
        let directory = TemporaryDirectory::new();
        let dir = directory.path().to_string_lossy().into_owned();
        let records = (0..250)
            .map(|index| {
                item_completed(
                    serde_json::json!({"type":"FileChange","id":format!("fc-{index}"),
                    "status":"completed",
                    "changes":{format!("{dir}/f{index}.txt"): {"type":"add","content":""}}}),
                )
            })
            .collect::<Vec<_>>();
        let source = codex_source(&directory, &records);
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let files = projection.chat_files();
        assert_eq!(files.len(), HISTORY_CHAT_FILE_LIMIT);
        assert_eq!(
            files.first().map(|file| file.block_id.as_str()),
            Some("fc-50")
        );
        assert_eq!(
            files.last().map(|file| file.block_id.as_str()),
            Some("fc-249")
        );

        // Decoding refuses what is over the bound, and what is not an image.
        assert_eq!(decode_base64("AAAA", 2), None);
        assert_eq!(decode_base64("AAAA", 3), Some(vec![0, 0, 0]));
        assert_eq!(decode_base64("QUJD\nREVG", 10), Some(b"ABCDEF".to_vec()));
        assert_eq!(decode_base64("not base64!", 10), None);
        assert!(decode_inline_image("QUJD").is_none());
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
        assert_eq!(
            decode_inline_image(data_url).map(|(media, bytes)| (media, bytes.len())),
            Some(("image/png".to_owned(), 16))
        );
    }

    #[test]
    fn claude_internal_text_is_only_the_native_markers() {
        for marker in CLAUDE_INTERNAL_TAGS {
            assert!(
                is_internal_claude_text(&format!("<{marker}>x</{marker}>")),
                "{marker}"
            );
            assert!(
                is_internal_claude_text(&format!("  <{marker} a=\"b\">x")),
                "{marker}"
            );
        }
        assert!(is_internal_claude_text("[Request interrupted by user]"));
        assert!(is_internal_claude_text(
            "[Request interrupted by user for tool use]"
        ));
        for prompt in [
            "<task>Fix the parser</task>",
            "<pasted_content>text</pasted_content>",
            "<div>html</div>",
            "<command-name-extra>x</command-name-extra>",
            "<system-reminders>x",
            "<task-notification",
            "<Task-Notification>x",
            "<",
            "<command-name",
            "[Request interrupted",
            "plain",
        ] {
            assert!(!is_internal_claude_text(prompt), "{prompt}");
        }
    }

    #[test]
    fn a_claude_prompt_that_starts_with_a_tag_stays_in_the_history() {
        let directory = TemporaryDirectory::new();
        let source = claude_chain(
            &directory,
            &[
                claude_user("u1", serde_json::json!("<task>Fix the parser</task>")),
                claude_assistant(
                    "a1",
                    Some("msg_1"),
                    serde_json::json!([{"type":"text","text":"On it."}]),
                ),
                claude_user(
                    "u2",
                    serde_json::json!("<command-name>/model</command-name>"),
                ),
                claude_user(
                    "u3",
                    serde_json::json!("<pasted_content>blob</pasted_content>"),
                ),
                claude_user(
                    "u4",
                    serde_json::json!("<system-reminder>hidden</system-reminder>"),
                ),
                claude_user(
                    "u5",
                    serde_json::json!("<task-notification>done</task-notification>"),
                ),
                claude_user(
                    "u6",
                    serde_json::json!("<local-command-stdout>out</local-command-stdout>"),
                ),
                claude_assistant(
                    "a2",
                    Some("msg_2"),
                    serde_json::json!([{"type":"text","text":"Fixed."}]),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let users = projection
            .timeline_blocks()
            .iter()
            .filter(|block| block.kind == GenericBlockKind::User)
            .map(|block| block.preview.as_deref().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            users,
            [
                "<task>Fix the parser</task>",
                "<pasted_content>blob</pasted_content>"
            ]
        );
    }

    #[test]
    fn a_claude_prompt_of_only_images_keeps_its_turn_and_its_attachment_count() {
        let directory = TemporaryDirectory::new();
        let image = serde_json::json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"SECRET"}});
        let source = claude_chain(
            &directory,
            &[
                claude_user("u1", serde_json::json!("First")),
                claude_assistant(
                    "a1",
                    Some("msg_1"),
                    serde_json::json!([{"type":"text","text":"One."}]),
                ),
                claude_user("u2", serde_json::json!([image.clone(), image])),
                claude_assistant(
                    "a2",
                    Some("msg_2"),
                    serde_json::json!([{"type":"text","text":"Two."}]),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let blocks = projection.timeline_blocks();
        assert_eq!(
            blocks.iter().map(|block| block.kind).collect::<Vec<_>>(),
            [
                GenericBlockKind::User,
                GenericBlockKind::Assistant,
                GenericBlockKind::User,
                GenericBlockKind::Assistant
            ]
        );
        assert_eq!(blocks[2].preview, None);
        assert!(blocks[2].has_image);
        assert_eq!(blocks[2].attachment_count, 2);
        assert_eq!(blocks[0].attachment_count, 0);
        assert_eq!(projection.report.image_entry_count, 1);
        assert!(!format!("{blocks:?}").contains("SECRET"));
    }

    #[test]
    fn claude_blocks_take_the_ids_the_bridge_gives_them_live() {
        let directory = TemporaryDirectory::new();
        let dir = directory.path().to_string_lossy().into_owned();
        let source = claude_chain(
            &directory,
            &[
                claude_user("u1", serde_json::json!("Write it")),
                claude_assistant(
                    "a1",
                    Some("msg_1"),
                    serde_json::json!([{"type":"thinking","thinking":"Plan"}]),
                ),
                // An empty part still takes a rank: "Hello" is the second text.
                claude_assistant(
                    "a2",
                    Some("msg_1"),
                    serde_json::json!([{"type":"text","text":""}]),
                ),
                claude_assistant(
                    "a3",
                    Some("msg_1"),
                    serde_json::json!([{"type":"text","text":"Hello"}]),
                ),
                claude_assistant(
                    "a9",
                    None,
                    serde_json::json!([{"type":"text","text":"No message id"}]),
                ),
                claude_assistant(
                    "a5",
                    Some("msg_2"),
                    serde_json::json!([
                    {"type":"tool_use","id":"toolu_w","name":"Write",
                     "input":{"file_path": format!("{dir}/out.txt"),"content":"x"}}]),
                ),
                claude_tool_result("u2", "toolu_w", false),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        // The same hashes the bridge computes: sha256 of the value, 24 hex digits.
        assert_eq!(
            ids(&projection),
            [
                "claude-user-bb82030dbc2bcaba32a90bf2",
                "claude-thinking-a9a52fa53ccdbfbbe333256a",
                "claude-assistant-9a7a144d95ec96c2b2c5d36f",
                "claude-history-784e53d01c52f893ab51a670",
                "claude-tool-b416c98bf3202c91074a9773",
            ]
        );
        assert_eq!(
            projection.timeline_blocks()[4].status,
            GenericBlockStatus::Complete
        );
        // The listed file names the tool's block.
        let files = projection.chat_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].block_id, "claude-tool-b416c98bf3202c91074a9773");
        assert_eq!(files[0].path, Some(PathBuf::from(format!("{dir}/out.txt"))));
        assert_eq!(files[0].origin, HistoryChatFileOrigin::Written);
        // A reference stored under the earlier position id still resolves.
        assert_eq!(
            projection.final_assistant_text(Some("timeline-2"), None),
            Some("Hello")
        );
        assert_eq!(
            projection
                .final_assistant_text(Some("claude-assistant-9a7a144d95ec96c2b2c5d36f"), None),
            Some("Hello")
        );
    }

    #[test]
    fn claude_chat_files_are_written_files_and_viewed_images_of_finished_calls() {
        let directory = TemporaryDirectory::new();
        let dir = directory.path().to_string_lossy().into_owned();
        let call = |uuid: &str, id: &str, name: &str, input: serde_json::Value| {
            claude_assistant(
                uuid,
                Some("msg_files"),
                serde_json::json!([{"type":"tool_use","id":id,"name":name,"input":input}]),
            )
        };
        let source = claude_chain(
            &directory,
            &[
                claude_user("u1", serde_json::json!("Do the work")),
                call(
                    "a1",
                    "toolu_e",
                    "Edit",
                    serde_json::json!({"file_path": format!("{dir}/bad.rs")}),
                ),
                claude_tool_result("r1", "toolu_e", true),
                call(
                    "a2",
                    "toolu_r",
                    "Read",
                    serde_json::json!({"file_path": "shot.png"}),
                ),
                claude_tool_result("r2", "toolu_r", false),
                call(
                    "a3",
                    "toolu_t",
                    "Read",
                    serde_json::json!({"file_path": format!("{dir}/notes.txt")}),
                ),
                claude_tool_result("r3", "toolu_t", false),
                call(
                    "a4",
                    "toolu_n",
                    "NotebookEdit",
                    serde_json::json!({"notebook_path": format!("{dir}/nb.ipynb")}),
                ),
                claude_tool_result("r4", "toolu_n", false),
                call(
                    "a5",
                    "toolu_m",
                    "MultiEdit",
                    serde_json::json!({"file_path": format!("{dir}/multi.rs")}),
                ),
                // No result: the call never finished.
                call(
                    "a6",
                    "toolu_x",
                    "Write",
                    serde_json::json!({"file_path": format!("{dir}/lost.rs")}),
                ),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        let root = directory.path();
        let listed = projection
            .chat_files()
            .iter()
            .map(|file| (file.path.clone().expect("path"), file.origin))
            .collect::<Vec<_>>();
        // Only a call with a recorded, successful result counts: the failed
        // Edit and the MultiEdit and Write without any result are left out.
        assert_eq!(
            listed,
            [
                (root.join("shot.png"), HistoryChatFileOrigin::Read),
                (root.join("nb.ipynb"), HistoryChatFileOrigin::Written),
            ]
        );
    }

    #[test]
    fn pi_blocks_take_the_ids_the_bridge_gives_them_live() {
        let directory = TemporaryDirectory::new();
        let source = pi_source(
            &directory,
            &[
                serde_json::json!({"type":"message","id":"e1","timestamp":"2026-11-18T10:00:01Z",
                    "message":{"role":"user","content":"Write the file"}}),
                serde_json::json!({"type":"message","id":"e2","timestamp":"2026-11-18T10:00:02Z",
                    "message":{"role":"assistant","timestamp":1700000000000_i64,"content":[
                        {"type":"thinking","thinking":"Plan"},
                        {"type":"text","text":"Writing."},
                        {"type":"toolCall","id":"call_1","name":"write",
                         "arguments":{"path":"out.txt","content":"x"}}]}}),
                serde_json::json!({"type":"message","id":"e3","timestamp":"2026-11-18T10:00:03Z",
                    "message":{"role":"toolResult","toolCallId":"call_1","toolName":"write",
                               "content":[{"type":"text","text":"done"}]}}),
                // The same timestamp again: the entry id names this answer.
                serde_json::json!({"type":"message","id":"e4","timestamp":"2026-11-18T10:00:04Z",
                    "message":{"role":"assistant","timestamp":1700000000000_i64,
                               "content":[{"type":"text","text":"Again."}]}}),
            ],
        );
        let projection = project_native_workspace_history(&source, &project(&directory))
            .expect("history projects");
        assert_eq!(
            ids(&projection),
            [
                "pi-entry-8b5cc4df7eec7d32a7814eca",
                "pi-thinking-e644171f4b2c7abae83604c0",
                "pi-assistant-e644171f4b2c7abae83604c0",
                "pi-tool-74196fe72e4cdc135c1033e0",
                "pi-entry-449777124b1466a8ed667d0d",
            ]
        );
        // Answers resolve by their new id, and by the position id of before.
        assert_eq!(
            projection.final_assistant_text(Some("pi-assistant-e644171f4b2c7abae83604c0"), None),
            Some("Writing.")
        );
        assert_eq!(
            projection.final_assistant_text(Some("timeline-4"), None),
            Some("Again.")
        );
        let files = projection.chat_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].block_id, "pi-tool-74196fe72e4cdc135c1033e0");
        assert_eq!(files[0].path, Some(directory.path().join("out.txt")));
        assert_eq!(files[0].origin, HistoryChatFileOrigin::Written);
    }
}

/// Native Hermes SQLite projection. Never rewrites or converts its history.
fn project_hermes_history(
    source: &HostNativeHistorySource,
    project: &ProjectDirectory,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    if !source.path.is_absolute()
        || source.path.file_name().and_then(|n| n.to_str()) != Some("state.db")
    {
        return Err(WorkspaceHistoryError::InvalidSourcePath);
    }
    let conn = rusqlite::Connection::open_with_flags(
        &source.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let tx = conn.unchecked_transaction()?;
    let (origin, meta, cwd): (String, Option<String>, Option<String>) = tx.query_row(
        "SELECT source,model_config,cwd FROM sessions WHERE id=?1",
        [&source.expected_native_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if origin != "acp" {
        return Err(WorkspaceHistoryError::NativeSessionMismatch);
    }
    let config: Value = serde_json::from_str(meta.as_deref().unwrap_or("{}"))
        .map_err(|_| WorkspaceHistoryError::InvalidHeader)?;
    let cwd = cwd
        .as_deref()
        .filter(|v| !v.is_empty())
        .or_else(|| config.get("cwd").and_then(Value::as_str))
        .ok_or(WorkspaceHistoryError::InvalidHeader)?;
    let native_project = ProjectDirectory::resolve(Path::new(cwd))
        .map_err(WorkspaceHistoryError::HeaderProjectUnavailable)?;
    if !native_project.same_directory(project) {
        return Err(WorkspaceHistoryError::HeaderProjectMismatch);
    }
    let mut builder = CodexProjectionBuilder::new(project.canonical_path());
    let mut query = tx.prepare(
        "SELECT role,content,tool_name FROM messages WHERE session_id=?1 AND active=1 ORDER BY id",
    )?;
    let rows = query.query_map([&source.expected_native_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let max_bytes = SessionDiscoveryLimits::default().max_file_bytes;
    let mut scanned_bytes = 0usize;
    for row in rows {
        let (role, content, tool) = row?;
        let text = content.unwrap_or_default();
        scanned_bytes = scanned_bytes.saturating_add(text.len());
        if scanned_bytes > max_bytes {
            return Err(BoundedScanError::FileTooLarge { limit: max_bytes }.into());
        }
        let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text.clone()));
        let text = exact_display_scalar(Some(&value)).unwrap_or(text);
        match role.as_str() {
            "user" | "assistant" => builder.push_text(
                if role == "user" {
                    GenericBlockKind::User
                } else {
                    GenericBlockKind::Assistant
                },
                "hermes-message",
                None,
                text,
                CodexTextSource::Response,
                None,
            ),
            "tool" => {
                let id = format!("hermes-tool-{}", builder.blocks.len());
                builder.push_tool(None, tool.as_deref(), Some(&id), None);
                builder.finish_tool(Some(&id), Some(text), false);
            }
            "system" => {}
            _ => builder.push_unknown(0, b"{}", "hermes-message", None),
        }
    }
    let mut report = super::scan_bytes("state.db", b"");
    report.pi_session_id = Some(source.expected_native_id.clone());
    report.project_cwd = Some(cwd.to_owned());
    report.entry_count = builder.blocks.len();
    report.parse_state = ParseState::Healthy;
    report.diagnostics.clear();
    trim_old_display(&mut builder.blocks);
    report.timeline_blocks = builder.blocks;
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts: builder.assistants,
        files: Vec::new(),
    })
}

#[cfg(test)]
mod hermes_tests {
    use super::*;
    #[test]
    fn native_sqlite_results_are_read_only_scoped_and_hash_resolvable() {
        let root = std::env::temp_dir().join(format!("piui-hermes-history-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join("state.db");
        let conn = rusqlite::Connection::open(&path).expect("fixture database");
        conn.execute_batch("CREATE TABLE sessions(id TEXT, source TEXT, model_config TEXT, cwd TEXT); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, active INTEGER);").expect("native fixture schema");
        conn.execute(
            "INSERT INTO sessions VALUES ('native','acp','{}',?1)",
            [root.to_string_lossy().as_ref()],
        )
        .expect("session");
        conn.execute_batch("INSERT INTO messages VALUES (1,'native','assistant','old result',NULL,0),(2,'native','assistant','verified result',NULL,1),(3,'other','assistant','foreign result',NULL,1);").expect("messages");
        drop(conn);
        let before = std::fs::read(&path).expect("before");
        let source = HostNativeHistorySource::new(
            path.clone(),
            "native".into(),
            WorkspaceHistoryFormat::Hermes,
        );
        let project = ProjectDirectory::resolve(&root).expect("project");
        let projection =
            project_native_workspace_history(&source, &project).expect("read native history");
        assert_eq!(
            projection.final_assistant_text(None, Some(&sha256(b"verified result"))),
            Some("verified result")
        );
        assert_eq!(
            projection.final_assistant_text(None, Some(&sha256(b"old result"))),
            None
        );
        assert_eq!(projection.timeline_blocks().len(), 1);
        let other = root.join("other");
        std::fs::create_dir(&other).expect("other project");
        assert!(matches!(
            project_native_workspace_history(
                &source,
                &ProjectDirectory::resolve(&other).expect("other")
            ),
            Err(WorkspaceHistoryError::HeaderProjectMismatch)
        ));
        let missing = HostNativeHistorySource::new(
            path.clone(),
            "missing".into(),
            WorkspaceHistoryFormat::Hermes,
        );
        assert!(project_native_workspace_history(&missing, &project).is_err());
        assert_eq!(std::fs::read(&path).expect("after"), before);
        std::fs::remove_dir_all(&root).expect("cleanup fixture");
    }
}

/// Safe fixed summary of a Claude Code API failure. Native error text can
/// contain provider or account details and is never projected.
const CLAUDE_API_ERROR_NOTICE: &str = "Claude Code could not complete this turn.";

/// Tool output is capped while reading: only a bounded preview is displayed,
/// so a transcript never holds more than this per result in memory.
const CLAUDE_TOOL_OUTPUT_CAP: usize = super::DISPLAY_DETAIL_LIMIT + 8;

/// A Claude Code transcript is streamed line by line and never held whole, so
/// its safety cap is far above the scanner's 128 MiB bound: real transcripts
/// with many compactions reach 200 MB.
const CLAUDE_MAX_FILE_BYTES: usize = 1024 * 1024 * 1024;

/// One line is parsed in memory. A longer line is consumed without buffering
/// and shown as an unreadable entry.
const CLAUDE_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Raw bytes read from the file per step.
const CLAUDE_READ_CHUNK_BYTES: usize = 256 * 1024;

/// The line buffer is released after a line that grew it beyond this.
const CLAUDE_RETAINED_LINE_BYTES: usize = 1024 * 1024;

/// The projected part of the active chain keeps at most about this much text
/// (user, assistant and thinking text plus tool output). A longer chain starts
/// later, behind one notice block.
const CLAUDE_CHAIN_TEXT_BUDGET: usize = 32 * 1024 * 1024;

/// Same wording as the live bridge's notice for the same situation.
const CLAUDE_HISTORY_TRIMMED_NOTICE: &str = "Earlier Claude Code history is not shown.";

/// Read limits of the Claude Code projection; tests pass small ones.
#[derive(Clone, Copy)]
struct ClaudeReadLimits {
    max_file_bytes: usize,
    max_line_bytes: usize,
    chain_text_budget: usize,
}

impl ClaudeReadLimits {
    const PRODUCTION: Self = Self {
        max_file_bytes: CLAUDE_MAX_FILE_BYTES,
        max_line_bytes: CLAUDE_MAX_LINE_BYTES,
        chain_text_budget: CLAUDE_CHAIN_TEXT_BUDGET,
    };
}

/// One entry of a Claude Code conversation chain (`uuid`/`parentUuid`).
struct ClaudeChainEntry {
    line: u64,
    uuid: String,
    parent: Option<String>,
    created_at: Option<String>,
    cwd: Option<String>,
    /// A main-conversation user or assistant entry: a possible active leaf.
    conversational: bool,
    content: ClaudeEntryContent,
}

enum ClaudeEntryContent {
    User {
        text: Option<String>,
        results: Vec<ClaudeToolResult>,
        /// Images the prompt carried (their bytes are never read).
        images: usize,
    },
    Assistant {
        /// The API message id: Claude Code splits one message into one
        /// transcript entry per content block and repeats it on each.
        message_id: Option<String>,
        parts: Vec<ClaudeAssistantPart>,
    },
    ApiError,
    Compaction,
    /// Meta, sidechain, compact-summary, attachment and other system entries.
    Internal,
    Unknown {
        entry_type: String,
        byte_length: usize,
        sha256: String,
    },
}

enum ClaudeAssistantPart {
    /// An empty `text` is a part with nothing to show; it still takes a rank.
    Text {
        text: String,
        index: usize,
    },
    Thinking {
        text: String,
        index: usize,
    },
    ToolUse {
        id: String,
        name: Option<String>,
        files: Vec<ClaudeFileRef>,
    },
    Unsupported(String),
}

/// A file a tool call names (the path as written in the tool input).
struct ClaudeFileRef {
    path: String,
    origin: HistoryChatFileOrigin,
}

struct ClaudeToolResult {
    tool_use_id: String,
    output: Option<String>,
    failed: bool,
}

enum ClaudeLine {
    Chain(Box<ClaudeChainEntry>),
    /// Session metadata outside the conversation chain (queue operations,
    /// titles, prompts, file snapshots and future metadata kinds).
    Metadata,
    Malformed,
}

/// Claude Code session ids are lowercase-or-uppercase hyphenated UUIDs.
fn is_claude_session_id(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

/// The tags Claude Code itself wraps around text it puts in a user message:
/// slash-command echoes, command output, reminders, shell-mode input and
/// output, hook output and task notifications. Only these exact names mark an
/// internal entry; a prompt that merely starts with some other tag (`<task>`,
/// `<pasted_content>`, HTML) is what the person wrote.
const CLAUDE_INTERNAL_TAGS: [&str; 12] = [
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "system-reminder",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
    "user-prompt-submit-hook",
    "task-notification",
];

/// Whether a user text is one of Claude Code's own native markers: a whole
/// `CLAUDE_INTERNAL_TAGS` tag at the start, or a bracketed interrupt notice.
fn is_internal_claude_text(text: &str) -> bool {
    let text = text.trim_start();
    if let Some(rest) = text.strip_prefix('<') {
        let end = rest
            .find(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
            })
            .unwrap_or(rest.len());
        let (name, after) = rest.split_at(end);
        return CLAUDE_INTERNAL_TAGS.contains(&name)
            && after
                .chars()
                .next()
                .is_some_and(|character| character == '>' || character.is_whitespace());
    }
    text.strip_prefix("[Request interrupted by user")
        .is_some_and(|rest| rest.contains(']'))
}

fn capped_tool_output(mut text: String) -> String {
    if text.len() > CLAUDE_TOOL_OUTPUT_CAP {
        let mut end = CLAUDE_TOOL_OUTPUT_CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// Mirrors the live bridge: text parts are kept, images and other binary
/// parts become fixed placeholders and are never forwarded.
fn claude_tool_result_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(capped_tool_output(text.clone())),
        Value::Array(parts) => {
            let mut output = String::new();
            for (index, part) in parts.iter().enumerate() {
                if index > 0 {
                    output.push('\n');
                }
                let part = part.as_object();
                match part
                    .and_then(|part| part.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("text") => output.push_str(
                        part.and_then(|part| part.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                    Some("image") => output.push_str("[image]"),
                    _ => output.push_str("[unsupported content]"),
                }
                if output.len() > CLAUDE_TOOL_OUTPUT_CAP {
                    break;
                }
            }
            Some(capped_tool_output(output))
        }
        _ => None,
    }
}

fn claude_user_content(message: &Map<String, Value>) -> ClaudeEntryContent {
    let mut texts = Vec::new();
    let mut results = Vec::new();
    let mut images = 0_usize;
    match message.get("content") {
        Some(Value::String(text)) => texts.push(text.as_str()),
        Some(Value::Array(parts)) => {
            for part in parts.iter().filter_map(Value::as_object) {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            texts.push(text);
                        }
                    }
                    Some("tool_result") => {
                        if let Some(id) = part.get("tool_use_id").and_then(Value::as_str) {
                            results.push(ClaudeToolResult {
                                tool_use_id: id.to_owned(),
                                output: claude_tool_result_text(part.get("content")),
                                failed: part.get("is_error").and_then(Value::as_bool) == Some(true),
                            });
                        }
                    }
                    Some("image") => images += 1,
                    _ => {}
                }
            }
        }
        _ => {}
    }
    let text = texts
        .into_iter()
        .filter(|text| !is_internal_claude_text(text))
        .collect::<Vec<_>>()
        .join("\n");
    ClaudeEntryContent::User {
        text: (!text.trim().is_empty()).then_some(text),
        results,
        images,
    }
}

/// Whether a path names an image the host can preview.
fn is_image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
            )
        })
}

/// The files a Claude tool call names: what Write, Edit, MultiEdit and
/// NotebookEdit write, and the images Read looks at.
fn claude_tool_files(name: Option<&str>, input: Option<&Value>) -> Vec<ClaudeFileRef> {
    let Some(input) = input.and_then(Value::as_object) else {
        return Vec::new();
    };
    let field = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .map(str::to_owned)
    };
    let (path, origin) = match name {
        Some("Write" | "Edit" | "MultiEdit") => {
            (field("file_path"), HistoryChatFileOrigin::Written)
        }
        Some("NotebookEdit") => (field("notebook_path"), HistoryChatFileOrigin::Written),
        Some("Read") => (
            field("file_path").filter(|path| is_image_path(path)),
            HistoryChatFileOrigin::Read,
        ),
        _ => (None, HistoryChatFileOrigin::Read),
    };
    path.map(|path| ClaudeFileRef { path, origin })
        .into_iter()
        .collect()
}

fn claude_assistant_content(message: &Map<String, Value>) -> ClaudeEntryContent {
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let mut parts = Vec::new();
    for (index, part) in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(part) = part.as_object() else {
            continue;
        };
        // A part that carries nothing to show keeps an empty text: it still
        // takes a rank, exactly as the live stream's content blocks do.
        let text_of = |key: &str| {
            part.get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_default()
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(ClaudeAssistantPart::Text {
                text: text_of("text"),
                index,
            }),
            Some("thinking") => parts.push(ClaudeAssistantPart::Thinking {
                text: text_of("thinking"),
                index,
            }),
            Some("tool_use") => {
                if let Some(id) = part.get("id").and_then(Value::as_str) {
                    let name = part.get("name").and_then(Value::as_str);
                    parts.push(ClaudeAssistantPart::ToolUse {
                        id: id.to_owned(),
                        name: name.map(str::to_owned),
                        files: claude_tool_files(name, part.get("input")),
                    });
                }
            }
            // Redacted reasoning is encrypted and never readable.
            Some("redacted_thinking") => {}
            other => parts.push(ClaudeAssistantPart::Unsupported(format!(
                "content:{}",
                other.unwrap_or("unknown")
            ))),
        }
    }
    ClaudeEntryContent::Assistant { message_id, parts }
}

fn read_claude_line(
    line: u64,
    frame: &[u8],
    expected_native_id: &str,
) -> Result<ClaudeLine, WorkspaceHistoryError> {
    if frame.iter().all(u8::is_ascii_whitespace) {
        return Ok(ClaudeLine::Metadata);
    }
    let Ok(value) = serde_json::from_slice::<Value>(frame) else {
        return Ok(ClaudeLine::Malformed);
    };
    let Some(object) = value.as_object() else {
        return Ok(ClaudeLine::Malformed);
    };
    // Every entry that names a session must name this one.
    if let Some(session_id) = object.get("sessionId").and_then(Value::as_str)
        && session_id != expected_native_id
    {
        return Err(WorkspaceHistoryError::NativeSessionMismatch);
    }
    let Some(uuid) = object
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|uuid| !uuid.is_empty())
    else {
        return Ok(ClaudeLine::Metadata);
    };
    let flag = |name: &str| object.get(name).and_then(Value::as_bool) == Some(true);
    let entry_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    let sidechain = flag("isSidechain");
    let message = object.get("message").and_then(Value::as_object);
    let content = match (entry_type, message) {
        ("user", Some(message)) if !sidechain && !flag("isMeta") && !flag("isCompactSummary") => {
            claude_user_content(message)
        }
        ("assistant", _)
            if !sidechain
                && (flag("isApiErrorMessage")
                    || object.get("error").is_some_and(Value::is_string)) =>
        {
            ClaudeEntryContent::ApiError
        }
        ("assistant", Some(message)) if !sidechain => claude_assistant_content(message),
        ("system", _)
            if object.get("subtype").and_then(Value::as_str) == Some("compact_boundary") =>
        {
            ClaudeEntryContent::Compaction
        }
        ("user" | "assistant" | "system" | "attachment" | "progress", _) => {
            ClaudeEntryContent::Internal
        }
        (other, _) => ClaudeEntryContent::Unknown {
            entry_type: if other.is_empty() {
                "unknown".into()
            } else {
                other.to_owned()
            },
            byte_length: frame.len(),
            sha256: sha256(frame),
        },
    };
    let text_field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Ok(ClaudeLine::Chain(Box::new(ClaudeChainEntry {
        line,
        uuid: uuid.to_owned(),
        // A compaction boundary starts a new root and names the earlier
        // history through `logicalParentUuid`.
        parent: text_field("parentUuid").or_else(|| text_field("logicalParentUuid")),
        created_at: text_field("timestamp"),
        cwd: text_field("cwd").filter(|cwd| Path::new(cwd).is_absolute()),
        conversational: matches!(entry_type, "user" | "assistant") && !sidechain,
        content,
    })))
}

impl CodexProjectionBuilder<'_> {
    /// The id for a block the Claude bridge names `native` live, when that id
    /// is still free.
    fn free_native(&self, native: String) -> Option<String> {
        (!self.index_by_id.contains_key(&native)).then_some(native)
    }

    /// A generic fallback that is shown once per unknown entry kind; every
    /// occurrence is still recorded in the report's unknown-entry summary.
    fn push_claude_unknown(
        &mut self,
        shown: &mut std::collections::HashSet<String>,
        summary: UnknownEntrySummary,
        created_at: Option<String>,
    ) {
        let first = shown.insert(summary.entry_type.clone());
        if first {
            let id = self.next_id(None);
            self.blocks.push(GenericTimelineBlock {
                id,
                parent_id: None,
                kind: GenericBlockKind::Unknown,
                source_type: "claude_unknown".into(),
                created_at,
                preview: None,
                has_image: false,
                attachment_count: 0,
                title: Some("Unrecognized session entry".into()),
                tool_name: None,
                collapsible: true,
                truncated: false,
                fallback: true,
                status: GenericBlockStatus::Complete,
            });
            self.last_visible = None;
        }
        self.unknown_entries.push(summary);
    }

    fn push_claude_notice(&mut self, created_at: Option<String>, native: Option<&str>) {
        let id = self.next_id(native);
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Custom,
            source_type: "claude_api_error".into(),
            created_at,
            preview: Some(CLAUDE_API_ERROR_NOTICE.into()),
            has_image: false,
            attachment_count: 0,
            title: Some("Error".into()),
            tool_name: None,
            collapsible: false,
            truncated: false,
            fallback: false,
            status: GenericBlockStatus::Failed,
        });
        self.last_visible = None;
    }

    /// Marks the top of a chain whose older part is not projected. It reuses
    /// the generic custom block, so it needs no new block kind.
    fn push_claude_history_notice(&mut self, native: Option<&str>) {
        let id = self.next_id(native);
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Custom,
            source_type: "claude_history_trimmed".into(),
            created_at: None,
            preview: Some(CLAUDE_HISTORY_TRIMMED_NOTICE.into()),
            has_image: false,
            attachment_count: 0,
            title: Some("Earlier history not shown".into()),
            tool_name: None,
            collapsible: false,
            truncated: false,
            fallback: false,
            status: GenericBlockStatus::Complete,
        });
        self.last_visible = None;
    }
}

/// Ranks of text and thinking parts per API message, counted over the whole
/// chain: the second text part of a message is rank 1, shown or not. The live
/// bridge names an answer by its message id and this rank.
#[derive(Default)]
struct ClaudeRanks(HashMap<(String, &'static str), usize>);

impl ClaudeRanks {
    fn take_rank(&mut self, message_id: Option<&str>, kind: &'static str) -> Option<usize> {
        let slot = self.0.entry((message_id?.to_owned(), kind)).or_default();
        let rank = *slot;
        *slot += 1;
        Some(rank)
    }
}

/// The id the Claude bridge gives an answer or thinking part: from its message
/// id and rank when it has them, else from the entry uuid and content index.
fn claude_part_id(
    kind: &str,
    message_id: Option<&str>,
    rank: Option<usize>,
    uuid: &str,
    index: usize,
) -> (Option<String>, String) {
    let stable = message_id.zip(rank).map(|(message_id, rank)| {
        opaque_id(&format!("claude-{kind}"), &format!("{message_id}:{rank}"))
    });
    (
        stable,
        opaque_id("claude-history", &format!("{uuid}:{index}")),
    )
}

fn unknown_summary(line: u64, entry_type: &str, frame: &[u8]) -> UnknownEntrySummary {
    unknown_summary_of(line, entry_type, frame.len(), sha256(frame))
}

fn unknown_summary_of(
    line: u64,
    entry_type: &str,
    byte_length: usize,
    sha256: String,
) -> UnknownEntrySummary {
    UnknownEntrySummary {
        line,
        entry_type: super::safe_text(entry_type, super::TYPE_LIMIT),
        byte_length,
        sha256,
    }
}

/// The finished line of a streamed transcript.
enum ClaudeRawLine<'a> {
    Frame(&'a [u8]),
    /// A line over the cap: only its byte length and SHA-256 were kept.
    Oversized {
        byte_length: usize,
        sha256: String,
    },
}

/// Collects the pieces of one LF-delimited line. A line over the cap is never
/// buffered: its length and hash are accumulated while it streams past.
struct ClaudeLineAssembler {
    max_line_bytes: usize,
    buffer: Vec<u8>,
    oversized: Option<(usize, Sha256)>,
}

impl ClaudeLineAssembler {
    fn new(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes,
            buffer: Vec::new(),
            oversized: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.buffer.is_empty() && self.oversized.is_none()
    }

    fn push(&mut self, piece: &[u8]) {
        if let Some((length, hasher)) = &mut self.oversized {
            *length = length.saturating_add(piece.len());
            hasher.update(piece);
        } else if self.buffer.len().saturating_add(piece.len()) > self.max_line_bytes {
            let mut hasher = Sha256::new();
            hasher.update(&self.buffer);
            hasher.update(piece);
            let length = self.buffer.len().saturating_add(piece.len());
            self.buffer = Vec::new();
            self.oversized = Some((length, hasher));
        } else {
            self.buffer.extend_from_slice(piece);
        }
    }

    /// The line collected so far; call `reset` before collecting the next.
    fn line(&mut self) -> ClaudeRawLine<'_> {
        match self.oversized.take() {
            Some((byte_length, hasher)) => ClaudeRawLine::Oversized {
                byte_length,
                sha256: format!("{:x}", hasher.finalize()),
            },
            None => ClaudeRawLine::Frame(&self.buffer),
        }
    }

    fn reset(&mut self) {
        if self.buffer.capacity() > CLAUDE_RETAINED_LINE_BYTES {
            self.buffer = Vec::new();
        } else {
            self.buffer.clear();
        }
        self.oversized = None;
    }
}

/// A Claude Code transcript read as a stream: compact entries instead of raw
/// bytes, so memory does not grow with lines that are only skipped.
struct ClaudeTranscript {
    entries: Vec<ClaudeChainEntry>,
    /// Lines that are not JSON, or too long to parse, summarized when read.
    unreadable: Vec<UnknownEntrySummary>,
    /// SHA-256 of the whole file.
    revision: String,
    total_bytes: usize,
    /// Bytes up to and including the last LF.
    complete_bytes: usize,
}

impl ClaudeTranscript {
    fn accept(
        &mut self,
        line: u64,
        raw: ClaudeRawLine<'_>,
        expected_native_id: &str,
    ) -> Result<(), WorkspaceHistoryError> {
        match raw {
            ClaudeRawLine::Frame(frame) => {
                match read_claude_line(line, frame, expected_native_id)? {
                    ClaudeLine::Chain(entry) => self.entries.push(*entry),
                    ClaudeLine::Metadata => {}
                    ClaudeLine::Malformed => {
                        self.unreadable
                            .push(unknown_summary(line, "unreadable", frame));
                    }
                }
            }
            ClaudeRawLine::Oversized {
                byte_length,
                sha256,
            } => self
                .unreadable
                .push(unknown_summary_of(line, "unreadable", byte_length, sha256)),
        }
        Ok(())
    }
}

/// Splits only on LF and keeps at most one line plus one read chunk of raw
/// bytes. A crash can leave a final line without its LF: it is read like any
/// other line, and a torn one is shown as unreadable, never hiding the rest.
fn stream_claude_transcript<R: BufRead>(
    mut reader: R,
    expected_native_id: &str,
    max_line_bytes: usize,
) -> Result<ClaudeTranscript, WorkspaceHistoryError> {
    let mut transcript = ClaudeTranscript {
        entries: Vec::new(),
        unreadable: Vec::new(),
        revision: String::new(),
        total_bytes: 0,
        complete_bytes: 0,
    };
    let mut assembler = ClaudeLineAssembler::new(max_line_bytes);
    let mut hasher = Sha256::new();
    let mut line = 1_u64;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(BoundedScanError::Read(error).into()),
        };
        if chunk.is_empty() {
            break;
        }
        hasher.update(chunk);
        let mut start = 0;
        while let Some(relative) = chunk[start..].iter().position(|byte| *byte == b'\n') {
            let end = start + relative;
            assembler.push(&chunk[start..end]);
            transcript.accept(line, assembler.line(), expected_native_id)?;
            assembler.reset();
            line = line.saturating_add(1);
            start = end + 1;
            transcript.complete_bytes = transcript.total_bytes + start;
        }
        assembler.push(&chunk[start..]);
        let consumed = chunk.len();
        transcript.total_bytes += consumed;
        reader.consume(consumed);
    }
    if !assembler.is_empty() {
        transcript.accept(line, assembler.line(), expected_native_id)?;
    }
    transcript.revision = format!("{:x}", hasher.finalize());
    Ok(transcript)
}

/// Streams the transcript through a no-follow handle and, like
/// `read_stable_bounded`, rejects a file that was replaced, resized or touched
/// while it was read.
fn read_claude_transcript(
    path: &Path,
    expected_native_id: &str,
    limits: ClaudeReadLimits,
) -> Result<(ClaudeTranscript, Option<SystemTime>), WorkspaceHistoryError> {
    let too_large = BoundedScanError::FileTooLarge {
        limit: limits.max_file_bytes,
    };
    let (file, opened_identity) = open_session_file_no_follow(path)?;
    let opened_metadata = file.metadata().map_err(BoundedScanError::Read)?;
    if opened_metadata.len() > limits.max_file_bytes as u64 {
        return Err(too_large.into());
    }
    // One byte past the cap tells a file that grew while read from one at the cap.
    let reader = BufReader::with_capacity(
        CLAUDE_READ_CHUNK_BYTES,
        file.take(limits.max_file_bytes as u64 + 1),
    );
    let transcript = stream_claude_transcript(reader, expected_native_id, limits.max_line_bytes)?;
    if transcript.total_bytes > limits.max_file_bytes {
        return Err(too_large.into());
    }

    let (final_file, final_identity) = open_session_file_no_follow(path)?;
    let final_metadata = final_file.metadata().map_err(BoundedScanError::Read)?;
    let length = transcript.total_bytes as u64;
    if final_identity != opened_identity
        || opened_metadata.len() != length
        || final_metadata.len() != length
        || (opened_metadata.modified().ok().is_some()
            && final_metadata.modified().ok() != opened_metadata.modified().ok())
    {
        return Err(BoundedScanError::Changed.into());
    }
    Ok((transcript, final_metadata.modified().ok()))
}

/// Text a chain entry contributes to the retained-text budget.
fn claude_entry_text_bytes(entry: &ClaudeChainEntry) -> usize {
    match &entry.content {
        ClaudeEntryContent::User { text, results, .. } => {
            text.as_ref().map_or(0, String::len)
                + results
                    .iter()
                    .filter_map(|result| result.output.as_ref())
                    .map(String::len)
                    .sum::<usize>()
        }
        ClaudeEntryContent::Assistant { parts, .. } => parts
            .iter()
            .map(|part| match part {
                ClaudeAssistantPart::Text { text, .. }
                | ClaudeAssistantPart::Thinking { text, .. } => text.len(),
                ClaudeAssistantPart::ToolUse { .. } | ClaudeAssistantPart::Unsupported(_) => 0,
            })
            .sum(),
        ClaudeEntryContent::ApiError
        | ClaudeEntryContent::Compaction
        | ClaudeEntryContent::Internal
        | ClaudeEntryContent::Unknown { .. } => 0,
    }
}

/// Position in `chain` where the projection starts: the newest entries within
/// the text budget (the newest entry is always kept), moved on to the next user
/// prompt so the shown history does not open in the middle of a turn.
fn claude_chain_start(entries: &[ClaudeChainEntry], chain: &[usize], budget: usize) -> usize {
    let mut kept = 0_usize;
    let mut start = chain.len();
    while start > 0 {
        let weight = claude_entry_text_bytes(&entries[chain[start - 1]]);
        if start < chain.len() && kept.saturating_add(weight) > budget {
            break;
        }
        kept = kept.saturating_add(weight);
        start -= 1;
    }
    if start > 0
        && let Some(offset) = chain[start..].iter().position(|&index| {
            matches!(
                &entries[index].content,
                ClaudeEntryContent::User { text, images, .. } if text.is_some() || *images > 0
            )
        })
    {
        start += offset;
    }
    start
}

/// Native Claude Code JSONL projection. It follows the active branch back
/// from the newest main-conversation entry through `parentUuid` (compaction
/// boundaries through `logicalParentUuid`), skips meta, sidechain, summary
/// and other internal entries, and never writes or converts the history.
///
/// The transcript is streamed (no 128 MiB refusal; a 1 GiB safety cap) and only
/// the newest part of the active chain is projected when it holds more than
/// 32 MiB of text.
fn project_claude_code_history(
    source: &HostNativeHistorySource,
    project: &ProjectDirectory,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    project_claude_code_history_with_limits(source, project, ClaudeReadLimits::PRODUCTION)
}

fn project_claude_code_history_with_limits(
    source: &HostNativeHistorySource,
    project: &ProjectDirectory,
    limits: ClaudeReadLimits,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    validate_source_path(&source.path)?;
    // Claude Code names every transcript after its immutable session id.
    if !is_claude_session_id(&source.expected_native_id)
        || source.path.file_stem().and_then(|stem| stem.to_str())
            != Some(source.expected_native_id.as_str())
    {
        return Err(WorkspaceHistoryError::NativeSessionMismatch);
    }
    let (transcript, modified) =
        read_claude_transcript(&source.path, &source.expected_native_id, limits)?;
    let ClaudeTranscript {
        entries,
        unreadable,
        revision,
        total_bytes,
        complete_bytes,
    } = transcript;
    let leaf = entries
        .iter()
        .rposition(|entry| entry.conversational)
        .ok_or(WorkspaceHistoryError::NoTimelineRecords)?;
    // The conversation must have started in the registered project.
    let cwd = entries
        .iter()
        .find_map(|entry| entry.cwd.clone())
        .ok_or(WorkspaceHistoryError::InvalidHeader)?;
    let native_project = ProjectDirectory::resolve(Path::new(&cwd))
        .map_err(WorkspaceHistoryError::HeaderProjectUnavailable)?;
    if !native_project.same_directory(project) {
        return Err(WorkspaceHistoryError::HeaderProjectMismatch);
    }

    let by_uuid = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.uuid.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Some(leaf);
    while let Some(index) = cursor {
        if !seen.insert(index) {
            break;
        }
        chain.push(index);
        cursor = entries[index]
            .parent
            .as_deref()
            .and_then(|parent| by_uuid.get(parent).copied());
    }
    chain.reverse();
    // Parallel tool calls: Claude Code chains the calls of one message and
    // hangs each result off its own call, so a result can sit beside the
    // active branch. A tool_use id names exactly one call, so its result is
    // looked up across the whole transcript.
    let mut results_by_call = HashMap::<&str, &ClaudeToolResult>::new();
    for entry in &entries {
        if let ClaudeEntryContent::User { results, .. } = &entry.content {
            for result in results {
                results_by_call
                    .entry(result.tool_use_id.as_str())
                    .or_insert(result);
            }
        }
    }
    // A branch is a parent with several user prompts or replies, not the
    // side result of a parallel tool call.
    let mut children = HashMap::<&str, usize>::new();
    for entry in entries.iter().filter(|entry| entry.conversational) {
        let tool_result_only = matches!(
            &entry.content,
            ClaudeEntryContent::User { text: None, results, .. } if !results.is_empty()
        );
        if let Some(parent) = entry.parent.as_deref()
            && !tool_result_only
        {
            *children.entry(parent).or_default() += 1;
        }
    }

    // Paths are redacted against the directory as Claude Code spelled it.
    let project_root = PathBuf::from(&cwd);
    let mut builder = CodexProjectionBuilder::new(&project_root);
    let mut shown_unknown = std::collections::HashSet::new();
    let mut ranks = ClaudeRanks::default();
    let mut unreadable = unreadable.into_iter().peekable();
    // Times describe the whole conversation, whatever part is projected.
    let created_at = chain
        .iter()
        .find_map(|&index| entries[index].created_at.clone());
    let updated_at = chain
        .iter()
        .rev()
        .find_map(|&index| entries[index].created_at.clone());
    // A chain with more text than the budget is projected from a later entry,
    // behind one notice. What the dropped part contributes to the report's
    // counts and first prompt is still taken from it.
    let first_kept = claude_chain_start(&entries, &chain, limits.chain_text_budget);
    let notice_blocks = usize::from(first_kept > 0);
    let mut first_user_preview = None;
    if first_kept > 0 {
        let omitted = opaque_id(
            "claude-history",
            &format!("{}:omitted", source.path.to_string_lossy()),
        );
        builder.push_claude_history_notice(Some(&omitted));
        for &index in &chain[..first_kept] {
            match &entries[index].content {
                // The dropped part still takes its ranks: they count over the
                // whole chain.
                ClaudeEntryContent::Assistant { message_id, parts } => {
                    for part in parts {
                        match part {
                            ClaudeAssistantPart::Text { .. } => {
                                ranks.take_rank(message_id.as_deref(), "assistant");
                            }
                            ClaudeAssistantPart::Thinking { .. } => {
                                ranks.take_rank(message_id.as_deref(), "thinking");
                            }
                            ClaudeAssistantPart::ToolUse { .. }
                            | ClaudeAssistantPart::Unsupported(_) => {}
                        }
                    }
                }
                ClaudeEntryContent::User { text, images, .. } => {
                    builder.image_entry_count = builder
                        .image_entry_count
                        .saturating_add(usize::from(*images > 0));
                    if first_user_preview.is_none()
                        && let Some(text) = text
                    {
                        let (preview, _) = bounded_display(
                            Some(text.as_str()),
                            display_limit(GenericBlockKind::User),
                        );
                        first_user_preview = preview.map(|value| {
                            redact_display_paths(&value, Some(project_root.as_path()))
                        });
                    }
                }
                ClaudeEntryContent::Compaction => {
                    builder.compaction_entry_count =
                        builder.compaction_entry_count.saturating_add(1);
                }
                _ => {}
            }
        }
    }
    for &index in &chain[first_kept..] {
        let entry = &entries[index];
        while let Some(summary) = unreadable.next_if(|summary| summary.line < entry.line) {
            builder.push_claude_unknown(&mut shown_unknown, summary, None);
        }
        let at = entry.created_at.clone();
        match &entry.content {
            ClaudeEntryContent::User {
                text,
                results,
                images,
            } => {
                for result in results {
                    // Results of calls outside the active branch are ignored.
                    if builder.tools.contains_key(&result.tool_use_id) {
                        builder.finish_tool(
                            Some(&result.tool_use_id),
                            result.output.clone(),
                            result.failed,
                        );
                    }
                }
                let before = builder.blocks.len();
                let native = builder.free_native(opaque_id("claude-user", &entry.uuid));
                match text {
                    Some(text) => builder.push_text(
                        GenericBlockKind::User,
                        "claude_user",
                        at,
                        text.clone(),
                        CodexTextSource::Response,
                        native.as_deref(),
                    ),
                    // A prompt of only images still opens its turn.
                    None if *images > 0 => builder.push_attachment_only_user(
                        "claude_user",
                        at,
                        CodexTextSource::Response,
                        native.as_deref(),
                    ),
                    None => {}
                }
                builder.mark_user_attachments(before, *images);
            }
            ClaudeEntryContent::Assistant { message_id, parts } => {
                for part in parts {
                    match part {
                        ClaudeAssistantPart::Text { text, index }
                        | ClaudeAssistantPart::Thinking { text, index } => {
                            let (kind, block_kind, source_type) =
                                if matches!(part, ClaudeAssistantPart::Text { .. }) {
                                    ("assistant", GenericBlockKind::Assistant, "claude_assistant")
                                } else {
                                    ("thinking", GenericBlockKind::Thinking, "claude_thinking")
                                };
                            let rank = ranks.take_rank(message_id.as_deref(), kind);
                            if text.is_empty() {
                                continue;
                            }
                            let (stable, fallback) = claude_part_id(
                                kind,
                                message_id.as_deref(),
                                rank,
                                &entry.uuid,
                                *index,
                            );
                            let native = stable
                                .and_then(|id| builder.free_native(id))
                                .or_else(|| builder.free_native(fallback));
                            builder.push_text(
                                block_kind,
                                source_type,
                                at.clone(),
                                text.clone(),
                                CodexTextSource::Response,
                                native.as_deref(),
                            );
                        }
                        ClaudeAssistantPart::ToolUse { id, name, files } => {
                            let native = builder.free_native(opaque_id("claude-tool", id));
                            builder.push_tool(
                                at.clone(),
                                name.as_deref(),
                                Some(id),
                                native.as_deref(),
                            );
                            if let Some(block_id) = builder.tool_block_id(id) {
                                for file in files {
                                    builder.note_path(&block_id, &file.path, file.origin);
                                }
                            }
                        }
                        ClaudeAssistantPart::Unsupported(kind) => builder.push_claude_unknown(
                            &mut shown_unknown,
                            unknown_summary(entry.line, kind, b""),
                            at.clone(),
                        ),
                    }
                }
            }
            ClaudeEntryContent::ApiError => {
                let native = builder.free_native(opaque_id(
                    "claude-history",
                    &format!("{}:error", entry.uuid),
                ));
                builder.push_claude_notice(at, native.as_deref());
            }
            ClaudeEntryContent::Compaction => {
                let native = builder.free_native(opaque_id(
                    "claude-history",
                    &format!("{}:compaction", entry.uuid),
                ));
                builder.push_compaction(at, None, native.as_deref());
            }
            ClaudeEntryContent::Internal => {}
            ClaudeEntryContent::Unknown {
                entry_type,
                byte_length,
                sha256,
            } => builder.push_claude_unknown(
                &mut shown_unknown,
                UnknownEntrySummary {
                    line: entry.line,
                    entry_type: super::safe_text(entry_type, super::TYPE_LIMIT),
                    byte_length: *byte_length,
                    sha256: sha256.clone(),
                },
                at,
            ),
        }
    }
    for summary in unreadable {
        builder.push_claude_unknown(&mut shown_unknown, summary, None);
    }
    let pending_calls = builder
        .tools
        .iter()
        .filter(|(_, index)| builder.blocks[**index].status == GenericBlockStatus::Running)
        .map(|(call, _)| call.clone())
        .collect::<Vec<_>>();
    for call in pending_calls {
        if let Some(result) = results_by_call.get(call.as_str()) {
            builder.finish_tool(Some(&call), result.output.clone(), result.failed);
        }
    }
    // A call without a recorded result never finished.
    for block in &mut builder.blocks {
        if block.kind == GenericBlockKind::Tool && block.status == GenericBlockStatus::Running {
            block.status = GenericBlockStatus::Interrupted;
        }
    }
    // The notice keeps its preview: only the history behind it is trimmed.
    trim_old_display(&mut builder.blocks[notice_blocks..]);
    if builder.blocks.len() <= notice_blocks {
        return Err(WorkspaceHistoryError::NoTimelineRecords);
    }

    let source_name = source
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let mut report = super::scan_bytes(source_name, b"");
    report.file_revision = revision;
    report.source_modified = modified;
    report.complete_bytes = complete_bytes;
    report.partial_tail_bytes = total_bytes.saturating_sub(complete_bytes);
    report.pi_session_id = Some(source.expected_native_id.clone());
    report.project_cwd = Some(cwd);
    report.created_at = created_at;
    report.updated_at = updated_at.or_else(|| report.created_at.clone());
    report.first_user_preview = first_user_preview.or_else(|| {
        builder.blocks.iter().find_map(|block| {
            (block.kind == GenericBlockKind::User)
                .then(|| block.preview.clone())
                .flatten()
        })
    });
    report.last_message_preview = builder.blocks.iter().rev().find_map(|block| {
        matches!(
            block.kind,
            GenericBlockKind::User | GenericBlockKind::Assistant
        )
        .then(|| block.preview.clone())
        .flatten()
    });
    report.entry_count = builder.blocks.len();
    report.image_entry_count = builder.image_entry_count;
    report.compaction_entry_count = builder.compaction_entry_count;
    report.branch_count = children.values().filter(|count| **count > 1).count();
    report.parse_state = if builder.unknown_entries.is_empty() {
        ParseState::Healthy
    } else {
        ParseState::Unsupported
    };
    report.unknown_entries = builder.unknown_entries;
    let files = finalize_chat_files(builder.files, &builder.blocks);
    report.timeline_blocks = builder.blocks;
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts: builder.assistants,
        files,
    })
}
