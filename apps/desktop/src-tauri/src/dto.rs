//! Serialization-only DTOs for the WebView boundary.
//!
//! These structures intentionally contain safe display text and opaque IDs;
//! host paths, SQLite handles, process handles, raw Pi JSON and credentials do
//! not cross this module.

use piui_index::{
    AgentKind, ChatWidthPreference, DensityPreference, FontSizePreference, GenericBlockKind,
    GenericBlockStatus, GenericTimelineBlock, ParseState, Preferences, ProjectSummary,
    ReducedMotionPreference, SessionSummary, SessionTreeNode, ThemePreference, TitleSource,
    TrustState, redact_display_text,
};
use piui_runtime::{
    LifecycleState, RuntimeEventEnvelope, SessionStateLite, SurfaceEvent,
    SystemPiDiagnosticEligibility,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSnapshotV8 {
    pub app_version: &'static str,
    pub safe_mode: bool,
    pub preferences: ApiPreferences,
    pub projects: Vec<ApiProjectSummaryV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSnapshot {
    pub app_version: &'static str,
    pub safe_mode: bool,
    pub preferences: ApiPreferences,
    pub projects: Vec<ApiProjectSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiPreferences {
    pub theme: &'static str,
    pub density: &'static str,
    pub reduced_motion: &'static str,
    pub font_size: &'static str,
    pub chat_width: &'static str,
}

impl From<Preferences> for ApiPreferences {
    fn from(value: Preferences) -> Self {
        Self {
            theme: match value.theme {
                ThemePreference::System => "system",
                ThemePreference::Dark => "dark",
                ThemePreference::Light => "light",
            },
            density: match value.density {
                DensityPreference::Comfortable => "comfortable",
                DensityPreference::Compact => "compact",
            },
            reduced_motion: match value.reduced_motion {
                ReducedMotionPreference::System => "system",
                ReducedMotionPreference::Reduce => "reduce",
            },
            font_size: match value.font_size {
                FontSizePreference::Small => "small",
                FontSizePreference::Medium => "medium",
                FontSizePreference::Large => "large",
            },
            chat_width: match value.chat_width {
                ChatWidthPreference::Wide => "wide",
                ChatWidthPreference::Centered => "centered",
                ChatWidthPreference::Focused => "focused",
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProjectSummaryV2 {
    pub id: String,
    pub name: String,
    pub display_path: String,
    pub trust_state: &'static str,
    pub pinned: bool,
    pub missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
}

impl From<ProjectSummary> for ApiProjectSummaryV2 {
    fn from(value: ProjectSummary) -> Self {
        Self {
            id: value.id,
            name: value.name,
            display_path: value.display_path,
            trust_state: trust_state(value.trust_state),
            pinned: value.pinned,
            missing: value.missing,
            last_opened_at: value.last_opened_at.map(|time| time.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProjectSummary {
    pub id: String,
    pub name: String,
    pub display_path: String,
    pub agent_kind: &'static str,
    pub trust_state: &'static str,
    pub pinned: bool,
    pub missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
}

impl From<ProjectSummary> for ApiProjectSummary {
    fn from(value: ProjectSummary) -> Self {
        Self {
            id: value.id,
            name: value.name,
            display_path: value.display_path,
            agent_kind: match value.agent_kind {
                AgentKind::Pi => "pi",
                AgentKind::PrimeAgent => "prime-agent",
            },
            trust_state: trust_state(value.trust_state),
            pinned: value.pinned,
            missing: value.missing,
            last_opened_at: value.last_opened_at.map(|time| time.to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiExtensionSummary {
    pub id: String,
    pub name: String,
    pub source: &'static str,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiExtensionSummaryV10 {
    pub id: String,
    pub agent_kind: &'static str,
    pub name: String,
    pub source: &'static str,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSessionSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    pub title_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub entry_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_count: Option<usize>,
    pub parse_state: &'static str,
}

impl From<SessionSummary> for ApiSessionSummary {
    fn from(value: SessionSummary) -> Self {
        Self {
            id: value.id,
            project_id: value.project_id,
            title: redact_display_text(&value.title),
            title_source: title_source(value.title_source),
            created_at: value.created_at,
            updated_at: value.updated_at,
            preview: value.preview.map(|preview| redact_display_text(&preview)),
            entry_count: value.entry_count,
            branch_count: value.branch_count,
            parse_state: parse_state(value.parse_state),
        }
    }
}

/// Display-safe snapshot of the rebuildable sidebar catalog. `sequence` is a
/// host-generated watermark, not a JSONL revision or filesystem token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSessionCatalogSnapshot {
    pub protocol: u8,
    /// `project` exposes an already-opaque project id; `personal` deliberately
    /// omits the host-owned backing workspace id.
    pub scope: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub sequence: u64,
    pub freshness: &'static str,
    pub sessions: Vec<ApiSessionSummary>,
}

/// Versioned catalog events are intentionally separate from high-frequency Pi
/// runtime events. They carry only opaque ids and display-safe summaries.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiSessionCatalogEvent {
    RefreshStarted {
        protocol: u8,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        sequence: u64,
    },
    Snapshot {
        protocol: u8,
        snapshot: ApiSessionCatalogSnapshot,
    },
    RefreshFailed {
        protocol: u8,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        sequence: u64,
        /// Fixed, content-free user-facing summary. Never use raw I/O errors.
        safe_summary: &'static str,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiTimelineStatus {
    Complete,
    Streaming,
    Failed,
    Interrupted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTimelineBlock {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub collapsible: bool,
    pub truncated: bool,
    pub fallback: bool,
    pub status: ApiTimelineStatus,
}

impl From<&GenericTimelineBlock> for ApiTimelineBlock {
    fn from(value: &GenericTimelineBlock) -> Self {
        let (kind, label) = block_kind(value.kind);
        let text = value.preview.clone();
        let has_text = text.is_some();
        Self {
            id: value.id.clone(),
            parent_id: value.parent_id.clone(),
            kind,
            created_at: value.created_at.clone(),
            text,
            label,
            safe_summary: if !has_text && value.truncated {
                Some("Earlier content was omitted by the bounded session projection.".to_owned())
            } else if !has_text
                && !matches!(
                    value.kind,
                    GenericBlockKind::User | GenericBlockKind::Assistant
                )
            {
                Some(safe_block_summary(value.kind).to_owned())
            } else {
                None
            },
            title: value.title.clone(),
            tool_name: value.tool_name.clone(),
            collapsible: value.collapsible,
            truncated: value.truncated,
            fallback: value.fallback,
            status: block_status(value.status),
        }
    }
}

const MAX_TREE_RENDER_ROWS: usize = 8_000;
const MAX_TREE_RENDER_DEPTH: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTimelinePage {
    pub projection_version: u8,
    pub session_id: String,
    pub blocks: Vec<ApiTimelineBlock>,
    pub tree: ApiSessionTree,
    pub file_revision: String,
    pub range_start: usize,
    pub total_blocks: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub older_cursor: Option<String>,
    pub stale_cursor: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSessionTree {
    /// A depth-first, flat projection. Keeping this flat avoids recursive Rust
    /// construction and recursive WebView rendering for hostile/deep history.
    pub nodes: Vec<ApiTreeNode>,
    pub diagnostic_count: usize,
    pub navigation_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTreeNode {
    pub entry_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub label: String,
    pub kind: String,
    pub depth: usize,
    pub is_current_path: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<&'static str>,
}

pub fn api_tree(
    nodes: &[SessionTreeNode],
    roots: &[String],
    current_leaf_id: Option<&str>,
    diagnostic_count: usize,
    orphan_ids: &[String],
    cycle_ids: &[String],
) -> ApiSessionTree {
    let nodes_by_id: BTreeMap<&str, &SessionTreeNode> = nodes
        .iter()
        .map(|node| (node.entry_id.as_str(), node))
        .collect();
    let mut current_path = BTreeSet::new();
    let mut cursor = current_leaf_id;
    while let Some(id) = cursor {
        if !current_path.insert(id.to_owned()) {
            break;
        }
        cursor = nodes_by_id
            .get(id)
            .and_then(|node| node.parent_id.as_deref());
    }

    let orphan_ids: BTreeSet<&str> = orphan_ids.iter().map(String::as_str).collect();
    let cycle_ids: BTreeSet<&str> = cycle_ids.iter().map(String::as_str).collect();
    let mut stack: Vec<(&str, usize)> = roots
        .iter()
        .rev()
        .map(|id| (id.as_str(), 0_usize))
        .collect();
    let mut emitted = BTreeSet::new();
    let mut flattened = Vec::new();
    let mut extra_diagnostics = 0_usize;

    while let Some((id, depth)) = stack.pop() {
        if flattened.len() >= MAX_TREE_RENDER_ROWS {
            extra_diagnostics = extra_diagnostics.saturating_add(1);
            break;
        }
        let Some(node) = nodes_by_id.get(id) else {
            extra_diagnostics = extra_diagnostics.saturating_add(1);
            continue;
        };
        if !emitted.insert(id.to_owned()) {
            extra_diagnostics = extra_diagnostics.saturating_add(1);
            continue;
        }
        let issue = if cycle_ids.contains(id) {
            Some("cycle")
        } else if orphan_ids.contains(id) {
            Some("orphan")
        } else if depth >= MAX_TREE_RENDER_DEPTH {
            Some("depth-limit")
        } else {
            None
        };
        flattened.push(ApiTreeNode {
            entry_id: node.entry_id.clone(),
            parent_id: node.parent_id.clone(),
            label: node.entry_id.clone(),
            kind: "entry".to_owned(),
            depth,
            is_current_path: current_path.contains(id),
            issue,
        });
        if depth >= MAX_TREE_RENDER_DEPTH {
            extra_diagnostics = extra_diagnostics.saturating_add(1);
            continue;
        }
        for child in node.children.iter().rev() {
            stack.push((child.as_str(), depth.saturating_add(1)));
        }
    }

    ApiSessionTree {
        nodes: flattened,
        diagnostic_count: diagnostic_count.saturating_add(extra_diagnostics),
        navigation_supported: false,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRuntimeSnapshot {
    pub runtime_id: String,
    pub agent_kind: &'static str,
    pub state: &'static str,
    pub revision: u64,
    pub capabilities: ApiRuntimeCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiRuntimeCapabilities {
    pub rpc: bool,
    #[serde(rename = "session.tree.read")]
    pub session_tree_read: bool,
    #[serde(rename = "session.tree.navigate")]
    pub session_tree_navigate: bool,
    #[serde(rename = "auth.headless")]
    pub auth_headless: bool,
    #[serde(rename = "ui.standardDialogs")]
    pub ui_standard_dialogs: bool,
    #[serde(rename = "prime.activity")]
    pub prime_activity: bool,
    #[serde(rename = "runtime.liveAttach")]
    pub live_attach: bool,
    #[serde(rename = "runtime.residentSessions")]
    pub resident_sessions: bool,
    #[serde(rename = "runtime.eventReplay")]
    pub event_replay: bool,
    #[serde(rename = "runtime.multiClient")]
    pub multi_client: bool,
    #[serde(rename = "thinking.catalog")]
    pub thinking_catalog: bool,
}

pub fn runtime_snapshot_named(
    runtime_id: &str,
    state: LifecycleState,
    revision: u64,
    summary: Option<String>,
) -> ApiRuntimeSnapshot {
    runtime_snapshot_named_for_kind(runtime_id, AgentKind::Pi, state, revision, summary)
}

pub fn runtime_snapshot_named_for_kind(
    runtime_id: &str,
    agent_kind: AgentKind,
    state: LifecycleState,
    revision: u64,
    summary: Option<String>,
) -> ApiRuntimeSnapshot {
    let prime = agent_kind == AgentKind::PrimeAgent;
    ApiRuntimeSnapshot {
        runtime_id: runtime_id.to_owned(),
        agent_kind: if prime { "prime-agent" } else { "pi" },
        state: runtime_state(state),
        revision,
        capabilities: ApiRuntimeCapabilities {
            rpc: true,
            session_tree_read: true,
            session_tree_navigate: false,
            auth_headless: false,
            // PiUI routes bounded standard extension dialogs through a
            // host-owned mailbox; custom TUI components remain unsupported.
            ui_standard_dialogs: true,
            prime_activity: prime,
            // v10 Prime is an owned stdio worker. Daemon attach/replay and
            // background continuity are intentionally not advertised.
            live_attach: false,
            resident_sessions: false,
            event_replay: false,
            multi_client: false,
            thinking_catalog: !prime,
        },
        safe_summary: summary,
    }
}

pub fn runtime_snapshot(
    state: LifecycleState,
    revision: u64,
    summary: Option<String>,
) -> ApiRuntimeSnapshot {
    let mut snapshot = runtime_snapshot_named("fake-runtime", state, revision, summary);
    // The deterministic fixture has no extension-dialog bridge at all; its
    // historical contract advertises the fake capability for UI smoke tests.
    snapshot.capabilities.ui_standard_dialogs = true;
    snapshot
}

/// v10 host projection of a runtime session state. Prime's native handshake
/// id stays in the runtime/index layer; the WebView receives the correlated
/// opaque catalog id or no id. Ordinary Pi keeps its legacy state shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSessionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    pub message_count: usize,
    pub pending_message_count: usize,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub auto_compaction_enabled: bool,
    pub steering_mode: String,
    pub follow_up_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<piui_runtime::ModelLite>,
    pub thinking_level: String,
}

impl ApiSessionState {
    #[must_use]
    pub fn project(
        agent_kind: AgentKind,
        opaque_session_id: Option<String>,
        state: SessionStateLite,
    ) -> Self {
        let session_id = if agent_kind == AgentKind::PrimeAgent {
            opaque_session_id
        } else {
            // Preserve the frozen Pi/v9 session-state JSON shape.
            Some(state.session_id)
        };
        Self {
            session_id,
            session_name: state.session_name,
            message_count: state.message_count,
            pending_message_count: state.pending_message_count,
            is_streaming: state.is_streaming,
            is_compacting: state.is_compacting,
            auto_compaction_enabled: state.auto_compaction_enabled,
            steering_mode: state.steering_mode,
            follow_up_mode: state.follow_up_mode,
            model: state.model,
            thinking_level: state.thinking_level,
        }
    }
}

/// Result of starting a live runtime.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRuntimeStart {
    pub runtime: ApiRuntimeSnapshot,
    pub runtime_id: String,
    pub agent_kind: &'static str,
    pub launch_label: String,
    /// Host-projected state captured from the startup `get_state` handshake.
    pub session_state: ApiSessionState,
    /// PiUI's opaque indexed id for a continued session or a newly bound Prime
    /// project session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Host-only serialization projection for `piui://runtime-event`. It reuses
/// the runtime's envelope invariants, then replaces a Prime state snapshot's
/// native id with the opaque catalog id before it reaches the WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRuntimeEventEnvelope {
    pub protocol: u8,
    pub runtime_id: String,
    pub agent_kind: AgentKind,
    pub scope: piui_runtime::real_rpc::RuntimeEventScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub event: ApiSurfaceEvent,
}

/// The one event arm that can carry a session id gets a typed host projection.
/// Other runtime events already have their own safe serialization projection.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ApiSurfaceEvent {
    StateSnapshot {
        kind: &'static str,
        state: ApiSessionState,
        revision: u64,
    },
    Other(SurfaceEvent),
}

impl From<RuntimeEventEnvelope> for ApiRuntimeEventEnvelope {
    fn from(value: RuntimeEventEnvelope) -> Self {
        let agent_kind = value.agent_kind;
        let session_id = value.session_id;
        let event = match value.event {
            SurfaceEvent::StateSnapshot { state, revision } => ApiSurfaceEvent::StateSnapshot {
                kind: "stateSnapshot",
                state: ApiSessionState::project(agent_kind, session_id.clone(), state),
                revision,
            },
            event => ApiSurfaceEvent::Other(event),
        };
        Self {
            protocol: value.protocol,
            runtime_id: value.runtime_id,
            agent_kind,
            scope: value.scope,
            project_id: value.project_id,
            session_id,
            event,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFakeScenarioResult {
    pub runtime: ApiRuntimeSnapshot,
    pub blocks: Vec<ApiTimelineBlock>,
    /// These blocks are a local deterministic overlay, never Pi session entries.
    pub ephemeral: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSystemPiProbe {
    /// Static eligibility only; this does not mean Pi was launched or probed.
    pub eligibility: &'static str,
    pub managed_runtime_required: bool,
    /// Pi authentication remains intentionally external/interactive.
    pub external_auth_guidance: bool,
}

impl From<SystemPiDiagnosticEligibility> for ApiSystemPiProbe {
    fn from(value: SystemPiDiagnosticEligibility) -> Self {
        let eligibility = match value {
            SystemPiDiagnosticEligibility::CandidateUnverified => "candidate_unverified",
            SystemPiDiagnosticEligibility::ManagedRuntimeRequired => "managed_runtime_required",
        };
        Self {
            eligibility,
            managed_runtime_required: value.requires_managed_runtime(),
            external_auth_guidance: true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub recoverable: bool,
}

fn trust_state(value: TrustState) -> &'static str {
    match value {
        TrustState::Unknown => "unknown",
        TrustState::Trusted => "trusted",
        TrustState::Restricted => "restricted",
    }
}

fn title_source(value: TitleSource) -> &'static str {
    match value {
        TitleSource::PiName => "pi-name",
        TitleSource::FirstUserMessage => "first-user-message",
        TitleSource::DateId => "date-id",
        TitleSource::UiAlias => "ui-alias",
    }
}

fn parse_state(value: ParseState) -> &'static str {
    match value {
        ParseState::Healthy => "healthy",
        ParseState::Partial => "partial",
        ParseState::Unsupported => "unsupported",
        ParseState::Corrupt => "corrupt",
    }
}

fn block_status(value: GenericBlockStatus) -> ApiTimelineStatus {
    match value {
        GenericBlockStatus::Complete => ApiTimelineStatus::Complete,
        GenericBlockStatus::Running => ApiTimelineStatus::Streaming,
        GenericBlockStatus::Failed => ApiTimelineStatus::Failed,
        GenericBlockStatus::Interrupted => ApiTimelineStatus::Interrupted,
    }
}

fn block_kind(value: GenericBlockKind) -> (&'static str, &'static str) {
    match value {
        GenericBlockKind::User => ("user", "You"),
        GenericBlockKind::Assistant => ("assistant", "Pi"),
        GenericBlockKind::Thinking => ("thinking", "Reasoning"),
        GenericBlockKind::Tool => ("tool", "Tool activity"),
        GenericBlockKind::Custom => ("custom", "Extension message"),
        GenericBlockKind::Compaction => ("compaction", "Context compacted"),
        GenericBlockKind::Unknown => ("unknown", "Unrecognized session entry"),
    }
}

fn safe_block_summary(value: GenericBlockKind) -> &'static str {
    match value {
        GenericBlockKind::Thinking => "Reasoning entry retained in the read-only projection.",
        GenericBlockKind::Tool => "Tool activity retained in the read-only projection.",
        GenericBlockKind::Custom => "Extension entry is available through the generic fallback.",
        GenericBlockKind::Compaction => "The session records a context compaction boundary.",
        GenericBlockKind::Unknown => {
            "An unsupported entry is retained through the generic fallback."
        }
        GenericBlockKind::User | GenericBlockKind::Assistant => "",
    }
}

fn runtime_state(value: LifecycleState) -> &'static str {
    match value {
        LifecycleState::Dormant => "dormant",
        LifecycleState::Starting => "starting",
        LifecycleState::Ready => "ready",
        LifecycleState::Running => "running",
        LifecycleState::Recovering => "recovering",
        LifecycleState::Stopping => "stopping",
        LifecycleState::Failed => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ApiExtensionSummary, ApiExtensionSummaryV10, ApiPreferences, ApiProjectSummary,
        ApiProjectSummaryV2, ApiRuntimeEventEnvelope, ApiRuntimeStart, ApiSessionState,
        MAX_TREE_RENDER_DEPTH, MAX_TREE_RENDER_ROWS, api_tree, runtime_snapshot_named_for_kind,
    };
    use piui_index::{
        AgentKind, ChatWidthPreference, DensityPreference, FontSizePreference, Preferences,
        ProjectSummary, ReducedMotionPreference, SessionTreeNode, ThemePreference, TrustState,
    };
    use piui_runtime::{LifecycleState, RuntimeEventEnvelope, SessionStateLite, SurfaceEvent};

    #[test]
    fn v10_extensions_add_runtime_kind_without_changing_the_legacy_shape() {
        let legacy = serde_json::to_value(ApiExtensionSummary {
            id: "ext-legacy".into(),
            name: "Legacy".into(),
            source: "Global",
            enabled: true,
        })
        .expect("serializes legacy extension");
        let v10 = serde_json::to_value(ApiExtensionSummaryV10 {
            id: "ext-v10".into(),
            agent_kind: "prime-agent",
            name: "Prime".into(),
            source: "Global",
            enabled: true,
        })
        .expect("serializes v10 extension");
        assert!(legacy.get("agentKind").is_none());
        assert_eq!(v10["agentKind"], "prime-agent");
    }

    #[test]
    fn appearance_preferences_are_serialized_as_a_path_free_v8_projection() {
        let preferences = ApiPreferences::from(Preferences {
            theme: ThemePreference::Dark,
            density: DensityPreference::Compact,
            reduced_motion: ReducedMotionPreference::Reduce,
            font_size: FontSizePreference::Large,
            chat_width: ChatWidthPreference::Centered,
        });

        let value = serde_json::to_value(preferences).expect("serializes preferences");
        assert_eq!(value["fontSize"], "large");
        assert_eq!(value["chatWidth"], "centered");
        assert!(value.get("path").is_none());
    }

    #[test]
    fn v10_project_and_runtime_dtos_expose_kind_without_overclaiming_prime_capabilities() {
        let project = ApiProjectSummary::from(ProjectSummary {
            id: "project".into(),
            name: "Prime project".into(),
            display_path: "…/Prime project".into(),
            agent_kind: AgentKind::PrimeAgent,
            trust_state: TrustState::Restricted,
            pinned: false,
            missing: false,
            last_opened_at: None,
        });
        let prime = runtime_snapshot_named_for_kind(
            "runtime",
            AgentKind::PrimeAgent,
            LifecycleState::Ready,
            1,
            None,
        );
        let pi = runtime_snapshot_named_for_kind(
            "pi-runtime",
            AgentKind::Pi,
            LifecycleState::Ready,
            1,
            None,
        );

        assert_eq!(project.agent_kind, "prime-agent");
        let legacy_project = ApiProjectSummaryV2 {
            id: project.id.clone(),
            name: project.name.clone(),
            display_path: project.display_path.clone(),
            trust_state: project.trust_state,
            pinned: project.pinned,
            missing: project.missing,
            last_opened_at: project.last_opened_at.clone(),
        };
        let legacy_json = serde_json::to_value(legacy_project).expect("serializes v8 project");
        assert!(legacy_json.get("agentKind").is_none());
        let project_json = serde_json::to_value(&project).expect("serializes v10 project");
        assert_eq!(project_json["agentKind"], "prime-agent");
        assert_eq!(prime.agent_kind, "prime-agent");
        assert!(prime.capabilities.prime_activity);
        assert!(!prime.capabilities.thinking_catalog);
        assert!(!prime.capabilities.live_attach);
        assert!(!prime.capabilities.resident_sessions);
        assert!(!prime.capabilities.event_replay);
        assert!(!prime.capabilities.multi_client);
        assert_eq!(pi.agent_kind, "pi");
        assert!(!pi.capabilities.prime_activity);
        assert!(pi.capabilities.thinking_catalog);
    }

    #[test]
    fn v10_prime_session_state_projections_hide_native_handshake_ids() {
        const NATIVE_ID: &str = "sentinel-native-id";
        const OPAQUE_ID: &str = "opaque-catalog-id";
        let state = || SessionStateLite {
            session_id: NATIVE_ID.into(),
            session_name: Some("Session".into()),
            message_count: 3,
            pending_message_count: 0,
            is_streaming: false,
            is_compacting: false,
            auto_compaction_enabled: true,
            steering_mode: "all".into(),
            follow_up_mode: "all".into(),
            model: None,
            thinking_level: "medium".into(),
        };
        let prime_start = ApiRuntimeStart {
            runtime: runtime_snapshot_named_for_kind(
                "prime-runtime",
                AgentKind::PrimeAgent,
                LifecycleState::Ready,
                1,
                None,
            ),
            runtime_id: "prime-runtime".into(),
            agent_kind: "prime-agent",
            launch_label: "test Prime".into(),
            session_state: ApiSessionState::project(
                AgentKind::PrimeAgent,
                Some(OPAQUE_ID.into()),
                state(),
            ),
            session_id: Some(OPAQUE_ID.into()),
        };
        let prime_start_json =
            serde_json::to_value(prime_start).expect("serializes v10 Prime start projection");
        assert_eq!(prime_start_json["sessionState"]["sessionId"], OPAQUE_ID);
        assert_eq!(prime_start_json["sessionId"], OPAQUE_ID);
        assert!(!prime_start_json.to_string().contains(NATIVE_ID));

        let prime_event = ApiRuntimeEventEnvelope::from(RuntimeEventEnvelope::new_for_kind(
            "prime-runtime".into(),
            AgentKind::PrimeAgent,
            Some("project".into()),
            Some(OPAQUE_ID.into()),
            SurfaceEvent::StateSnapshot {
                state: state(),
                revision: 2,
            },
        ));
        let prime_event_json =
            serde_json::to_value(prime_event).expect("serializes v10 Prime state snapshot");
        assert_eq!(prime_event_json["state"]["sessionId"], OPAQUE_ID);
        assert!(!prime_event_json.to_string().contains(NATIVE_ID));

        let unbound_prime = serde_json::to_value(ApiSessionState::project(
            AgentKind::PrimeAgent,
            None,
            state(),
        ))
        .expect("serializes unbound Prime state projection");
        assert!(unbound_prime.get("sessionId").is_none());
        assert!(!unbound_prime.to_string().contains(NATIVE_ID));

        let legacy_pi =
            serde_json::to_value(ApiRuntimeEventEnvelope::from(RuntimeEventEnvelope::new(
                "pi-runtime".into(),
                Some("project".into()),
                Some("opaque-pi-session".into()),
                SurfaceEvent::StateSnapshot {
                    state: state(),
                    revision: 3,
                },
            )))
            .expect("serializes legacy Pi state snapshot");
        assert_eq!(legacy_pi["state"]["sessionId"], NATIVE_ID);
    }

    #[test]
    fn tree_dto_flattens_a_deep_chain_with_a_hard_depth_budget() {
        let total = MAX_TREE_RENDER_DEPTH + 20;
        let nodes: Vec<_> = (0..total)
            .map(|index| SessionTreeNode {
                entry_id: format!("entry-{index}"),
                parent_id: (index > 0).then(|| format!("entry-{}", index - 1)),
                children: if index + 1 < total {
                    vec![format!("entry-{}", index + 1)]
                } else {
                    Vec::new()
                },
            })
            .collect();
        let tree = api_tree(
            &nodes,
            &["entry-0".to_owned()],
            Some("entry-0"),
            0,
            &[],
            &[],
        );

        assert!(tree.nodes.len() <= MAX_TREE_RENDER_ROWS);
        assert!(
            tree.nodes
                .iter()
                .all(|node| node.depth <= MAX_TREE_RENDER_DEPTH)
        );
        assert!(tree.diagnostic_count > 0);
    }
}
