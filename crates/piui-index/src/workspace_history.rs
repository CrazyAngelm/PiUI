//! Read-only history projection for host-registered native workspace sessions.
//!
//! The trusted workspace host supplies the native transcript path and immutable
//! native session id from its private registry. This module never discovers,
//! launches, resumes, copies, converts, repairs, or writes native sessions.

use super::{
    BoundedScanError, GenericBlockKind, GenericBlockStatus, GenericTimelineBlock, ParseState,
    ScanReport, SessionDiscoveryLimits, UnknownEntrySummary, bounded_display, display_content,
    display_limit, is_session_jsonl, lf_frames, open_session_file_no_follow, redact_display_paths,
    scan_bytes_for_display_with_root, sha256, string_field, trim_old_display,
};
use piui_platform::{ProjectDirectory, ProjectDirectoryError};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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
    sha256: String,
    text: String,
}

/// UI-safe generic history plus exact host-private assistant text resolution.
///
/// The report uses the existing generic timeline projection. Exact assistant
/// text is intentionally private and available only through the lookup method
/// used to resolve an already validated orchestration dependency reference.
pub struct WorkspaceHistoryProjection {
    pub report: ScanReport,
    assistant_texts: Vec<AssistantHistoryText>,
}

impl std::fmt::Debug for WorkspaceHistoryProjection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceHistoryProjection")
            .field("report", &"<generic projection>")
            .field("assistant_text_count", &self.assistant_texts.len())
            .finish()
    }
}

impl WorkspaceHistoryProjection {
    #[must_use]
    pub fn timeline_blocks(&self) -> &[GenericTimelineBlock] {
        &self.report.timeline_blocks
    }

    /// Resolves exact source text. A scanner block id is accepted only when an
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
                .find(|candidate| candidate.block_id == block_id)
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
        WorkspaceHistoryFormat::Pi | WorkspaceHistoryFormat::PrimeAgent => {
            project_pi_history(source_name, &bytes, Path::new(&header_cwd))?
        }
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

fn project_pi_history(
    source_name: &str,
    bytes: &[u8],
    display_project_root: &Path,
) -> Result<WorkspaceHistoryProjection, WorkspaceHistoryError> {
    let report = scan_bytes_for_display_with_root(source_name, bytes, Some(display_project_root));
    if report.partial_tail_bytes != 0 {
        return Err(WorkspaceHistoryError::PartialTail);
    }
    if let Some(diagnostic) = report.diagnostics.first() {
        return Err(WorkspaceHistoryError::MalformedRecord {
            line: diagnostic.line,
        });
    }
    let exact = exact_pi_assistant_texts(bytes)?;
    let block_ids = report
        .timeline_blocks
        .iter()
        .filter(|block| block.kind == GenericBlockKind::Assistant)
        .map(|block| block.id.clone())
        .collect::<Vec<_>>();
    let assistant_texts = block_ids
        .into_iter()
        .zip(exact)
        .map(|(block_id, text)| AssistantHistoryText {
            sha256: sha256(text.as_bytes()),
            block_id,
            text,
        })
        .collect();
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts,
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

struct CodexProjectionBuilder<'a> {
    project_root: &'a Path,
    blocks: Vec<GenericTimelineBlock>,
    assistants: Vec<AssistantHistoryText>,
    tools: HashMap<String, usize>,
    unknown_entries: Vec<UnknownEntrySummary>,
    last_visible: Option<(GenericBlockKind, String, CodexTextSource)>,
    image_entry_count: usize,
    compaction_entry_count: usize,
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
            unknown_entries: Vec::new(),
            last_visible: None,
            image_entry_count: 0,
            compaction_entry_count: 0,
        }
    }

    fn push_text(
        &mut self,
        kind: GenericBlockKind,
        source_type: &str,
        created_at: Option<String>,
        text: String,
        source: CodexTextSource,
    ) {
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
            self.last_visible = Some((kind, text, source));
            return;
        }
        let id = format!("timeline-{}", self.blocks.len());
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
                sha256: sha256(text.as_bytes()),
                text: text.clone(),
            });
        }
        self.last_visible = Some((kind, text, source));
    }

    /// Marks the user block pushed since `before` (if any) as carrying an
    /// image; the image itself is never projected.
    fn mark_user_image(&mut self, before: usize) {
        if self.blocks.len() > before
            && let Some(block) = self.blocks.last_mut()
            && block.kind == GenericBlockKind::User
        {
            block.has_image = true;
        }
    }

    fn push_tool(&mut self, created_at: Option<String>, name: Option<&str>, call_id: Option<&str>) {
        let id = format!("timeline-{}", self.blocks.len());
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
            title: title.clone(),
            tool_name: title,
            collapsible: true,
            truncated: false,
            fallback: false,
            status: GenericBlockStatus::Running,
        });
        if let Some(call_id) = call_id {
            self.tools.insert(call_id.to_owned(), index);
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
            block.status = if failed {
                GenericBlockStatus::Failed
            } else {
                GenericBlockStatus::Complete
            };
        } else {
            let id = format!("timeline-{}", self.blocks.len());
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

    fn push_compaction(&mut self, created_at: Option<String>, text: Option<String>) {
        let id = format!("timeline-{}", self.blocks.len());
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
        let id = format!("timeline-{}", self.blocks.len());
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Unknown,
            source_type: "codex_unknown".into(),
            created_at,
            preview: None,
            has_image: false,
            title: Some("Unrecognized session entry".into()),
            tool_name: None,
            collapsible: true,
            truncated: false,
            fallback: true,
            status: GenericBlockStatus::Complete,
        });
        self.last_visible = None;
    }
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
            ),
            // These are source controls or potentially sensitive execution
            // context, never user-visible transcript blocks.
            (
                "session_meta"
                | "turn_context"
                | "world_state"
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
    report.timeline_blocks = builder.blocks;
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts: builder.assistants,
    })
}

