//! Versioned, host-safe data transfer objects for the PiUI foundation.
//!
//! These types cross the trusted host/UI boundary. They intentionally contain
//! opaque identifiers and display-safe metadata only: filesystem paths,
//! process handles, authentication material, and Pi RPC frames belong to
//! internal implementation layers and are not represented here.

#![forbid(unsafe_code)]

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;
use thiserror::Error;

macro_rules! opaque_id {
    ($name:ident) => {
        #[derive(
            Clone, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }
    };
}

opaque_id!(ProjectId);
opaque_id!(SessionId);
opaque_id!(RuntimeId);
opaque_id!(EntryId);
opaque_id!(BlockId);
opaque_id!(PageCursor);

/// A monotonically increasing, host-assigned runtime revision.
#[derive(
    Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Revision(pub u64);

impl Revision {
    pub const ZERO: Self = Self(0);

    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Result<Self, RevisionError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(RevisionError::Overflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum RevisionError {
    #[error("revision cannot advance past its maximum value")]
    Overflow,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectTrustState {
    #[default]
    Unknown,
    Trusted,
    Restricted,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub name: String,
    #[serde(default)]
    pub trust_state: ProjectTrustState,
    #[serde(default)]
    pub missing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionTitleSource {
    PiName,
    FirstUserMessage,
    #[default]
    DateId,
    UiAlias,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionParseState {
    Healthy,
    #[default]
    Partial,
    Unsupported,
    Corrupt,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    pub title: String,
    #[serde(default)]
    pub title_source: SessionTitleSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub entry_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_count: Option<u64>,
    #[serde(default)]
    pub parse_state: SessionParseState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<RuntimeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

/// Rebuildable scanner/index metadata. File locations are deliberately absent.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjection {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub title_source: SessionTitleSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_user_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(default)]
    pub entry_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_leaf_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub parse_state: SessionParseState,
    /// Opaque content fingerprint, never a filesystem location.
    #[serde(default)]
    pub file_revision: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    #[default]
    Dormant,
    Starting,
    Ready,
    Running,
    Recovering,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockStatus {
    #[default]
    Pending,
    Streaming,
    Complete,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineBlockKind {
    User,
    Assistant,
    Thinking,
    Tool,
    #[default]
    Custom,
    Error,
    Compaction,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSource {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub entry_type: Option<String>,
}

/// A normalized, renderable block. `content` is host-normalized JSON, not a Pi RPC frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBlock {
    pub id: BlockId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<BlockId>,
    #[serde(default)]
    pub kind: TimelineBlockKind,
    #[serde(default)]
    pub status: BlockStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub source: TimelineSource,
    #[serde(default)]
    pub content: Value,
}

impl Default for TimelineBlock {
    fn default() -> Self {
        Self {
            id: BlockId::default(),
            parent_id: None,
            kind: TimelineBlockKind::default(),
            status: BlockStatus::default(),
            created_at: None,
            source: TimelineSource::default(),
            content: Value::Null,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePage {
    pub session_id: SessionId,
    #[serde(default)]
    pub blocks: Vec<TimelineBlock>,
    /// Opaque content fingerprint used to detect stale cursors.
    #[serde(default)]
    pub file_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older_cursor: Option<PageCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newer_cursor: Option<PageCursor>,
    #[serde(default)]
    pub stale_cursor: bool,
}

/// Read-only branch-tree projection. It intentionally has no navigation command.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlySessionTree {
    pub session_id: SessionId,
    #[serde(default)]
    pub nodes: Vec<SessionTreeNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_leaf_id: Option<EntryId>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeNode {
    pub entry_id: EntryId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<EntryId>,
    #[serde(default = "unknown_role_or_type")]
    pub role_or_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub children: Vec<EntryId>,
    #[serde(default)]
    pub is_current_path: bool,
}

fn unknown_role_or_type() -> String {
    "unknown".to_owned()
}

/// A capability that must never be advertised as supported by the foundation host.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DisabledCapability;

impl DisabledCapability {
    pub const fn is_supported(self) -> bool {
        false
    }
}

impl Serialize for DisabledCapability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        false.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for DisabledCapability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            return Err(de::Error::custom("ui.customTui must be false"));
        }
        Ok(Self)
    }
}

/// The known subset of the versioned runtime capability contract.
///
/// Missing values always deserialize to `false`; unknown future capabilities are
/// deliberately ignored so an older host can safely consume a newer snapshot.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeCapabilities {
    #[serde(default)]
    pub rpc: bool,
    #[serde(default)]
    pub images: bool,
    #[serde(default, rename = "models.list")]
    pub models_list: bool,
    #[serde(default, rename = "models.switch")]
    pub models_switch: bool,
    #[serde(default, rename = "thinking.set")]
    pub thinking_set: bool,
    #[serde(default, rename = "queue.setMode")]
    pub queue_set_mode: bool,
    #[serde(default, rename = "session.switch")]
    pub session_switch: bool,
    #[serde(default, rename = "session.new")]
    pub session_new: bool,
    #[serde(default, rename = "session.rename")]
    pub session_rename: bool,
    #[serde(default, rename = "session.export")]
    pub session_export: bool,
    #[serde(default, rename = "session.fork")]
    pub session_fork: bool,
    #[serde(default, rename = "session.clone")]
    pub session_clone: bool,
    #[serde(default, rename = "session.tree.read")]
    pub session_tree_read: bool,
    #[serde(default, rename = "session.tree.navigate")]
    pub session_tree_navigate: bool,
    #[serde(default, rename = "session.shutdown")]
    pub session_shutdown: bool,
    #[serde(default, rename = "auth.headless")]
    pub auth_headless: bool,
    #[serde(default, rename = "ui.standardDialogs")]
    pub ui_standard_dialogs: bool,
    #[serde(default, rename = "ui.customTui")]
    pub ui_custom_tui: DisabledCapability,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueMode {
    Steer,
    #[default]
    FollowUp,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub runtime_id: RuntimeId,
    pub project_id: ProjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub state: RuntimeState,
    #[serde(default)]
    pub revision: Revision,
    #[serde(default)]
    pub capabilities: RuntimeCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_model: Option<ModelRef>,
    #[serde(default)]
    pub available_models: Vec<ModelDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_mode: Option<QueueMode>,
    #[serde(default)]
    pub queued_count: u64,
    #[serde(default)]
    pub blocks: Vec<TimelineBlock>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStateEvent {
    pub runtime_id: RuntimeId,
    pub project_id: ProjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub state: RuntimeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_state: Option<RuntimeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// A redacted, display-safe description. Never place raw stderr/RPC data here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_summary: Option<String>,
}

/// Runtime-only host events needed by the foundation UI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum RuntimeEvent {
    #[serde(rename = "runtime.state")]
    State(RuntimeStateEvent),
    #[serde(rename = "runtime.snapshot")]
    Snapshot(RuntimeSnapshot),
}

impl Default for RuntimeEvent {
    fn default() -> Self {
        Self::State(RuntimeStateEvent::default())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum HostErrorCode {
    #[serde(rename = "INVALID_ARGUMENT")]
    InvalidArgument,
    #[serde(rename = "NOT_FOUND")]
    NotFound,
    #[serde(rename = "NOT_TRUSTED")]
    NotTrusted,
    #[serde(rename = "NOT_SUPPORTED")]
    NotSupported,
    #[serde(rename = "PERMISSION_DENIED")]
    PermissionDenied,
    #[serde(rename = "CONFLICT")]
    Conflict,
    #[serde(rename = "RUNTIME_NOT_READY")]
    RuntimeNotReady,
    #[serde(rename = "RUNTIME_FAILED")]
    RuntimeFailed,
    #[serde(rename = "PROTOCOL_ERROR")]
    ProtocolError,
    #[serde(rename = "TIMEOUT")]
    Timeout,
    #[serde(rename = "IO_ERROR")]
    IoError,
    #[default]
    #[serde(rename = "INTERNAL_ERROR")]
    InternalError,
}

/// A display-safe host error. Details are intentionally excluded: raw failures
/// belong in the host's redacted diagnostics store, not in UI contracts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HostError {
    #[serde(default)]
    pub code: HostErrorCode,
    #[serde(default = "default_host_error_message")]
    pub message: String,
    #[serde(default)]
    pub recoverable: bool,
}

impl Default for HostError {
    fn default() -> Self {
        Self {
            code: HostErrorCode::default(),
            message: default_host_error_message(),
            recoverable: false,
        }
    }
}

fn default_host_error_message() -> String {
    "An internal host error occurred.".to_owned()
}
