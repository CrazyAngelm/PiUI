//! Serialization-only DTOs for the WebView boundary.
//!
//! These structures intentionally contain safe display text and opaque IDs;
//! host paths, SQLite handles, process handles, raw Pi JSON and credentials do
//! not cross this module.

use piui_index::{
    ChatWidthPreference, DensityPreference, FontSizePreference, GenericBlockKind,
    GenericBlockStatus, GenericTimelineBlock, ParseState, Preferences, ProjectSummary,
    ReducedMotionPreference, SessionSummary, SessionTreeNode, ThemePreference, TitleSource,
    TrustState, redact_display_text,
};
use piui_runtime::{LifecycleState, SystemPiDiagnosticEligibility};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

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
pub struct ApiProjectSummary {
    pub id: String,
    pub name: String,
    pub display_path: String,
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
}

pub fn runtime_snapshot_named(
    runtime_id: &str,
    state: LifecycleState,
    revision: u64,
    summary: Option<String>,
) -> ApiRuntimeSnapshot {
    ApiRuntimeSnapshot {
        runtime_id: runtime_id.to_owned(),
        state: runtime_state(state),
        revision,
        capabilities: ApiRuntimeCapabilities {
            rpc: true,
            session_tree_read: true,
            session_tree_navigate: false,
            auth_headless: false,
            // The local preview emits a generic notice and cancels blocking
            // extension dialogs; it must not claim standard-dialog support.
            ui_standard_dialogs: false,
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

/// Result of starting a live Pi runtime.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRuntimeStart {
    pub runtime: ApiRuntimeSnapshot,
    pub runtime_id: String,
    pub launch_label: String,
    /// Display-safe session state captured from the startup `get_state` handshake.
    pub session_state: piui_runtime::SessionStateLite,
    /// PiUI's opaque indexed id for a continued session. It is intentionally
    /// distinct from `session_state.session_id`, which is Pi's native id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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
    use super::{ApiPreferences, MAX_TREE_RENDER_DEPTH, MAX_TREE_RENDER_ROWS, api_tree};
    use piui_index::{
        ChatWidthPreference, DensityPreference, FontSizePreference, Preferences,
        ReducedMotionPreference, SessionTreeNode, ThemePreference,
    };

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