fn project_codex_response_item(
    builder: &mut CodexProjectionBuilder<'_>,
    line: u64,
    frame: &[u8],
    payload: &Map<String, Value>,
    created_at: Option<String>,
) {
    let item_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    match item_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str);
            // System/developer records contain native instructions and runtime
            // context. They are never transcript content.
            if matches!(role, Some("system" | "developer")) {
                return;
            }
            let (text, has_image) = codex_message_content(payload.get("content"));
            builder.image_entry_count = builder
                .image_entry_count
                .saturating_add(usize::from(has_image));
            let Some(text) = text else { return };
            match role {
                Some("user") => {
                    let before = builder.blocks.len();
                    builder.push_text(
                        GenericBlockKind::User,
                        "codex_response_message",
                        created_at,
                        text,
                        CodexTextSource::Response,
                    );
                    if has_image {
                        builder.mark_user_image(before);
                    }
                }
                Some("assistant") => builder.push_text(
                    GenericBlockKind::Assistant,
                    "codex_response_message",
                    created_at,
                    text,
                    CodexTextSource::Response,
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
                );
            }
            // encrypted_content and raw reasoning content are deliberately ignored.
        }
        "function_call" | "custom_tool_call" => builder.push_tool(
            created_at,
            payload.get("name").and_then(Value::as_str),
            payload.get("call_id").and_then(Value::as_str),
        ),
        "local_shell_call" => builder.push_tool(
            created_at,
            Some("Command"),
            payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str),
        ),
        "function_call_output" | "custom_tool_call_output" => {
            let output = codex_tool_output(payload.get("output"));
            builder.finish_tool(
                payload.get("call_id").and_then(Value::as_str),
                output,
                false,
            );
        }
        "web_search_call" => builder.push_tool(
            created_at,
            Some("Web search"),
            payload.get("id").and_then(Value::as_str),
        ),
        // Compaction ciphertext and tool declarations contain no readable
        // transcript text and can include private native configuration.
        "compaction"
        | "context_compaction"
        | "additional_tools"
        | "tool_search_call"
        | "tool_search_output"
        | "image_generation_call" => {}
        _ => builder.push_unknown(line, frame, "response_item", created_at),
    }
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
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                builder.push_text(
                    GenericBlockKind::User,
                    "codex_user_message",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
                );
            }
            let has_image = payload
                .get("images")
                .and_then(Value::as_array)
                .is_some_and(|images| !images.is_empty())
                || payload
                    .get("local_images")
                    .and_then(Value::as_array)
                    .is_some_and(|images| !images.is_empty());
            builder.image_entry_count = builder
                .image_entry_count
                .saturating_add(usize::from(has_image));
            if has_image {
                builder.mark_user_image(before);
            }
        }
        "agent_message" => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                builder.push_text(
                    GenericBlockKind::Assistant,
                    "codex_agent_message",
                    created_at,
                    text.to_owned(),
                    CodexTextSource::Event,
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
                );
            }
        }
        // Raw chain-of-thought is not a user-facing reasoning summary.
        "agent_reasoning_raw_content" | "agent_reasoning_section_break" => {}
        "exec_command_begin" => builder.push_tool(
            created_at,
            Some("Command"),
            payload.get("call_id").and_then(Value::as_str),
        ),
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
            builder.push_tool(
                created_at,
                name,
                payload.get("call_id").and_then(Value::as_str),
            );
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
        "context_compacted" => builder.push_compaction(created_at, None),
        // Known lifecycle/settings/error events get no content block. Error
        // payloads can include native environment or provider details.
        "task_started"
        | "turn_started"
        | "task_complete"
        | "turn_complete"
        | "token_count"
        | "session_configured"
        | "thread_settings_applied"
        | "error"
        | "warning"
        | "mcp_startup_update"
        | "mcp_startup_complete" => {}
        _ => builder.push_unknown(line, frame, "event_msg", created_at),
    }
}

fn codex_message_content(content: Option<&Value>) -> (Option<String>, bool) {
    let Some(items) = content.and_then(Value::as_array) else {
        return (None, false);
    };
    let mut texts = Vec::new();
    let mut has_image = false;
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    texts.push(text);
                }
            }
            Some("input_image" | "input_audio") => has_image = true,
            _ => {}
        }
    }
    let text = texts.join("\n");
    ((!text.is_empty()).then_some(text), has_image)
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
            ),
            "tool" => {
                let id = format!("hermes-tool-{}", builder.blocks.len());
                builder.push_tool(None, tool.as_deref(), Some(&id));
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
        has_image: bool,
    },
    Assistant(Vec<ClaudeAssistantPart>),
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
    Text(String),
    Thinking(String),
    ToolUse { id: String, name: Option<String> },
    Unsupported(String),
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

/// Claude Code's own rule for internal user entries: command wrappers,
/// reminders and notifications start with a lowercase tag, and interrupt
/// markers are bracketed. Neither is a user prompt.
fn is_internal_claude_text(text: &str) -> bool {
    if let Some(rest) = text.trim_start().strip_prefix('<') {
        let mut characters = rest.chars();
        if !characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        {
            return false;
        }
        for character in characters {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                continue;
            }
            return character.is_whitespace() || character == '>';
        }
        return false;
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
    let mut has_image = false;
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
                    Some("image") => has_image = true,
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
        has_image,
    }
}

fn claude_assistant_content(message: &Map<String, Value>) -> ClaudeEntryContent {
    let mut parts = Vec::new();
    for part in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
    {
        let text_of = |key: &str| {
            part.get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => parts.extend(text_of("text").map(ClaudeAssistantPart::Text)),
            Some("thinking") => {
                parts.extend(text_of("thinking").map(ClaudeAssistantPart::Thinking));
            }
            Some("tool_use") => {
                if let Some(id) = part.get("id").and_then(Value::as_str) {
                    parts.push(ClaudeAssistantPart::ToolUse {
                        id: id.to_owned(),
                        name: part.get("name").and_then(Value::as_str).map(str::to_owned),
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
    ClaudeEntryContent::Assistant(parts)
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
            let id = format!("timeline-{}", self.blocks.len());
            self.blocks.push(GenericTimelineBlock {
                id,
                parent_id: None,
                kind: GenericBlockKind::Unknown,
                source_type: "claude_unknown".into(),
                created_at,
                preview: None,
                has_image: false,
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

    fn push_claude_notice(&mut self, created_at: Option<String>) {
        let id = format!("timeline-{}", self.blocks.len());
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Custom,
            source_type: "claude_api_error".into(),
            created_at,
            preview: Some(CLAUDE_API_ERROR_NOTICE.into()),
            has_image: false,
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
    fn push_claude_history_notice(&mut self) {
        let id = format!("timeline-{}", self.blocks.len());
        self.blocks.push(GenericTimelineBlock {
            id,
            parent_id: None,
            kind: GenericBlockKind::Custom,
            source_type: "claude_history_trimmed".into(),
            created_at: None,
            preview: Some(CLAUDE_HISTORY_TRIMMED_NOTICE.into()),
            has_image: false,
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
        ClaudeEntryContent::Assistant(parts) => parts
            .iter()
            .map(|part| match part {
                ClaudeAssistantPart::Text(text) | ClaudeAssistantPart::Thinking(text) => text.len(),
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
                ClaudeEntryContent::User { text: Some(_), .. }
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
        builder.push_claude_history_notice();
        for &index in &chain[..first_kept] {
            match &entries[index].content {
                ClaudeEntryContent::User {
                    text, has_image, ..
                } => {
                    builder.image_entry_count = builder
                        .image_entry_count
                        .saturating_add(usize::from(*has_image));
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
                has_image,
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
                builder.image_entry_count = builder
                    .image_entry_count
                    .saturating_add(usize::from(*has_image));
                if let Some(text) = text {
                    let before = builder.blocks.len();
                    builder.push_text(
                        GenericBlockKind::User,
                        "claude_user",
                        at,
                        text.clone(),
                        CodexTextSource::Response,
                    );
                    if *has_image {
                        builder.mark_user_image(before);
                    }
                }
            }
            ClaudeEntryContent::Assistant(parts) => {
                for part in parts {
                    match part {
                        ClaudeAssistantPart::Text(text) => builder.push_text(
                            GenericBlockKind::Assistant,
                            "claude_assistant",
                            at.clone(),
                            text.clone(),
                            CodexTextSource::Response,
                        ),
                        ClaudeAssistantPart::Thinking(text) => builder.push_text(
                            GenericBlockKind::Thinking,
                            "claude_thinking",
                            at.clone(),
                            text.clone(),
                            CodexTextSource::Response,
                        ),
                        ClaudeAssistantPart::ToolUse { id, name } => {
                            builder.push_tool(at.clone(), name.as_deref(), Some(id));
                        }
                        ClaudeAssistantPart::Unsupported(kind) => builder.push_claude_unknown(
                            &mut shown_unknown,
                            unknown_summary(entry.line, kind, b""),
                            at.clone(),
                        ),
                    }
                }
            }
            ClaudeEntryContent::ApiError => builder.push_claude_notice(at),
            ClaudeEntryContent::Compaction => builder.push_compaction(at, None),
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
    report.timeline_blocks = builder.blocks;
    Ok(WorkspaceHistoryProjection {
        report,
        assistant_texts: builder.assistants,
    })
}
