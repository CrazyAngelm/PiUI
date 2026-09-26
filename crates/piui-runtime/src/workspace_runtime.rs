//! Host-private supervisor for the native multi-harness Node bridge.
//!
//! Native session references and paths in this module must be mapped to opaque
//! workspace ids before any WebView IPC. The bridge owns no model or tool loop.

use crate::codec::{RpcCodec, RpcCodecConfig};
use crate::native_version::{CODEX_APP_SERVER, VersionCheck};
use crate::real_rpc::resolve_pi_launch;
#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::timeout;

// These are the established live runtime watchdogs from real_rpc.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);
const READ_BUFFER_BYTES: usize = 16 * 1024;
/// Bound of each runtime's event queue. A full queue is backpressure: the
/// bridge reader waits for capacity, it never fails the runtime.
const EVENT_CHANNEL_CAPACITY: usize = 256;

const RUNNER_SOURCE: &str = include_str!("../bridge/runner.mjs");
const PI_SOURCE: &str = include_str!("../bridge/pi.mjs");
const PRIME_SOURCE: &str = include_str!("../bridge/prime.mjs");
const HERMES_SOURCE: &str = include_str!("../bridge/hermes.mjs");
const CODEX_SOURCE: &str = include_str!("../bridge/codex.mjs");
const CODEX_POOL_SOURCE: &str = include_str!("../bridge/codex-pool.mjs");
const CLAUDE_SOURCE: &str = include_str!("../bridge/claude.mjs");

/// Fixed, user-facing sign-in guidance for a Claude Code login that is not
/// the user's Claude subscription. PiUI never signs in on the user's behalf.
pub const CLAUDE_SIGN_IN_MESSAGE: &str = "Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.";

/// Environment removed before the Claude Code bridge starts. Only the user's
/// Claude subscription login may reach the CLI: API keys, bearer, identity and
/// federation tokens, provider switches, base-URL/socket/header routing,
/// billing and account overrides, and the coupling a parent Claude Code
/// session injects into its children are all dropped. The bridge filters the
/// same list again; a unit test keeps both lists identical. Values are never
/// read or logged.
pub const CLAUDE_SCRUBBED_ENVIRONMENT: &[&str] = &[
    // Non-subscription credentials, provider switches and API routing.
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_HOST",
    "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_HFI_BEARER_TOKEN",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    // Billing, account and speed overrides.
    "CLAUDE_CODE_EXTRA_BODY",
    "CLAUDE_CODE_SUBSCRIPTION_TYPE",
    "CLAUDE_CODE_RATE_LIMIT_TIER",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ACCOUNT_TAGGED_ID",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
    "CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS",
    // Coupling a parent Claude Code session or host injects into its children.
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_AGENT_SDK_CLIENT_APP",
    "CLAUDE_PID",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
    "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_BRIDGE_REATTACH_SESSION",
    "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_REMOTE_SESSION_UUID",
    "CLAUDE_SESSION_ID",
    "CLAUDE_RUNNER_SESSION_ID",
    "CLAUDE_RUNNER_SESSION_UUID",
    "CLAUDE_CODE_IDE_HOST_OVERRIDE",
];

/// Operator capabilities that no managed native process may inherit.
const OPERATOR_ENVIRONMENT: &[&str] = &[
    "PIUI_AGENT_API_TOKEN",
    "PIUI_AGENT_API_PORT",
    "PIUI_AGENT_API_CONNECTION",
];

/// Claude Code releases this adapter accepts: `>=2.1.0 <3.0.0`. The protocol
/// was verified against 2.1.232; newer 2.x releases keep the same headless
/// stream-json and control protocol, and the adapter fails closed on drift.
const CLAUDE_MINIMUM_VERSION: (u64, u64, u64) = (2, 1, 0);
const CLAUDE_MAXIMUM_MAJOR_EXCLUSIVE: u64 = 3;
const CLAUDE_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// A failed version probe is repeated after this delay; a success is kept
/// until the executable changes.
const CLAUDE_VERSION_RETRY: Duration = Duration::from_secs(60);
const CLAUDE_VERSION_OUTPUT_LIMIT: u64 = 4 * 1024;
/// Claude Code resolves plugins, hooks and MCP servers before it answers the
/// `initialize` control request; add that native phase to the transport
/// allowance, like the Hermes ACP startup below.
const CLAUDE_STARTUP_ALLOWANCE: Duration = Duration::from_secs(25);

// The full bridge source is sent through stdin because CreateProcess has a
// 32767 UTF--16 command-line limit. This fixed ESM bootstrap reads exactly the
// trusted length-prefixed source bytes, leaving subsequent LF JSON untouched.
const NODE_BOOTSTRAP: &str = r#"const fs=await import('node:fs');const h=Buffer.alloc(4);let o=0;while(o<4){const n=fs.readSync(0,h,o,4-o,null);if(n===0)throw new Error('bridge source EOF');o+=n}const z=h.readUInt32LE(0),b=Buffer.alloc(z);o=0;while(o<z){const n=fs.readSync(0,b,o,z-o,null);if(n===0)throw new Error('bridge source EOF');o+=n}await import('data:text/javascript;base64,'+b.toString('base64'));"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessKind {
    Pi,
    PrimeAgent,
    Codex,
    Hermes,
    ClaudeCode,
}

impl HarnessKind {
    /// Every harness in presentation order.
    pub const ALL: [Self; 5] = [
        Self::Pi,
        Self::PrimeAgent,
        Self::Codex,
        Self::Hermes,
        Self::ClaudeCode,
    ];

    const fn display_name(self) -> &'static str {
        match self {
            Self::Pi => "Pi",
            Self::PrimeAgent => "Prime Agent",
            Self::Codex => "Codex",
            Self::Hermes => "Hermes",
            Self::ClaudeCode => "Claude Code",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Starting,
    Idle,
    Running,
    Stopping,
    Closed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Native,
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeResourceKind {
    Tool,
    Skill,
    Mcp,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResource {
    pub kind: NativeResourceKind,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub configurable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResourceCatalog {
    pub items: Vec<NativeResource>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Enforcement {
    Native,
    Coordinator,
    Advisory,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub supported: bool,
    pub enforcement: Enforcement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessCapabilities {
    pub prompt: Capability,
    pub resume: Capability,
    pub models: Capability,
    pub approvals: Capability,
    pub instructions: Capability,
    pub tool_policy: Capability,
    pub native_subagents: Capability,
}

/// Additive host-private composer contract; absence never implies support.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposerCapabilities {
    pub steer: bool,
    pub compact: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCatalogModel {
    pub id: String,
    pub provider: Option<String>,
    pub name: String,
    pub thinking_levels: Option<Vec<String>>,
    pub supports_fast: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Custom,
    Error,
    Compaction,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockStatus {
    Complete,
    Streaming,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeBlock {
    pub id: String,
    pub kind: BlockKind,
    pub label: String,
    pub status: BlockStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    ApproveOnce,
    ApproveSession,
    Deny,
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permission,
    Input,
}

/// One choice of a native select-style request. The id is adapter-owned and
/// opaque; the host answers with it through the `text` of `respond`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeApproval {
    pub id: String,
    pub kind: ApprovalKind,
    pub title: String,
    pub description: String,
    pub decisions: Vec<ApprovalDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ApprovalOption>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    pub native_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_path: Option<String>,
    /// Native persistence truth when reported by the adapter. `None` is
    /// conservatively unknown for compatibility with older private bridges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialized: Option<bool>,
    pub title: String,
    pub status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<WorkspaceModel>,
    pub blocks: Vec<NativeBlock>,
    pub approvals: Vec<NativeApproval>,
    pub capabilities: HarnessCapabilities,
    pub models: Vec<WorkspaceModel>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptMode {
    Prompt,
    Steer,
    FollowUp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoordinatorOperation {
    Roster,
    Send {
        recipient_member_id: String,
        body: String,
    },
    Observe {
        target_member_id: String,
    },
    Wait {
        target_member_id: String,
    },
    Spawn {
        step_id: String,
    },
    SpawnAgent {
        profile_id: String,
        name: String,
        instructions: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum CoordinatorResponse {
    Success(Value),
    Failure { code: String, message: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnOutcome {
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeEvent {
    Usage {
        usage: crate::workspace_usage::NativeUsage,
    },
    Block {
        block: NativeBlock,
    },
    TextDelta {
        block_id: String,
        text: String,
    },
    Status {
        status: SessionStatus,
    },
    Approval {
        approval: NativeApproval,
    },
    ApprovalResolved {
        request_id: String,
    },
    Binding {
        native_id: String,
        #[serde(default)]
        native_path: Option<String>,
    },
    TurnCompleted {
        outcome: TurnOutcome,
    },
    CoordinatorRequest {
        request_id: String,
        operation: CoordinatorOperation,
    },
    Error {
        message: String,
    },
}

/// Exact host-owned native session configuration. It is never serialized to a
/// WebView and its Debug output omits paths, instructions and native ids.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeConfig {
    pub harness: HarnessKind,
    pub cwd: PathBuf,
    pub session_dir: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<WorkspaceModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub base_instructions: Option<String>,
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_rules: Option<serde_json::Value>,
    pub permission_mode: PermissionMode,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub network_access: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_subagents: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_socket: Option<String>,
    /// Verified native package root. Required for the Prime SDK adapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_root: Option<PathBuf>,
    /// Native auth/settings/resource directory chosen by the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_dir: Option<PathBuf>,
    /// Interpreter resolved by Prime's native environment API, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel_python: Option<PathBuf>,
    /// Enables the authenticated host coordinator tool for managed runs only.
    #[serde(default)]
    pub coordination: bool,
}

impl fmt::Debug for NativeRuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeRuntimeConfig")
            .field("harness", &self.harness)
            .field("has_native_id", &self.native_id.is_some())
            .field("has_native_path", &self.native_path.is_some())
            .field("has_title", &self.title.is_some())
            .field("has_model", &self.model.is_some())
            .field("has_thinking_level", &self.thinking_level.is_some())
            .field("has_instructions", &self.instructions.is_some())
            .field("permission_mode", &self.permission_mode)
            .field("network_access", &self.network_access)
            .field("has_tool_policy", &self.allowed_tools.is_some())
            .field("native_subagents", &self.native_subagents)
            .field("has_daemon_socket", &self.daemon_socket.is_some())
            .field("has_package_root", &self.package_root.is_some())
            .field("has_agent_dir", &self.agent_dir.is_some())
            .field("has_kernel_python", &self.kernel_python.is_some())
            .field("coordination", &self.coordination)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessAvailability {
    Available,
    Unavailable,
    Unverified,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHarnessSummary {
    pub kind: HarnessKind,
    pub name: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub status: HarnessAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BridgeFailureCode {
    TurnActive,
    NoActiveTurn,
    UnsupportedMethod,
    UnsupportedPolicy,
    InvalidRequest,
    InvalidResponse,
    StaleApproval,
    RuntimeUnavailable,
    NativeCommandRejected,
    AlreadyInitialized,
    NotInitialized,
    NotRunning,
    /// The native login is not the user's Claude subscription (Claude Code
    /// only): signed out, an API key, a cloud provider or a bearer token.
    SubscriptionRequired,
    OperationFailed,
}

#[derive(Debug, Error, Clone, Eq, PartialEq)]
pub enum NativeRuntimeError {
    #[error("The Node runtime is unavailable")]
    NodeUnavailable,
    #[error("The selected native harness is unavailable")]
    HarnessUnavailable,
    #[error("The native runtime configuration is invalid")]
    InvalidConfiguration,
    #[error("The native bridge source is too large")]
    BridgeSourceTooLarge,
    #[error("Could not spawn the native runtime")]
    Spawn,
    #[error("Native runtime process containment is unavailable")]
    Containment,
    #[error("The native bridge protocol failed")]
    Protocol,
    #[error("The native bridge request timed out")]
    Timeout,
    #[error("The native runtime is not running")]
    NotRunning,
    #[error("The native runtime exited unexpectedly")]
    UnexpectedExit,
    #[error("The native runtime response channel closed")]
    Channel,
    #[error("The native runtime rejected the request: {0:?}")]
    Bridge(BridgeFailureCode),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeConfig<'a> {
    #[serde(flatten)]
    config: &'a NativeRuntimeConfig,
    runtime_program: String,
    runtime_args: Vec<String>,
    pool_host: bool,
    catalog_only: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeFrame {
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<BridgeError>,
    #[serde(default)]
    event: Option<NativeEvent>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeError {
    code: String,
    #[allow(dead_code)]
    message: String,
}

type SessionEventRoute = (mpsc::Sender<NativeEvent>, Arc<AtomicBool>);

struct RuntimeShared {
    session_events: Mutex<HashMap<String, SessionEventRoute>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, NativeRuntimeError>>>>,
    timed_out: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    accepting: Arc<AtomicBool>,
    shutting_down: AtomicBool,
}

struct RuntimeContainment {
    #[cfg(unix)]
    unix_group: StdMutex<Option<UnixProcessGroup>>,
    #[cfg(windows)]
    windows_job: StdMutex<Option<WindowsJob>>,
}

impl RuntimeContainment {
    fn terminate(&self) -> Result<(), NativeRuntimeError> {
        #[cfg(unix)]
        {
            let mut slot = self
                .unix_group
                .lock()
                .map_err(|_| NativeRuntimeError::Containment)?;
            if let Some(mut group) = slot.take() {
                let result = group
                    .force_terminate_tree()
                    .map_err(|_| NativeRuntimeError::Containment);
                group.discard_after_supervisor_cleanup();
                result?;
            }
        }
        #[cfg(windows)]
        {
            let mut slot = self
                .windows_job
                .lock()
                .map_err(|_| NativeRuntimeError::Containment)?;
            if let Some(mut job) = slot.take() {
                let terminated = job.force_terminate_tree();
                let closed = job.close();
                if terminated.is_err() || closed.is_err() {
                    return Err(NativeRuntimeError::Containment);
                }
            }
        }
        Ok(())
    }
}

impl Drop for RuntimeContainment {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// One owned native bridge and all descendants it creates.
pub struct NativeRuntime {
    pooled: Option<(Arc<NativeRuntime>, String)>,
    shared: Arc<RuntimeShared>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr: Mutex<Option<tokio::task::JoinHandle<()>>>,
    containment: Arc<RuntimeContainment>,
}

impl NativeRuntime {
    async fn spawn_pooled(
        config: NativeRuntimeConfig,
        node: PathBuf,
        launch: ResolvedHarnessLaunch,
        source: Vec<u8>,
    ) -> Result<(Self, NativeEventReceiver), NativeRuntimeError> {
        type PoolKey = (PathBuf, Option<std::ffi::OsString>);
        type Pools = Mutex<HashMap<PoolKey, Weak<NativeRuntime>>>;
        static POOLS: OnceLock<Pools> = OnceLock::new();
        let key = (config.cwd.clone(), std::env::var_os("CODEX_HOME"));
        let mut pools = POOLS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .await;
        pools.retain(|_, pool| pool.strong_count() > 0);
        let initialize = json!(InitializeConfig {
            config: &config,
            runtime_program: launch.program.to_string_lossy().into_owned(),
            runtime_args: launch.args.clone(),
            pool_host: false,
            catalog_only: false,
        });
        let pool = if let Some(pool) = pools
            .get(&key)
            .and_then(Weak::upgrade)
            .filter(|pool| pool.shared.accepting.load(Ordering::Acquire))
        {
            pool
        } else {
            let (pool, _events) =
                Self::spawn_resolved(config.clone(), node, launch, source, true, false).await?;
            let pool = Arc::new(pool);
            pools.insert(key, Arc::downgrade(&pool));
            pool
        };
        drop(pools);
        let session_id = config.session_dir.to_string_lossy().into_owned();
        let (sender, receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let mut events = NativeEventReceiver::from(receiver);
        let accepting = Arc::new(AtomicBool::new(true));
        pool.shared
            .session_events
            .lock()
            .await
            .insert(session_id.clone(), (sender, accepting.clone()));
        // If this start is dropped before it completes, its route stops
        // accepting: a late event of the abandoned session is discarded
        // instead of failing every session that shares the pool.
        let route = UnfinishedPooledRoute(Some(Arc::clone(&accepting)));
        // The shared-stdin request runs detached, so dropping this start can
        // never truncate a frame that the other pooled sessions depend on.
        let open = tokio::spawn({
            let pool = Arc::clone(&pool);
            let params = json!({"sessionId":session_id,"config":initialize});
            async move {
                pool.request("openSession", params, REQUEST_TIMEOUT, false)
                    .await
            }
        });
        // Events of this session routed during `openSession` (for example a
        // resumed history page) must be drained: the shared reader would
        // otherwise wait on them before it can route the response.
        let opened = events
            .buffer_while(open)
            .await
            .unwrap_or(Err(NativeRuntimeError::Channel));
        if let Err(error) = opened {
            pool.shared.session_events.lock().await.remove(&session_id);
            return Err(error);
        }
        route.complete();
        Ok((
            Self {
                pooled: Some((pool, session_id)),
                shared: Arc::new(RuntimeShared {
                    session_events: Mutex::new(HashMap::new()),
                    stdin: Mutex::new(None),
                    pending: Mutex::new(HashMap::new()),
                    timed_out: Mutex::new(HashSet::new()),
                    next_id: AtomicU64::new(1),
                    accepting,
                    shutting_down: AtomicBool::new(false),
                }),
                child: Mutex::new(None),
                reader: Mutex::new(None),
                stderr: Mutex::new(None),
                containment: Arc::new(RuntimeContainment {
                    #[cfg(unix)]
                    unix_group: StdMutex::new(None),
                    #[cfg(windows)]
                    windows_job: StdMutex::new(None),
                }),
            },
            events,
        ))
    }

    /// Starts one native runtime. Dropping the returned future before it
    /// completes terminates the partially started process tree and never
    /// affects another session.
    pub async fn spawn(
        config: NativeRuntimeConfig,
    ) -> Result<(Self, NativeEventReceiver), NativeRuntimeError> {
        let config = resolve_native_runtime_config(config)?;
        validate_config(&config)?;
        let node = resolve_node()?;
        let launch = resolve_harness_launch_for_config(&config)?;
        let source = bridge_source(config.harness)?;
        let harness = config.harness;
        let spawned = if harness == HarnessKind::Codex && config.coordination {
            Self::spawn_pooled(config, node, launch, source).await
        } else {
            Self::spawn_resolved(config, node, launch, source, false, false).await
        };
        record_native_account(harness, spawned.as_ref().map(|_| ()));
        spawned
    }

    pub async fn spawn_catalog(
        config: NativeRuntimeConfig,
    ) -> Result<(Self, NativeEventReceiver), NativeRuntimeError> {
        let config = resolve_native_runtime_config(config)?;
        validate_config(&config)?;
        let node = resolve_node()?;
        let launch = resolve_harness_launch_for_config(&config)?;
        let source = bridge_source(config.harness)?;
        let harness = config.harness;
        let spawned = Self::spawn_resolved(config, node, launch, source, false, true).await;
        record_native_account(harness, spawned.as_ref().map(|_| ()));
        spawned
    }

    async fn spawn_resolved(
        config: NativeRuntimeConfig,
        node: PathBuf,
        launch: ResolvedHarnessLaunch,
        source: Vec<u8>,
        pool_host: bool,
        catalog_only: bool,
    ) -> Result<(Self, NativeEventReceiver), NativeRuntimeError> {
        let source_len =
            u32::try_from(source.len()).map_err(|_| NativeRuntimeError::BridgeSourceTooLarge)?;
        #[cfg(windows)]
        let mut windows_job = WindowsJob::new().map_err(|_| NativeRuntimeError::Containment)?;

        let mut command = Command::from(bridge_command(&node, &config));
        command.kill_on_drop(false);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| NativeRuntimeError::Spawn)?;

        #[cfg(windows)]
        {
            let assignment = child
                .id()
                .and_then(|pid| ProcessId::new(pid).ok())
                .and_then(|pid| {
                    windows_job
                        .assign_before_resume(SuspendedProcess::from_created_suspended(pid))
                        .ok()
                });
            let Some(assignment) = assignment else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(NativeRuntimeError::Containment);
            };
            if windows_job.resume_assigned(assignment).is_err() {
                let _ = windows_job.force_terminate_tree();
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(NativeRuntimeError::Containment);
            }
        }

        #[cfg(unix)]
        let unix_group = {
            let id = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .and_then(|pid| ProcessGroupId::new(pid).ok());
            let Some(id) = id else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(NativeRuntimeError::Containment);
            };
            UnixProcessGroup::from_spawned_group(id)
        };

        let stdin = child.stdin.take().ok_or(NativeRuntimeError::Spawn)?;
        let stdout = child.stdout.take().ok_or(NativeRuntimeError::Spawn)?;
        let stderr = child.stderr.take();
        let shared = Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(false),
        });
        let containment = Arc::new(RuntimeContainment {
            #[cfg(unix)]
            unix_group: StdMutex::new(Some(unix_group)),
            #[cfg(windows)]
            windows_job: StdMutex::new(Some(windows_job)),
        });
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let mut events = NativeEventReceiver::from(event_rx);
        let reader_shared = Arc::clone(&shared);
        let reader_containment = Arc::clone(&containment);
        let reader = tokio::spawn(async move {
            read_bridge_stdout(stdout, reader_shared, event_tx, Some(reader_containment)).await;
        });
        let stderr = stderr.map(|mut stream| {
            tokio::spawn(async move {
                let mut buffer = [0u8; READ_BUFFER_BYTES];
                while let Ok(read) = stream.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    // Deliberately drain and discard. Native stderr may contain paths,
                    // prompts, environment values or authentication diagnostics.
                }
            })
        });
        let runtime = Self {
            pooled: None,
            shared,
            child: Mutex::new(Some(child)),
            reader: Mutex::new(Some(reader)),
            stderr: Mutex::new(stderr),
            containment,
        };

        if runtime.write_source(source_len, &source).await.is_err() {
            let _ = runtime.terminate().await;
            return Err(NativeRuntimeError::Protocol);
        }
        let initialize = InitializeConfig {
            config: &config,
            runtime_program: launch.program.to_string_lossy().into_owned(),
            runtime_args: launch.args,
            pool_host,
            catalog_only,
        };
        // Hermes 0.21 ACP permits a 30-second late MCP discovery phase.
        // Add that native phase to the existing 20-second transport allowance.
        let startup_timeout = match config.harness {
            HarnessKind::Hermes => REQUEST_TIMEOUT + Duration::from_secs(30),
            HarnessKind::ClaudeCode => REQUEST_TIMEOUT + CLAUDE_STARTUP_ALLOWANCE,
            HarnessKind::Pi | HarnessKind::PrimeAgent | HarnessKind::Codex => REQUEST_TIMEOUT,
        };
        // An adapter may replay native history while it initializes (a Hermes
        // `session/load` or a resumed Codex page). Those events are retained
        // so the reader can route the initialize response queued behind them.
        let initialized = events
            .buffer_while(runtime.request("initialize", json!(initialize), startup_timeout, false))
            .await;
        if let Err(error) = initialized {
            runtime.begin_retirement();
            drop(events);
            let _ = runtime.terminate().await;
            return Err(error);
        }
        Ok((runtime, events))
    }

    async fn write_source(&self, length: u32, source: &[u8]) -> Result<(), NativeRuntimeError> {
        let mut stdin = self.shared.stdin.lock().await;
        let stream = stdin.as_mut().ok_or(NativeRuntimeError::NotRunning)?;
        stream
            .write_all(&length.to_le_bytes())
            .await
            .map_err(|_| NativeRuntimeError::Protocol)?;
        stream
            .write_all(source)
            .await
            .map_err(|_| NativeRuntimeError::Protocol)?;
        stream
            .flush()
            .await
            .map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn snapshot(&self) -> Result<NativeSnapshot, NativeRuntimeError> {
        let value = self
            .request("snapshot", json!({}), REQUEST_TIMEOUT, false)
            .await?;
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn prompt(&self, text: String, mode: PromptMode) -> Result<(), NativeRuntimeError> {
        self.request(
            "prompt",
            json!({ "text": text, "mode": mode }),
            REQUEST_TIMEOUT,
            false,
        )
        .await
        .map(|_| ())
    }

    pub async fn composer_capabilities(&self) -> Result<ComposerCapabilities, NativeRuntimeError> {
        let value = self
            .request("composerCapabilities", json!({}), REQUEST_TIMEOUT, false)
            .await?;
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn compact(&self) -> Result<(), NativeRuntimeError> {
        self.request("compact", json!({}), REQUEST_TIMEOUT, false)
            .await
            .map(|_| ())
    }

    pub async fn interrupt(&self) -> Result<(), NativeRuntimeError> {
        self.request("interrupt", json!({}), INTERRUPT_TIMEOUT, false)
            .await
            .map(|_| ())
    }

    pub async fn resources(&self) -> Result<NativeResourceCatalog, NativeRuntimeError> {
        let value = self
            .request("resources", json!({}), REQUEST_TIMEOUT, false)
            .await?;
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn catalog_models(&self) -> Result<Vec<NativeCatalogModel>, NativeRuntimeError> {
        let value = self
            .request("catalogModels", json!({}), REQUEST_TIMEOUT, false)
            .await?;
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn models(&self) -> Result<Vec<WorkspaceModel>, NativeRuntimeError> {
        let value = self
            .request("models", json!({}), REQUEST_TIMEOUT, false)
            .await?;
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)
    }

    pub async fn set_model(
        &self,
        model: WorkspaceModel,
        thinking_level: Option<String>,
        service_tier: Option<String>,
    ) -> Result<(), NativeRuntimeError> {
        self.request(
            "setModel",
            json!({ "model": model, "thinkingLevel": thinking_level, "serviceTier": service_tier }),
            REQUEST_TIMEOUT,
            false,
        )
        .await
        .map(|_| ())
    }

    pub async fn respond(
        &self,
        request_id: String,
        decision: ApprovalDecision,
        text: Option<String>,
    ) -> Result<(), NativeRuntimeError> {
        self.request(
            "respond",
            json!({ "requestId": request_id, "decision": decision, "text": text }),
            REQUEST_TIMEOUT,
            false,
        )
        .await
        .map(|_| ())
    }

    /// Resolves one origin-bound coordinator tool request. This is host-private
    /// and must never be exposed as workspace WebView IPC.
    pub async fn coordinator_response(
        &self,
        request_id: String,
        response: CoordinatorResponse,
    ) -> Result<(), NativeRuntimeError> {
        let response = match response {
            CoordinatorResponse::Success(result) => json!({ "ok": true, "result": result }),
            CoordinatorResponse::Failure { code, message } => {
                json!({ "ok": false, "error": { "code": code, "message": message } })
            }
        };
        self.request(
            "coordinatorResponse",
            json!({ "requestId": request_id, "response": response }),
            REQUEST_TIMEOUT,
            false,
        )
        .await
        .map(|_| ())
    }

    pub async fn rename(&self, title: String) -> Result<(), NativeRuntimeError> {
        self.request("rename", json!({ "title": title }), REQUEST_TIMEOUT, false)
            .await
            .map(|_| ())
    }

    /// Stops new command admission before the host retires its event consumer.
    /// During this explicit retirement window a closed event sink is expected,
    /// while a closed sink during active operation remains fatal. A full sink
    /// is never fatal: the reader waits for capacity.
    pub fn begin_retirement(&self) {
        self.shared.accepting.store(false, Ordering::Release);
    }

    /// Requests graceful native disposal, then retires the owned process tree.
    /// Both the native acknowledgement and containment cleanup must succeed.
    pub async fn dispose(&self) -> Result<(), NativeRuntimeError> {
        if self.shared.shutting_down.swap(true, Ordering::AcqRel) {
            return self.shutdown_child().await;
        }
        self.shared.accepting.store(false, Ordering::Release);
        let graceful = self
            .request("dispose", json!({}), SHUTDOWN_TIMEOUT, true)
            .await;
        if let Some((pool, session_id)) = &self.pooled {
            pool.shared.session_events.lock().await.remove(session_id);
            if graceful.is_err() {
                let _ = pool.terminate_containment();
            }
            return graceful.map(|_| ());
        }
        let shutdown = self.shutdown_child().await;
        match (graceful, shutdown) {
            (Err(error), _) => Err(error),
            (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }

    /// Emergency host retirement for trust revocation or protocol failure.
    pub async fn terminate(&self) -> Result<(), NativeRuntimeError> {
        self.shared.shutting_down.store(true, Ordering::Release);
        self.shared.accepting.store(false, Ordering::Release);
        if let Some((pool, _)) = &self.pooled {
            // Emergency trust/protocol retirement stops the shared workspace
            // process too; it must never leave native tools running.
            return pool.terminate_containment();
        }
        self.shutdown_child().await
    }

    async fn request<T: Serialize>(
        &self,
        method: &str,
        params: T,
        deadline: Duration,
        allow_shutdown: bool,
    ) -> Result<Value, NativeRuntimeError> {
        if (self.shared.shutting_down.load(Ordering::Acquire)
            || !self.shared.accepting.load(Ordering::Acquire))
            && !allow_shutdown
        {
            return Err(NativeRuntimeError::NotRunning);
        }
        if let Some((pool, session_id)) = &self.pooled {
            return Box::pin(pool.request(
                "sessionRequest",
                json!({"sessionId":session_id,"method":method,"params":params}),
                deadline,
                false,
            ))
            .await;
        }
        let id = format!(
            "piui-bridge-{}",
            self.shared.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let mut encoded =
            serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
                .map_err(|_| NativeRuntimeError::Protocol)?;
        encoded.push(b'\n');
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().await.insert(id.clone(), tx);
        let exchange = async {
            {
                let mut stdin = self.shared.stdin.lock().await;
                let stream = stdin.as_mut().ok_or(NativeRuntimeError::NotRunning)?;
                stream
                    .write_all(&encoded)
                    .await
                    .map_err(|_| NativeRuntimeError::NotRunning)?;
                stream
                    .flush()
                    .await
                    .map_err(|_| NativeRuntimeError::NotRunning)?;
            }
            rx.await.map_err(|_| NativeRuntimeError::Channel)?
        };
        match timeout(deadline, exchange).await {
            Ok(result) => {
                if result.is_err() {
                    self.shared.pending.lock().await.remove(&id);
                }
                result
            }
            Err(_) => {
                let was_pending = self.shared.pending.lock().await.remove(&id).is_some();
                if was_pending {
                    self.shared.timed_out.lock().await.insert(id);
                }
                Err(NativeRuntimeError::Timeout)
            }
        }
    }

    fn terminate_containment(&self) -> Result<(), NativeRuntimeError> {
        self.containment.terminate()
    }

    async fn shutdown_child(&self) -> Result<(), NativeRuntimeError> {
        self.shared.accepting.store(false, Ordering::Release);
        fail_pending(&self.shared, NativeRuntimeError::NotRunning).await;
        *self.shared.stdin.lock().await = None;
        if let Some(handle) = self.reader.lock().await.take() {
            let _ = timeout(SHUTDOWN_TIMEOUT, handle).await;
        }
        if let Some(handle) = self.stderr.lock().await.take() {
            let _ = timeout(Duration::from_secs(1), handle).await;
        }
        let mut child_slot = self.child.lock().await;
        let Some(mut child) = child_slot.take() else {
            return self.terminate_containment();
        };
        match timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
            Ok(Ok(_)) => self.terminate_containment(),
            _ => {
                let containment = self.terminate_containment();
                let _ = child.kill().await;
                let _ = child.wait().await;
                containment
            }
        }
    }
}

impl Drop for NativeRuntime {
    fn drop(&mut self) {
        if let Some((pool, _)) = &self.pooled
            && !self.shared.shutting_down.load(Ordering::Acquire)
        {
            let _ = pool.terminate_containment();
        }
        let _ = self.terminate_containment();
    }
}

#[cfg(any(test, feature = "test-support"))]
impl NativeRuntime {
    /// Test support only: runs the production runner, transport and process
    /// containment around a caller-supplied adapter factory body. It is not
    /// compiled into application builds, so bridge code cannot be injected.
    #[doc(hidden)]
    pub async fn spawn_test_adapter(
        config: NativeRuntimeConfig,
        factory_body: &str,
    ) -> Result<(Self, NativeEventReceiver), NativeRuntimeError> {
        let node = resolve_node()?;
        let source = format!(
            "export async function createTestAdapter(config,emit,coordinatorRequest){{{factory_body}}}\nglobalThis.__PIUI_BRIDGE_FACTORY__=createTestAdapter;\n{RUNNER_SOURCE}"
        )
        .into_bytes();
        Self::spawn_resolved(
            config,
            node.clone(),
            ResolvedHarnessLaunch {
                program: node,
                args: Vec::new(),
                version: None,
            },
            source,
            false,
            false,
        )
        .await
    }
}

/// Ordered stream of one runtime's native events.
///
/// The bridge reader applies backpressure: while this stream is not drained it
/// stops reading the bridge's stdout, so the native pipe throttles the bridge
/// instead of a full queue failing the runtime. The owner must therefore never
/// await a response from the same runtime without draining the stream;
/// [`NativeEventReceiver::buffer_while`] keeps it draining for such waits.
pub struct NativeEventReceiver {
    /// Events retained while the owner awaited a response, in arrival order.
    retained: VecDeque<NativeEvent>,
    live: mpsc::Receiver<NativeEvent>,
    live_closed: bool,
}

impl NativeEventReceiver {
    /// Receives the next event in arrival order. Cancel-safe.
    pub async fn recv(&mut self) -> Option<NativeEvent> {
        if let Some(event) = self.retained.pop_front() {
            return Some(event);
        }
        if self.live_closed {
            return None;
        }
        self.live.recv().await
    }

    /// Returns the next event only if it is already available.
    pub fn try_recv(&mut self) -> Option<NativeEvent> {
        self.retained
            .pop_front()
            .or_else(|| self.live.try_recv().ok())
    }

    /// Drives `future` to completion while retaining every event that
    /// arrives meanwhile, so the reader can always route an awaited response
    /// that the bridge wrote after those events. Consecutive text deltas of
    /// one block are merged while retained; order is otherwise unchanged.
    pub async fn buffer_while<F: Future>(&mut self, future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        loop {
            if self.live_closed {
                return future.await;
            }
            tokio::select! {
                biased;
                output = &mut future => return output,
                event = self.live.recv() => match event {
                    Some(event) => self.retain(event),
                    None => self.live_closed = true,
                },
            }
        }
    }

    fn retain(&mut self, event: NativeEvent) {
        if let NativeEvent::TextDelta { block_id, text } = &event
            && let Some(NativeEvent::TextDelta {
                block_id: previous_block,
                text: previous_text,
            }) = self.retained.back_mut()
            && previous_block == block_id
        {
            previous_text.push_str(text);
            return;
        }
        self.retained.push_back(event);
    }
}

impl From<mpsc::Receiver<NativeEvent>> for NativeEventReceiver {
    fn from(live: mpsc::Receiver<NativeEvent>) -> Self {
        Self {
            retained: VecDeque::new(),
            live,
            live_closed: false,
        }
    }
}

/// Route of a pooled session whose start has not completed. Dropping it stops
/// the route from accepting, so an abandoned start never fails the pool.
struct UnfinishedPooledRoute(Option<Arc<AtomicBool>>);

impl UnfinishedPooledRoute {
    fn complete(mut self) {
        self.0 = None;
    }
}

impl Drop for UnfinishedPooledRoute {
    fn drop(&mut self) {
        if let Some(accepting) = self.0.take() {
            accepting.store(false, Ordering::Release);
        }
    }
}

async fn read_bridge_stdout<R: tokio::io::AsyncRead + Unpin>(
    mut stdout: R,
    shared: Arc<RuntimeShared>,
    events: mpsc::Sender<NativeEvent>,
    containment: Option<Arc<RuntimeContainment>>,
) {
    let mut codec = match RpcCodec::new(RpcCodecConfig::default()) {
        Ok(codec) => codec,
        Err(_) => return,
    };
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut failed = false;
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let values = match codec.push(&buffer[..read]) {
                    Ok(values) => values,
                    Err(_) => {
                        failed = true;
                        break;
                    }
                };
                for value in values {
                    if route_bridge_frame(value, &shared, &events).await.is_err() {
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    if codec.finish().is_err() {
        failed = true;
    }
    let expected = shared.shutting_down.load(Ordering::Acquire);
    if failed || !expected {
        shared.accepting.store(false, Ordering::Release);
        let error = if failed {
            NativeRuntimeError::Protocol
        } else {
            NativeRuntimeError::UnexpectedExit
        };
        fail_pending(&shared, error.clone()).await;
        // Retire the process tree before awaiting anything it could hold: a
        // bridge blocked on its stdout pipe no longer drains its stdin.
        if let Some(containment) = containment {
            let _ = containment.terminate();
        }
        *shared.stdin.lock().await = None;
        let routes = shared
            .session_events
            .lock()
            .await
            .values()
            .map(|(sender, _)| sender.clone())
            .collect::<Vec<_>>();
        for sender in routes {
            notify_failure(sender, "The shared Codex runtime stopped.");
        }
        notify_failure(
            events,
            if failed {
                "The native bridge protocol failed."
            } else {
                "The native runtime exited unexpectedly."
            },
        );
    }
}

/// Delivers the terminal notifications of a failed transport with the same
/// backpressure as every other event, from a detached task so that a stalled
/// consumer cannot keep the failed reader alive.
fn notify_failure(sender: mpsc::Sender<NativeEvent>, message: &'static str) {
    tokio::spawn(async move {
        let _ = sender
            .send(NativeEvent::Status {
                status: SessionStatus::Failed,
            })
            .await;
        let _ = sender
            .send(NativeEvent::Error {
                message: message.into(),
            })
            .await;
    });
}

/// Waits for queue capacity instead of failing: a slow consumer throttles the
/// bridge through its stdout pipe and never kills the runtime. A closed queue
/// is expected only after explicit retirement stopped command admission.
async fn deliver_event(
    sender: &mpsc::Sender<NativeEvent>,
    accepting: &AtomicBool,
    event: NativeEvent,
) -> Result<(), NativeRuntimeError> {
    match sender.send(event).await {
        Ok(()) => Ok(()),
        Err(_) if !accepting.load(Ordering::Acquire) => Ok(()),
        Err(_) => Err(NativeRuntimeError::Protocol),
    }
}

async fn route_bridge_frame(
    value: Value,
    shared: &Arc<RuntimeShared>,
    events: &mpsc::Sender<NativeEvent>,
) -> Result<(), NativeRuntimeError> {
    let frame: BridgeFrame =
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)?;
    if let Some(session_id) = frame.session_id {
        if frame.id.is_some() || frame.ok.is_some() {
            return Err(NativeRuntimeError::Protocol);
        }
        let event = frame.event.ok_or(NativeRuntimeError::Protocol)?;
        // Release the route table before waiting for capacity: opening or
        // retiring another pooled session never queues behind this consumer.
        let route = shared.session_events.lock().await.get(&session_id).cloned();
        if let Some((sender, accepting)) = route {
            deliver_event(&sender, &accepting, event).await?;
        }
        return Ok(());
    }
    match (frame.id, frame.ok, frame.event) {
        (None, None, Some(event)) => deliver_event(events, &shared.accepting, event).await,
        (Some(id), Some(ok), None) => {
            let slot = shared.pending.lock().await.remove(&id);
            let Some(slot) = slot else {
                if shared.timed_out.lock().await.remove(&id) {
                    return Ok(());
                }
                return Err(NativeRuntimeError::Protocol);
            };
            let result = if ok {
                if frame.error.is_some() {
                    Err(NativeRuntimeError::Protocol)
                } else {
                    Ok(frame.result.unwrap_or(Value::Null))
                }
            } else if let Some(error) = frame.error {
                Err(NativeRuntimeError::Bridge(map_bridge_failure(&error.code)))
            } else {
                Err(NativeRuntimeError::Protocol)
            };
            let _ = slot.send(result);
            Ok(())
        }
        _ => Err(NativeRuntimeError::Protocol),
    }
}

async fn fail_pending(shared: &Arc<RuntimeShared>, error: NativeRuntimeError) {
    let pending = std::mem::take(&mut *shared.pending.lock().await);
    for sender in pending.into_values() {
        let _ = sender.send(Err(error.clone()));
    }
}

fn map_bridge_failure(code: &str) -> BridgeFailureCode {
    match code {
        "turn-active" | "busy" => BridgeFailureCode::TurnActive,
        "no-active-turn" => BridgeFailureCode::NoActiveTurn,
        "unsupported-method" => BridgeFailureCode::UnsupportedMethod,
        "unsupported-policy" => BridgeFailureCode::UnsupportedPolicy,
        "invalid-request" => BridgeFailureCode::InvalidRequest,
        "invalid-response" => BridgeFailureCode::InvalidResponse,
        "stale-approval" => BridgeFailureCode::StaleApproval,
        "runtime-unavailable" => BridgeFailureCode::RuntimeUnavailable,
        "native-command-rejected" => BridgeFailureCode::NativeCommandRejected,
        "already-initialized" => BridgeFailureCode::AlreadyInitialized,
        "not-initialized" => BridgeFailureCode::NotInitialized,
        "not-running" => BridgeFailureCode::NotRunning,
        "claude-subscription-required" => BridgeFailureCode::SubscriptionRequired,
        _ => BridgeFailureCode::OperationFailed,
    }
}

/// Resolves native package/auth-resource locations from installed package
/// metadata and the native runtime's documented directory convention. This is
/// host-only, offline, and never reads credentials.
pub fn resolve_native_runtime_config(
    mut config: NativeRuntimeConfig,
) -> Result<NativeRuntimeConfig, NativeRuntimeError> {
    if config.harness == HarnessKind::Hermes {
        if config.agent_dir.is_none() {
            config.agent_dir = Some(
                std::env::var_os("HERMES_HOME")
                    .map(PathBuf::from)
                    .unwrap_or(native_home_dir()?.join(".hermes")),
            );
        }
        return Ok(config);
    }
    if config.harness != HarnessKind::PrimeAgent {
        return Ok(config);
    }
    let package_root = match config.package_root.take() {
        Some(root) => root,
        None => global_package_roots()
            .into_iter()
            .map(|root| root.join("prime-agent"))
            .find(|root| verified_prime_package_root(root))
            .ok_or(NativeRuntimeError::HarnessUnavailable)?,
    };
    if !verified_prime_package_root(&package_root) {
        return Err(NativeRuntimeError::HarnessUnavailable);
    }
    if config.agent_dir.is_none() {
        config.agent_dir = Some(resolve_native_agent_dir(&package_root)?);
    }
    config.package_root = Some(package_root);
    Ok(config)
}

fn resolve_native_agent_dir(package_root: &Path) -> Result<PathBuf, NativeRuntimeError> {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(package_root.join("package.json"))
            .map_err(|_| NativeRuntimeError::HarnessUnavailable)?,
    )
    .map_err(|_| NativeRuntimeError::HarnessUnavailable)?;
    let native_name = manifest
        .pointer("/piConfig/name")
        .and_then(Value::as_str)
        .unwrap_or("prime-agent");
    let config_dir = manifest
        .pointer("/piConfig/configDir")
        .and_then(Value::as_str)
        .unwrap_or(".prime/agent");
    let env_prefix = native_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_owned();
    let environment_name = format!("{env_prefix}_CODING_AGENT_DIR");
    if let Some(value) = std::env::var_os(environment_name) {
        let raw = PathBuf::from(value);
        if raw.is_absolute() {
            return Ok(raw);
        }
        if raw == Path::new("~") || raw.starts_with("~/") {
            let home = native_home_dir()?;
            return Ok(if raw == Path::new("~") {
                home
            } else {
                home.join(
                    raw.strip_prefix("~/")
                        .map_err(|_| NativeRuntimeError::InvalidConfiguration)?,
                )
            });
        }
        return Err(NativeRuntimeError::InvalidConfiguration);
    }
    Ok(native_home_dir()?.join(config_dir))
}

fn native_home_dir() -> Result<PathBuf, NativeRuntimeError> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(NativeRuntimeError::InvalidConfiguration)
}

fn validate_config(config: &NativeRuntimeConfig) -> Result<(), NativeRuntimeError> {
    if !config.cwd.is_absolute() || !config.cwd.is_dir() || !config.session_dir.is_absolute() {
        return Err(NativeRuntimeError::InvalidConfiguration);
    }
    std::fs::create_dir_all(&config.session_dir)
        .map_err(|_| NativeRuntimeError::InvalidConfiguration)?;
    if let Some(path) = &config.native_path
        && !path.is_absolute()
    {
        return Err(NativeRuntimeError::InvalidConfiguration);
    }
    // Claude Code runs only at standard speed: fast mode can use paid extra
    // usage. The host rejects it earlier with a typed error; this is the
    // runtime's own fail-closed guard.
    if config.harness == HarnessKind::ClaudeCode
        && config
            .service_tier
            .as_deref()
            .is_some_and(|tier| tier != "standard")
    {
        return Err(NativeRuntimeError::InvalidConfiguration);
    }
    if config.harness == HarnessKind::PrimeAgent {
        if !is_isolated_daemon(config.daemon_socket.as_deref()) {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
        let Some(package_root) = config.package_root.as_deref() else {
            return Err(NativeRuntimeError::InvalidConfiguration);
        };
        let Some(agent_dir) = config.agent_dir.as_deref() else {
            return Err(NativeRuntimeError::InvalidConfiguration);
        };
        if !verified_prime_package_root(package_root) || !agent_dir.is_absolute() {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
        std::fs::create_dir_all(agent_dir).map_err(|_| NativeRuntimeError::InvalidConfiguration)?;
        if config
            .kernel_python
            .as_deref()
            .is_some_and(|path| !path.is_absolute() || !path.is_file())
        {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
    }
    Ok(())
}

fn verified_prime_package_root(root: &Path) -> bool {
    if !root.is_absolute() || !root.is_dir() {
        return false;
    }
    let Ok(bytes) = std::fs::read(root.join("package.json")) else {
        return false;
    };
    let Ok(package) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    package.get("name").and_then(Value::as_str) == Some("prime-agent")
        && matches!(
            package.get("version").and_then(Value::as_str),
            Some("0.9.2" | "0.9.3")
        )
}

fn is_isolated_daemon(socket: Option<&str>) -> bool {
    let Some(socket) = socket else {
        return false;
    };
    #[cfg(windows)]
    {
        socket.starts_with(r"\\.\pipe\piui-")
    }
    #[cfg(not(windows))]
    {
        let path = Path::new(socket);
        path.is_absolute()
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("piui-"))
    }
}

fn bridge_source(kind: HarnessKind) -> Result<Vec<u8>, NativeRuntimeError> {
    if kind == HarnessKind::Codex {
        return Ok(format!("{CODEX_SOURCE}\n{CODEX_POOL_SOURCE}\nglobalThis.__PIUI_BRIDGE_FACTORY__=(config,emit,coordinator)=>config.poolHost?createCodexPool(config,emit):createCodexAdapter(config,emit,coordinator);\n{RUNNER_SOURCE}").into_bytes());
    }
    let (factory, name) = match kind {
        HarnessKind::Pi => (PI_SOURCE, "createPiAdapter"),
        HarnessKind::PrimeAgent => (PRIME_SOURCE, "createPrimeAdapter"),
        HarnessKind::Codex => (CODEX_SOURCE, "createCodexAdapter"),
        HarnessKind::Hermes => (HERMES_SOURCE, "createHermesAdapter"),
        HarnessKind::ClaudeCode => (CLAUDE_SOURCE, "createClaudeAdapter"),
    };
    if factory.trim().is_empty() {
        return Err(NativeRuntimeError::HarnessUnavailable);
    }
    Ok(
        format!("{factory}\nglobalThis.__PIUI_BRIDGE_FACTORY__={name};\n{RUNNER_SOURCE}")
            .into_bytes(),
    )
}

struct ResolvedHarnessLaunch {
    program: PathBuf,
    args: Vec<String>,
    version: Option<String>,
}

fn resolve_harness_launch_for_config(
    config: &NativeRuntimeConfig,
) -> Result<ResolvedHarnessLaunch, NativeRuntimeError> {
    if config.harness == HarnessKind::Codex {
        let launch = resolve_harness_launch(HarnessKind::Codex)?;
        if !CODEX_APP_SERVER
            .check(launch.version.as_deref())
            .is_verified()
        {
            return Err(NativeRuntimeError::HarnessUnavailable);
        }
        return Ok(launch);
    }
    if config.harness == HarnessKind::ClaudeCode {
        let launch = resolve_claude_launch()?;
        if !claude_version_supported(launch.version.as_deref()) {
            return Err(NativeRuntimeError::HarnessUnavailable);
        }
        return Ok(launch);
    }
    if config.harness != HarnessKind::PrimeAgent {
        return resolve_harness_launch(config.harness);
    }
    let root = config
        .package_root
        .as_deref()
        .ok_or(NativeRuntimeError::HarnessUnavailable)?;
    if !verified_prime_package_root(root) {
        return Err(NativeRuntimeError::HarnessUnavailable);
    }
    let entry = root.join("dist/bundle/cli.js");
    if !entry.is_file() {
        return Err(NativeRuntimeError::HarnessUnavailable);
    }
    Ok(ResolvedHarnessLaunch {
        program: resolve_node()?,
        args: vec![entry.to_string_lossy().into_owned()],
        version: package_version(&entry),
    })
}

fn resolve_harness_launch(kind: HarnessKind) -> Result<ResolvedHarnessLaunch, NativeRuntimeError> {
    match kind {
        HarnessKind::Pi => {
            let launch = resolve_pi_launch().map_err(|_| NativeRuntimeError::HarnessUnavailable)?;
            if !launch.program.is_file() || launch.leading_args.is_empty() {
                return Err(NativeRuntimeError::HarnessUnavailable);
            }
            let version = launch
                .leading_args
                .first()
                .and_then(|path| package_version(Path::new(path)));
            Ok(ResolvedHarnessLaunch {
                program: launch.program,
                args: launch.leading_args,
                version,
            })
        }
        HarnessKind::PrimeAgent => resolve_package_launch("prime-agent", "dist/bundle/cli.js"),
        HarnessKind::Codex => resolve_package_launch("@openai/codex", "bin/codex.js"),
        HarnessKind::Hermes => resolve_hermes_launch(),
        HarnessKind::ClaudeCode => resolve_claude_launch(),
    }
}

/// Resolves the user's own installed Claude Code executable and verifies its
/// identity and version with `claude --version`. Only a native executable is
/// accepted: `.cmd`/`.ps1`/`.bat` shims need a shell, which is never used.
/// `PIUI_CLAUDE_BIN` is an authoritative override without fallback.
fn resolve_claude_launch() -> Result<ResolvedHarnessLaunch, NativeRuntimeError> {
    let program = claude_executable_candidates()
        .into_iter()
        .find(|candidate| is_native_claude_executable(candidate))
        .ok_or(NativeRuntimeError::HarnessUnavailable)?;
    let version = probe_claude_version(&program);
    Ok(ResolvedHarnessLaunch {
        program,
        args: Vec::new(),
        version,
    })
}

fn claude_executable_candidates() -> Vec<PathBuf> {
    if let Some(value) = std::env::var_os("PIUI_CLAUDE_BIN") {
        return vec![PathBuf::from(value)];
    }
    let executable = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = Vec::new();
    if cfg!(windows) {
        // The npm package installs the native executable itself as
        // `bin/claude.exe`; the global `claude.cmd` shim is never used.
        candidates.extend(
            global_package_roots()
                .into_iter()
                .map(|root| root.join("@anthropic-ai/claude-code/bin/claude.exe")),
        );
        if let Ok(home) = native_home_dir() {
            candidates.push(home.join(".local/bin/claude.exe"));
        }
    } else {
        if let Ok(home) = native_home_dir() {
            candidates.push(home.join(".local/bin/claude"));
            candidates.push(home.join(".claude/local/claude"));
        }
        candidates.extend(global_package_roots().into_iter().flat_map(|root| {
            let bin = root.join("@anthropic-ai/claude-code/bin");
            [bin.join("claude.exe"), bin.join("claude")]
        }));
    }
    if let Some(path) = std::env::var_os("PATH") {
        // Relative PATH entries would resolve against an arbitrary working
        // directory and are never searched.
        candidates.extend(
            std::env::split_paths(&path)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join(executable)),
        );
    }
    candidates
}

fn is_native_claude_executable(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    if cfg!(windows) {
        return path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
    }
    // A `.js` entry needs an interpreter; only a native executable is spawned.
    !path
        .extension()
        .is_some_and(|extension| matches!(extension.to_str(), Some("js" | "cjs" | "mjs")))
}

/// Parses `claude --version` output such as `2.1.232 (Claude Code)`. The
/// product marker proves the executable is Claude Code, not another `claude`.
fn parse_claude_version(output: &str) -> Option<String> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let version = line.strip_suffix("(Claude Code)")?.trim();
    parse_version_core(version)?;
    Some(version.to_owned())
}

fn parse_version_core(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

/// Accepts the tested release range `>=2.1.0 <3.0.0`, never an exact pin.
fn claude_version_supported(version: Option<&str>) -> bool {
    version.and_then(parse_version_core).is_some_and(|version| {
        version >= CLAUDE_MINIMUM_VERSION && version.0 < CLAUDE_MAXIMUM_MAJOR_EXCLUSIVE
    })
}

struct ClaudeVersionProbe {
    length: u64,
    modified: Option<std::time::SystemTime>,
    probed_at: std::time::Instant,
    version: Option<String>,
}

/// Runs `claude --version` at most once per executable revision. Discovery is
/// otherwise filesystem-only, so the result is cached; a failed probe is
/// retried after [`CLAUDE_VERSION_RETRY`]. Probes are serialized by the cache.
fn probe_claude_version(program: &Path) -> Option<String> {
    static CACHE: OnceLock<StdMutex<HashMap<PathBuf, ClaudeVersionProbe>>> = OnceLock::new();
    let metadata = std::fs::metadata(program).ok()?;
    let length = metadata.len();
    let modified = metadata.modified().ok();
    let mut cache = CACHE
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .ok()?;
    if let Some(probe) = cache.get(program)
        && probe.length == length
        && probe.modified == modified
        && (probe.version.is_some() || probe.probed_at.elapsed() < CLAUDE_VERSION_RETRY)
    {
        return probe.version.clone();
    }
    let version = run_claude_version(program);
    cache.insert(
        program.to_path_buf(),
        ClaudeVersionProbe {
            length,
            modified,
            probed_at: std::time::Instant::now(),
            version: version.clone(),
        },
    );
    version
}

/// The contained bridge process: the fixed bootstrap reads the bridge source
/// from stdin. Operator capabilities are never inherited; a Claude Code
/// bridge additionally starts without any non-subscription credential,
/// provider switch, billing override or parent-session coupling.
fn bridge_command(node: &Path, config: &NativeRuntimeConfig) -> std::process::Command {
    let mut standard = std::process::Command::new(node);
    for name in OPERATOR_ENVIRONMENT {
        standard.env_remove(name);
    }
    if config.harness == HarnessKind::ClaudeCode {
        scrub_claude_environment(&mut standard);
    }
    standard
        .args(["--input-type=module", "-e", NODE_BOOTSTRAP])
        .current_dir(&config.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        standard.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    standard
}

/// Removes every non-subscription credential, provider switch, billing
/// override and parent-session coupling from a Claude Code child environment.
fn scrub_claude_environment(command: &mut std::process::Command) {
    for name in CLAUDE_SCRUBBED_ENVIRONMENT
        .iter()
        .chain(OPERATOR_ENVIRONMENT)
    {
        command.env_remove(name);
    }
}

/// Executes `claude --version` inside the same containment as a runtime: a
/// Windows Job assigned before resume or an owned Unix process group. The
/// output is bounded and only the parsed version survives.
fn run_claude_version(program: &Path) -> Option<String> {
    use std::io::Read as _;
    let mut command = std::process::Command::new(program);
    scrub_claude_environment(&mut command);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    #[cfg(windows)]
    let mut job = WindowsJob::new().ok()?;
    let mut child = command.spawn().ok()?;
    #[cfg(windows)]
    {
        let resumed = ProcessId::new(child.id())
            .ok()
            .and_then(|pid| {
                job.assign_before_resume(SuspendedProcess::from_created_suspended(pid))
                    .ok()
            })
            .and_then(|assignment| job.resume_assigned(assignment).ok());
        if resumed.is_none() {
            let _ = job.force_terminate_tree();
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    }
    #[cfg(unix)]
    let mut group = {
        let Some(id) = i32::try_from(child.id())
            .ok()
            .and_then(|pid| ProcessGroupId::new(pid).ok())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        UnixProcessGroup::from_spawned_group(id)
    };
    let deadline = std::time::Instant::now() + CLAUDE_VERSION_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => break None,
        }
    };
    // The whole tree is retired whether or not the probe finished in time.
    #[cfg(windows)]
    {
        let _ = job.force_terminate_tree();
        let _ = job.close();
    }
    #[cfg(unix)]
    {
        let _ = group.force_terminate_tree();
        group.discard_after_supervisor_cleanup();
    }
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    if !status.success() {
        return None;
    }
    let mut output = String::new();
    child
        .stdout
        .take()?
        .take(CLAUDE_VERSION_OUTPUT_LIMIT)
        .read_to_string(&mut output)
        .ok()?;
    parse_claude_version(&output)
}

/// Last native account verdict of Claude Code in this host process: set when
/// a start is refused because the login is not a Claude subscription, cleared
/// by the next start that verifies one. No credential is read or stored.
static CLAUDE_SIGN_IN_REQUIRED: AtomicBool = AtomicBool::new(false);

fn record_native_account(harness: HarnessKind, outcome: Result<(), &NativeRuntimeError>) {
    if harness != HarnessKind::ClaudeCode {
        return;
    }
    match outcome {
        Ok(()) => CLAUDE_SIGN_IN_REQUIRED.store(false, Ordering::Release),
        Err(NativeRuntimeError::Bridge(BridgeFailureCode::SubscriptionRequired)) => {
            CLAUDE_SIGN_IN_REQUIRED.store(true, Ordering::Release);
        }
        Err(_) => {}
    }
}

/// Whether the last Claude Code start was refused for a missing Claude
/// subscription login.
#[must_use]
pub fn claude_sign_in_required() -> bool {
    CLAUDE_SIGN_IN_REQUIRED.load(Ordering::Acquire)
}

fn resolve_hermes_launch() -> Result<ResolvedHarnessLaunch, NativeRuntimeError> {
    let root = std::env::var_os("PIUI_HERMES_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            if cfg!(windows) {
                std::env::var_os("LOCALAPPDATA")
                    .map(|base| PathBuf::from(base).join("hermes/hermes-agent"))
            } else {
                native_home_dir()
                    .ok()
                    .map(|home| home.join(".hermes/hermes-agent"))
            }
        })
        .ok_or(NativeRuntimeError::HarnessUnavailable)?;
    let python = root.join(if cfg!(windows) {
        "venv/Scripts/python.exe"
    } else {
        "venv/bin/python"
    });
    if !python.is_file() {
        return Err(NativeRuntimeError::HarnessUnavailable);
    }
    let manifest = std::fs::read_to_string(root.join("hermes_cli/__init__.py"))
        .map_err(|_| NativeRuntimeError::HarnessUnavailable)?;
    let version = manifest.lines().find_map(|line| {
        line.strip_prefix("__version__ = ")
            .map(|value| value.trim_matches('"').to_owned())
    });
    Ok(ResolvedHarnessLaunch {
        program: python,
        args: vec!["-m".into(), "acp_adapter".into()],
        version,
    })
}

fn resolve_package_launch(
    package: &str,
    relative_entry: &str,
) -> Result<ResolvedHarnessLaunch, NativeRuntimeError> {
    let entry = global_package_roots()
        .into_iter()
        .map(|root| root.join(package).join(relative_entry))
        .find(|path| path.is_file())
        .ok_or(NativeRuntimeError::HarnessUnavailable)?;
    let node = resolve_node()?;
    let version = package_version(&entry);
    Ok(ResolvedHarnessLaunch {
        program: node,
        args: vec![entry.to_string_lossy().into_owned()],
        version,
    })
}

fn package_version(entry: &Path) -> Option<String> {
    for ancestor in entry.ancestors().skip(1) {
        let manifest = ancestor.join("package.json");
        if !manifest.is_file() {
            continue;
        }
        let value: Value = serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
        if let Some(version) = value.get("version").and_then(Value::as_str) {
            return Some(version.to_owned());
        }
    }
    None
}

pub(crate) fn resolve_node() -> Result<PathBuf, NativeRuntimeError> {
    if let Some(value) = std::env::var_os("PIUI_NODE") {
        let path = PathBuf::from(value);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH").ok_or(NativeRuntimeError::NodeUnavailable)?;
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(NativeRuntimeError::NodeUnavailable)
}

fn global_package_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm/node_modules"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("pnpm/global/5/node_modules"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".npm-global/lib/node_modules"));
        roots.push(home.join(".local/share/npm/lib/node_modules"));
        roots.push(home.join(".pnpm-global/lib/node_modules"));
    }
    roots.push(PathBuf::from("/usr/local/lib/node_modules"));
    roots.push(PathBuf::from("/usr/lib/node_modules"));
    roots
}

fn capability(supported: bool, enforcement: Enforcement, reason: Option<&str>) -> Capability {
    Capability {
        supported,
        enforcement,
        reason: reason.map(str::to_owned),
    }
}

fn unavailable_capabilities(reason: &str) -> HarnessCapabilities {
    let unavailable = capability(false, Enforcement::Unsupported, Some(reason));
    HarnessCapabilities {
        prompt: unavailable.clone(),
        resume: unavailable.clone(),
        models: unavailable.clone(),
        approvals: unavailable.clone(),
        instructions: unavailable.clone(),
        tool_policy: unavailable.clone(),
        native_subagents: unavailable,
    }
}

/// Side-effect-free capability description for scheduler admission. If the
/// installed version or platform is not verified, every capability is returned
/// unsupported so no durable task can reserve against an unproven adapter.
#[must_use]
pub fn offline_harness_capabilities(kind: HarnessKind) -> HarnessCapabilities {
    let summary = probe_native_harnesses()
        .into_iter()
        .find(|summary| summary.kind == kind);
    if !summary.is_some_and(|summary| summary.status == HarnessAvailability::Available) {
        return unavailable_capabilities(
            "The installed native adapter is unavailable or unverified.",
        );
    }
    // A managed run cannot start while Claude Code is known to be signed in
    // with something other than the user's Claude subscription.
    if kind == HarnessKind::ClaudeCode && claude_sign_in_required() {
        return unavailable_capabilities(CLAUDE_SIGN_IN_MESSAGE);
    }
    verified_harness_capabilities(kind)
}

/// Capabilities of a verified, available adapter.
fn verified_harness_capabilities(kind: HarnessKind) -> HarnessCapabilities {
    match kind {
        HarnessKind::Pi => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(true, Enforcement::Native, None),
            approvals: capability(true, Enforcement::Native, None),
            instructions: capability(true, Enforcement::Native, None),
            tool_policy: capability(
                true,
                Enforcement::Native,
                Some("Pi RPC supports a native read-only or explicit tool allowlist policy."),
            ),
            native_subagents: capability(
                false,
                Enforcement::Unsupported,
                Some("Native subagent policy is not exposed by Pi RPC."),
            ),
        },
        HarnessKind::PrimeAgent => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(true, Enforcement::Native, None),
            approvals: capability(
                false,
                Enforcement::Unsupported,
                Some("Prime headless approval mapping is not implemented."),
            ),
            instructions: capability(true, Enforcement::Native, None),
            tool_policy: capability(true, Enforcement::Native, None),
            native_subagents: capability(true, Enforcement::Native, None),
        },
        HarnessKind::Hermes => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(true, Enforcement::Native, None),
            approvals: capability(true, Enforcement::Native, None),
            instructions: capability(true, Enforcement::Coordinator, None),
            tool_policy: capability(
                false,
                Enforcement::Unsupported,
                Some("Hermes ACP does not expose per-session tool restrictions."),
            ),
            native_subagents: capability(
                false,
                Enforcement::Unsupported,
                Some("Hermes ACP does not expose native delegation restrictions."),
            ),
        },
        HarnessKind::Codex => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(true, Enforcement::Native, None),
            approvals: capability(true, Enforcement::Native, None),
            instructions: capability(true, Enforcement::Native, None),
            tool_policy: capability(
                false,
                Enforcement::Unsupported,
                Some("Codex app-server has no restrictive tool allowlist contract."),
            ),
            native_subagents: capability(true, Enforcement::Native, None),
        },
        // These labels describe managed runs, the only consumer of the offline
        // table. They are Claude Code's own engine, not an OS sandbox.
        HarnessKind::ClaudeCode => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(
                true,
                Enforcement::Native,
                Some("Models and effort levels come from the Claude Code initialize catalog."),
            ),
            approvals: capability(
                true,
                Enforcement::Native,
                Some(
                    "Claude Code permission prompts; read-only and workspace-write sessions can only deny them.",
                ),
            ),
            instructions: capability(
                true,
                Enforcement::Native,
                Some("Appended to Claude Code's own system prompt; the base prompt is kept."),
            ),
            tool_policy: capability(
                true,
                Enforcement::Native,
                Some(
                    "Claude Code built-in tool allowlist; user MCP servers are excluded under a policy.",
                ),
            ),
            native_subagents: capability(
                true,
                Enforcement::Coordinator,
                Some(
                    "Managed runs disable the native Agent tool and delegate through the PiUI coordinator.",
                ),
            ),
        },
    }
}

/// Tested native release range of each adapter. Pi is resolved from its own
/// verified CLI launcher and has no separate pin.
fn harness_version_supported(kind: HarnessKind, version: Option<&str>) -> bool {
    match kind {
        HarnessKind::Pi => true,
        HarnessKind::PrimeAgent => matches!(version, Some("0.9.2" | "0.9.3")),
        HarnessKind::Codex => CODEX_APP_SERVER.check(version).is_verified(),
        HarnessKind::Hermes => version == Some("0.21.0"),
        HarnessKind::ClaudeCode => claude_version_supported(version),
    }
}

/// Offline installed-harness metadata. This performs filesystem reads only,
/// except Claude Code's cached `claude --version` identity probe.
#[must_use]
pub fn probe_native_harnesses() -> Vec<NativeHarnessSummary> {
    HarnessKind::ALL
    .into_iter()
    .map(|kind| match resolve_harness_launch(kind) {
        Ok(launch) => {
            let codex_version_reason = (kind == HarnessKind::Codex)
                .then(|| CODEX_APP_SERVER.check(launch.version.as_deref()))
                .and_then(VersionCheck::unverified_reason);
            let version_supported = harness_version_supported(kind, launch.version.as_deref());
            let platform_verified = cfg!(windows);
            let (status, reason) = if let Some(reason) = codex_version_reason {
                (HarnessAvailability::Unverified, Some(reason.into()))
            } else if !version_supported {
                (
                    HarnessAvailability::Unverified,
                    Some(if kind != HarnessKind::ClaudeCode {
                        "The installed native harness version is not supported by this adapter."
                            .into()
                    } else if launch.version.is_some() {
                        "The installed Claude Code version is outside the tested range (2.1 or a later 2.x release)."
                            .into()
                    } else {
                        "Claude Code could not be verified with `claude --version`.".into()
                    }),
                )
            } else if !platform_verified {
                (
                    HarnessAvailability::Unverified,
                    Some(
                        "Native lifecycle containment is not yet verified on this platform.".into(),
                    ),
                )
            } else if kind == HarnessKind::ClaudeCode && claude_sign_in_required() {
                // Still startable: the next start verifies the native login again.
                (
                    HarnessAvailability::Available,
                    Some(CLAUDE_SIGN_IN_MESSAGE.into()),
                )
            } else {
                (HarnessAvailability::Available, None)
            };
            NativeHarnessSummary {
                kind,
                name: kind.display_name().into(),
                installed: true,
                version: launch.version,
                status,
                reason,
            }
        }
        Err(NativeRuntimeError::NodeUnavailable) => NativeHarnessSummary {
            kind,
            name: kind.display_name().into(),
            installed: false,
            version: None,
            status: HarnessAvailability::Unavailable,
            reason: Some("Node is unavailable.".into()),
        },
        Err(_) => NativeHarnessSummary {
            kind,
            name: kind.display_name().into(),
            installed: false,
            version: None,
            status: HarnessAvailability::Unavailable,
            reason: Some("The native harness is not installed.".into()),
        },
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities() -> Value {
        json!({
            "prompt": {"supported":true,"enforcement":"native"},
            "resume": {"supported":true,"enforcement":"native"},
            "models": {"supported":true,"enforcement":"native"},
            "approvals": {"supported":true,"enforcement":"native"},
            "instructions": {"supported":false,"enforcement":"unsupported"},
            "toolPolicy": {"supported":true,"enforcement":"native"},
            "nativeSubagents": {"supported":false,"enforcement":"unsupported"}
        })
    }

    fn test_config() -> NativeRuntimeConfig {
        let cwd = std::env::current_dir().expect("cwd");
        NativeRuntimeConfig {
            harness: HarnessKind::Pi,
            cwd: cwd.clone(),
            session_dir: cwd,
            native_id: None,
            native_path: None,
            title: None,
            model: None,
            thinking_level: None,
            base_instructions: None,
            service_tier: None,
            resource_rules: None,
            instructions: None,
            permission_mode: PermissionMode::Native,
            network_access: false,
            allowed_tools: None,
            native_subagents: None,
            daemon_socket: None,
            package_root: None,
            agent_dir: None,
            kernel_python: None,
            coordination: false,
        }
    }

    #[tokio::test]
    #[ignore = "uses the installed Codex for prompt-free lifecycle verification"]
    async fn pooled_codex_sessions_share_process_and_close_independently() {
        let root =
            std::env::temp_dir().join(format!("piui-codex-pool-lifecycle-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("isolated cwd");
        let mut config = test_config();
        config.cwd = std::fs::canonicalize(&root).expect("canonical cwd");
        config.harness = HarnessKind::Codex;
        config.coordination = true;
        config.session_dir = root.join("one");
        let (one, _one_events) = NativeRuntime::spawn(config.clone())
            .await
            .expect("first pooled session");
        config.session_dir = root.join("two");
        let (two, _two_events) = NativeRuntime::spawn(config)
            .await
            .expect("second pooled session");
        let one_pool = &one.pooled.as_ref().expect("pooled").0;
        let two_pool = &two.pooled.as_ref().expect("pooled").0;
        assert!(Arc::ptr_eq(one_pool, two_pool));
        assert_ne!(
            one.snapshot().await.expect("first").native_id,
            two.snapshot().await.expect("second").native_id
        );
        one.begin_retirement();
        one.dispose().await.expect("close first only");
        assert_eq!(
            two.snapshot().await.expect("second stays open").status,
            SessionStatus::Idle
        );
        two.dispose().await.expect("close second");
    }

    async fn spawn_test_bridge(
        factory_body: &str,
    ) -> Result<(NativeRuntime, NativeEventReceiver), NativeRuntimeError> {
        NativeRuntime::spawn_test_adapter(test_config(), factory_body).await
    }

    fn test_shared(shutting_down: bool) -> Arc<RuntimeShared> {
        Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(shutting_down),
        })
    }

    fn delta_frame(session_id: Option<&str>, block_id: &str, text: &str) -> Vec<u8> {
        let event = json!({"type":"textDelta","blockId":block_id,"text":text});
        let frame = match session_id {
            Some(session_id) => json!({"sessionId":session_id,"event":event}),
            None => json!({"event":event}),
        };
        let mut bytes = serde_json::to_vec(&frame).expect("frame");
        bytes.push(b'\n');
        bytes
    }

    fn delta_text(event: Option<NativeEvent>, expected_block: &str) -> String {
        match event {
            Some(NativeEvent::TextDelta { block_id, text }) if block_id == expected_block => text,
            other => panic!("expected a text delta for {expected_block}, got {other:?}"),
        }
    }

    const MOCK_SNAPSHOT: &str = r#"{nativeId:'native-private',materialized:false,title:'Mock',status:'idle',blocks:[],approvals:[],capabilities:{prompt:{supported:true,enforcement:'native'},resume:{supported:true,enforcement:'native'},models:{supported:true,enforcement:'native'},approvals:{supported:true,enforcement:'native'},instructions:{supported:false,enforcement:'unsupported'},toolPolicy:{supported:true,enforcement:'native'},nativeSubagents:{supported:false,enforcement:'unsupported'}},models:[]}"#;

    #[tokio::test]
    async fn burst_beyond_the_event_queue_waits_for_a_slow_consumer_in_order() {
        const BURST: usize = EVENT_CHANNEL_CAPACITY * 8;
        let shared = test_shared(true);
        let bytes = (0..BURST)
            .flat_map(|index| delta_frame(None, "answer", &format!("{index},")))
            .collect::<Vec<_>>();
        let (events, mut receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let reader = tokio::spawn(read_bridge_stdout(
            std::io::Cursor::new(bytes),
            Arc::clone(&shared),
            events,
            None,
        ));
        // The reader fills the queue and then waits instead of failing.
        tokio::time::timeout(Duration::from_secs(10), async {
            while receiver.len() < EVENT_CHANNEL_CAPACITY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the reader fills the queue");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!reader.is_finished(), "a full queue is backpressure");
        assert!(shared.accepting.load(Ordering::Acquire));
        let mut received = Vec::with_capacity(BURST);
        while received.len() < BURST {
            received.push(delta_text(receiver.recv().await, "answer"));
            if received.len() % 64 == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        reader.await.expect("reader finishes after the burst");
        assert!(
            received
                .iter()
                .enumerate()
                .all(|(index, text)| *text == format!("{index},"))
        );
        assert!(receiver.recv().await.is_none(), "no failure notification");
        assert!(shared.accepting.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn pooled_backpressure_waits_outside_the_route_table_and_keeps_order() {
        const FRAMES: usize = 40;
        let shared = test_shared(true);
        let (first_sender, mut first) = mpsc::channel(2);
        let (second_sender, mut second) = mpsc::channel(FRAMES);
        for (session_id, sender) in [("first", first_sender), ("second", second_sender)] {
            shared
                .session_events
                .lock()
                .await
                .insert(session_id.into(), (sender, Arc::new(AtomicBool::new(true))));
        }
        let bytes = (0..FRAMES)
            .flat_map(|index| {
                let mut frames = delta_frame(Some("first"), "first", &index.to_string());
                frames.extend(delta_frame(Some("second"), "second", &index.to_string()));
                frames
            })
            .collect::<Vec<_>>();
        let (own_events, _own_receiver) = mpsc::channel(1);
        let reader = tokio::spawn(read_bridge_stdout(
            std::io::Cursor::new(bytes),
            Arc::clone(&shared),
            own_events,
            None,
        ));
        tokio::time::timeout(Duration::from_secs(10), async {
            while first.len() < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the stalled session queue fills");
        assert!(
            !reader.is_finished(),
            "a stalled pooled consumer is backpressure"
        );
        // Opening or retiring another pooled session is not blocked by it.
        drop(
            tokio::time::timeout(Duration::from_secs(1), shared.session_events.lock())
                .await
                .expect("the route table is free while the reader waits"),
        );
        let mut first_texts = Vec::new();
        while first_texts.len() < FRAMES {
            first_texts.push(delta_text(first.recv().await, "first"));
        }
        reader.await.expect("reader finishes");
        let mut second_texts = Vec::new();
        while let Ok(event) = second.try_recv() {
            second_texts.push(delta_text(Some(event), "second"));
        }
        let expected = (0..FRAMES)
            .map(|index| index.to_string())
            .collect::<Vec<_>>();
        assert_eq!(first_texts, expected);
        assert_eq!(second_texts, expected);
        assert!(shared.accepting.load(Ordering::Acquire));
    }

    fn delta(block_id: &str, text: &str) -> NativeEvent {
        NativeEvent::TextDelta {
            block_id: block_id.into(),
            text: text.into(),
        }
    }

    /// Joins adjacent deltas of one block, the only transformation retention
    /// may apply, so streams can be compared independent of scheduling.
    fn normalized(events: Vec<NativeEvent>) -> Vec<NativeEvent> {
        let mut merged: Vec<NativeEvent> = Vec::new();
        for event in events {
            if let NativeEvent::TextDelta { block_id, text } = &event
                && let Some(NativeEvent::TextDelta {
                    block_id: previous_block,
                    text: previous_text,
                }) = merged.last_mut()
                && previous_block == block_id
            {
                previous_text.push_str(text);
                continue;
            }
            merged.push(event);
        }
        merged
    }

    #[tokio::test]
    async fn buffer_while_drains_beyond_capacity_and_preserves_order() {
        let (sender, receiver) = mpsc::channel(2);
        let mut events = NativeEventReceiver::from(receiver);
        let sent = vec![
            delta("one", "a"),
            delta("one", "b"),
            delta("one", "c"),
            NativeEvent::Status {
                status: SessionStatus::Idle,
            },
            delta("one", "d"),
            delta("two", "e"),
            delta("two", "f"),
        ];
        // More events than the queue holds: the awaited work can only finish
        // because `buffer_while` keeps draining meanwhile.
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            events.buffer_while(async {
                for event in sent.clone() {
                    sender.send(event).await.expect("receiver alive");
                }
                "response"
            }),
        )
        .await
        .expect("the awaited work is never blocked by its own events");
        assert_eq!(response, "response");
        drop(sender);
        let mut received = Vec::new();
        while let Some(event) = events.recv().await {
            received.push(event);
        }
        assert_eq!(normalized(received), normalized(sent));
    }

    #[test]
    fn retained_deltas_merge_only_within_one_consecutive_block() {
        let (_sender, receiver) = mpsc::channel(1);
        let mut events = NativeEventReceiver::from(receiver);
        for event in [
            delta("one", "a"),
            delta("one", "b"),
            NativeEvent::Status {
                status: SessionStatus::Running,
            },
            delta("one", "c"),
            delta("two", "d"),
            delta("two", "e"),
        ] {
            events.retain(event);
        }
        assert_eq!(delta_text(events.try_recv(), "one"), "ab");
        assert!(matches!(
            events.try_recv(),
            Some(NativeEvent::Status {
                status: SessionStatus::Running
            })
        ));
        assert_eq!(delta_text(events.try_recv(), "one"), "c");
        assert_eq!(delta_text(events.try_recv(), "two"), "de");
        assert!(events.try_recv().is_none());
    }

    #[tokio::test]
    async fn native_burst_beyond_queue_capacity_keeps_the_runtime_alive() {
        const BURST: usize = 5_000;
        let factory = format!(
            "return {{snapshot(){{return {MOCK_SNAPSHOT}}},prompt(){{for(let i=0;i<{BURST};i+=1)emit({{type:'textDelta',blockId:'answer',text:`${{i}},`}});return {{accepted:true}}}},dispose(){{}}}}"
        );
        let (runtime, mut events) = spawn_test_bridge(&factory)
            .await
            .expect("spawn mock bridge");
        let runtime = Arc::new(runtime);
        let prompt = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            async move { runtime.prompt("burst".into(), PromptMode::Prompt).await }
        });
        let mut text = String::new();
        for index in 0..BURST {
            text.push_str(&delta_text(events.recv().await, "answer"));
            if index % 250 == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        prompt
            .await
            .expect("prompt task")
            .expect("a slow consumer never fails the runtime");
        let expected = (0..BURST)
            .map(|index| format!("{index},"))
            .collect::<String>();
        assert_eq!(text, expected);
        assert_eq!(
            runtime.snapshot().await.expect("still healthy").status,
            SessionStatus::Idle
        );
        runtime.dispose().await.expect("dispose");
    }

    #[tokio::test]
    async fn initialize_history_replay_beyond_queue_capacity_is_retained_in_order() {
        const HISTORY: usize = EVENT_CHANNEL_CAPACITY * 4;
        let factory = format!(
            "for(let i=0;i<{HISTORY};i+=1)emit({{type:'block',block:{{id:`history-${{i}}`,kind:'user',label:'You',status:'complete',text:`message ${{i}}`}}}});return {{dispose(){{}}}}"
        );
        let (runtime, mut events) = spawn_test_bridge(&factory)
            .await
            .expect("initialize is not blocked by its own history replay");
        for index in 0..HISTORY {
            match events.recv().await {
                Some(NativeEvent::Block { block }) => {
                    assert_eq!(block.id, format!("history-{index}"));
                }
                other => panic!("expected replayed history, got {other:?}"),
            }
        }
        runtime.dispose().await.expect("dispose");
    }

    #[tokio::test]
    async fn retirement_releases_a_reader_waiting_on_an_undrained_queue() {
        let factory = format!(
            "return {{snapshot(){{for(let i=0;i<2000;i+=1)emit({{type:'textDelta',blockId:'b',text:'x'}});return {MOCK_SNAPSHOT}}},dispose(){{}}}}"
        );
        let (runtime, events) = spawn_test_bridge(&factory)
            .await
            .expect("spawn mock bridge");
        let runtime = Arc::new(runtime);
        let snapshot = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            async move { runtime.snapshot().await }
        });
        // Nobody drains: the response stays queued behind the burst.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!snapshot.is_finished());
        runtime.begin_retirement();
        drop(events);
        tokio::time::timeout(Duration::from_secs(10), snapshot)
            .await
            .expect("the response is routed after retirement")
            .expect("snapshot task")
            .expect("in-flight snapshot completes");
        tokio::time::timeout(Duration::from_secs(10), runtime.dispose())
            .await
            .expect("dispose is not blocked by the retired queue")
            .expect("dispose");
    }

    #[test]
    fn serde_matches_contract_spellings() {
        assert_eq!(
            serde_json::to_value(PermissionMode::Native).ok(),
            Some(json!("native"))
        );
        assert_eq!(
            serde_json::to_value(PromptMode::FollowUp).ok(),
            Some(json!("follow-up"))
        );
        assert_eq!(
            serde_json::to_value(ApprovalDecision::ApproveOnce).ok(),
            Some(json!("approve-once"))
        );
        let event: NativeEvent =
            serde_json::from_value(json!({"type":"textDelta","blockId":"b","text":"x"}))
                .expect("event");
        assert!(matches!(event, NativeEvent::TextDelta { .. }));
        let terminal: NativeEvent =
            serde_json::from_value(json!({"type":"turnCompleted","outcome":"failed"}))
                .expect("terminal event");
        assert!(matches!(
            terminal,
            NativeEvent::TurnCompleted {
                outcome: TurnOutcome::Failed
            }
        ));
    }

    #[tokio::test]
    async fn routes_parallel_out_of_order_responses() {
        let shared = Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(false),
        });
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        shared.pending.lock().await.insert("one".into(), tx1);
        shared.pending.lock().await.insert("two".into(), tx2);
        let (events, _) = mpsc::channel(1);
        route_bridge_frame(json!({"id":"two","ok":true,"result":2}), &shared, &events)
            .await
            .expect("second");
        route_bridge_frame(json!({"id":"one","ok":true,"result":1}), &shared, &events)
            .await
            .expect("first");
        assert_eq!(rx1.await.expect("rx").expect("ok"), json!(1));
        assert_eq!(rx2.await.expect("rx").expect("ok"), json!(2));
    }

    #[tokio::test]
    async fn rejects_unknown_response_but_ignores_late_timeout() {
        let shared = Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::from(["late".into()])),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(false),
        });
        let (events, _) = mpsc::channel(1);
        route_bridge_frame(
            json!({"id":"late","ok":true,"result":null}),
            &shared,
            &events,
        )
        .await
        .expect("late timeout ignored");
        assert_eq!(
            route_bridge_frame(
                json!({"id":"unknown","ok":true,"result":null}),
                &shared,
                &events
            )
            .await,
            Err(NativeRuntimeError::Protocol)
        );
    }

    #[tokio::test]
    async fn lf_codec_keeps_unicode_separators_inside_one_corrupt_frame() {
        let shared = Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(false),
        });
        let (events, mut receiver) = mpsc::channel(4);
        let bytes = b"{\"event\":{\"type\":\"status\",\"status\":\"idle\"}}\xe2\x80\xa8{\"event\":{\"type\":\"status\",\"status\":\"idle\"}}\n";
        read_bridge_stdout(&bytes[..], shared, events, None).await;
        assert!(matches!(
            receiver.recv().await,
            Some(NativeEvent::Status {
                status: SessionStatus::Failed
            })
        ));
    }

    #[test]
    fn approval_options_are_optional_and_strict() {
        let legacy: NativeEvent = serde_json::from_value(json!({
            "type": "approval",
            "approval": {"id":"a","kind":"input","title":"t","description":"d","decisions":["cancel"]}
        }))
        .expect("approval without options");
        assert!(matches!(
            legacy,
            NativeEvent::Approval { approval } if approval.options.is_none()
        ));

        let select = json!({
            "id": "a", "kind": "input", "title": "Allow?", "description": "d",
            "decisions": ["approve-once", "cancel"],
            "options": [{"id":"option-1","label":"Allow"},{"id":"option-2","label":"Block"}]
        });
        let approval: NativeApproval = serde_json::from_value(select.clone()).expect("select");
        assert_eq!(
            approval.options,
            Some(vec![
                ApprovalOption {
                    id: "option-1".into(),
                    label: "Allow".into()
                },
                ApprovalOption {
                    id: "option-2".into(),
                    label: "Block".into()
                },
            ])
        );
        assert_eq!(serde_json::to_value(&approval).ok(), Some(select));

        let leaked = json!({
            "id": "a", "kind": "input", "title": "t", "description": "d", "decisions": ["cancel"],
            "options": [{"id":"option-1","label":"Allow","value":"native"}]
        });
        assert!(serde_json::from_value::<NativeApproval>(leaked).is_err());
    }

    #[test]
    fn snapshot_contract_deserializes() {
        let value = json!({"nativeId":"private","materialized":false,"title":"title","status":"idle","blocks":[],"approvals":[],"capabilities":capabilities(),"models":[]});
        let snapshot: NativeSnapshot = serde_json::from_value(value).expect("snapshot");
        assert_eq!(snapshot.native_id, "private");
        assert_eq!(snapshot.materialized, Some(false));

        let legacy = json!({"nativeId":"private","title":"title","status":"idle","blocks":[],"approvals":[],"capabilities":capabilities(),"models":[]});
        let legacy: NativeSnapshot = serde_json::from_value(legacy).expect("legacy snapshot");
        assert_eq!(legacy.materialized, None);
    }

    #[test]
    fn prime_daemon_guard_is_platform_specific_and_fail_closed() {
        assert!(!is_isolated_daemon(None));
        assert!(!is_isolated_daemon(Some("default")));
        #[cfg(windows)]
        assert!(is_isolated_daemon(Some(r"\\.\pipe\piui-test")));
        #[cfg(not(windows))]
        assert!(is_isolated_daemon(Some("/tmp/piui-test")));
    }

    #[tokio::test]
    async fn fragmented_lf_frame_decodes() {
        let shared = Arc::new(RuntimeShared {
            session_events: Mutex::new(HashMap::new()),
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: Arc::new(AtomicBool::new(true)),
            shutting_down: AtomicBool::new(true),
        });
        let (events, mut receiver) = mpsc::channel(2);
        let (mut writer, reader) = tokio::io::duplex(128);
        let task = tokio::spawn(read_bridge_stdout(reader, shared, events, None));
        writer
            .write_all(b"{\"event\":{\"type\":\"status\",")
            .await
            .expect("first");
        writer
            .write_all(b"\"status\":\"idle\"}}\n")
            .await
            .expect("second");
        drop(writer);
        task.await.expect("reader");
        assert!(matches!(
            receiver.recv().await,
            Some(NativeEvent::Status {
                status: SessionStatus::Idle
            })
        ));
    }

    #[tokio::test]
    async fn mock_bridge_lifecycle_snapshot_and_dispose() {
        let factory = r#"return {snapshot(){return {nativeId:'native-private',materialized:false,title:'Mock',status:'idle',blocks:[],approvals:[],capabilities:{prompt:{supported:true,enforcement:'native'},resume:{supported:true,enforcement:'native'},models:{supported:true,enforcement:'native'},approvals:{supported:true,enforcement:'native'},instructions:{supported:false,enforcement:'unsupported'},toolPolicy:{supported:true,enforcement:'native'},nativeSubagents:{supported:false,enforcement:'unsupported'}},models:[]}},prompt(){return {accepted:true}},interrupt(){},models(){return []},setModel(){},respond(){},rename(){},dispose(){}}"#;
        let (runtime, _events) = spawn_test_bridge(factory).await.expect("spawn mock bridge");
        let snapshot = runtime.snapshot().await.expect("snapshot");
        assert_eq!(snapshot.native_id, "native-private");
        runtime.dispose().await.expect("dispose");
        assert_eq!(
            runtime.snapshot().await,
            Err(NativeRuntimeError::NotRunning)
        );
    }

    #[tokio::test]
    async fn explicit_retirement_routes_dispose_after_event_receiver_closes() {
        let factory = r#"return {dispose(){emit({type:'status',status:'closed'})}}"#;
        let (runtime, events) = spawn_test_bridge(factory).await.expect("spawn mock bridge");
        runtime.begin_retirement();
        drop(events);
        runtime
            .dispose()
            .await
            .expect("dispose response remains routable during explicit retirement");
    }

    #[tokio::test]
    async fn unexpectedly_closed_active_event_receiver_fails_closed() {
        let factory = r#"return {prompt(){emit({type:'status',status:'idle'});return {accepted:true}},dispose(){}}"#;
        let (runtime, events) = spawn_test_bridge(factory).await.expect("spawn mock bridge");
        drop(events);
        assert_eq!(
            runtime.prompt("test".into(), PromptMode::Prompt).await,
            Err(NativeRuntimeError::Protocol)
        );
        runtime.terminate().await.expect("terminate containment");
    }

    #[tokio::test]
    async fn unexpected_bridge_exit_fails_pending_request() {
        let factory = r#"return {snapshot(){process.exit(17)},dispose(){}}"#;
        let (runtime, mut events) = spawn_test_bridge(factory).await.expect("spawn mock bridge");
        assert_eq!(
            runtime.snapshot().await,
            Err(NativeRuntimeError::UnexpectedExit)
        );
        assert!(matches!(
            events.recv().await,
            Some(NativeEvent::Status {
                status: SessionStatus::Failed
            })
        ));
        runtime.terminate().await.expect("terminate containment");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_bridge_initializes_only_after_job_assignment_and_resume() {
        // Node cannot answer initialize while suspended. A successful handshake
        // therefore proves assignment + resume completed before adapter code ran.
        let factory = r#"return {dispose(){}}"#;
        let (runtime, _events) = spawn_test_bridge(factory)
            .await
            .expect("contained handshake");
        runtime.dispose().await.expect("contained dispose");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_bridge_initializes_inside_owned_process_group() {
        let factory = r#"return {dispose(){}}"#;
        let (runtime, _events) = spawn_test_bridge(factory).await.expect("group handshake");
        runtime.dispose().await.expect("group dispose");
    }

    #[test]
    fn claude_code_identity_is_additive_kebab_case() {
        assert_eq!(
            serde_json::to_value(HarnessKind::ClaudeCode).ok(),
            Some(json!("claude-code"))
        );
        assert_eq!(
            serde_json::from_value::<HarnessKind>(json!("claude-code")).ok(),
            Some(HarnessKind::ClaudeCode)
        );
        assert_eq!(HarnessKind::ClaudeCode.display_name(), "Claude Code");
        // Existing identities keep their exact spelling.
        for (kind, name) in [
            (HarnessKind::Pi, "pi"),
            (HarnessKind::PrimeAgent, "prime-agent"),
            (HarnessKind::Codex, "codex"),
            (HarnessKind::Hermes, "hermes"),
        ] {
            assert_eq!(serde_json::to_value(kind).ok(), Some(json!(name)));
            assert_eq!(
                serde_json::from_value::<HarnessKind>(json!(name)).ok(),
                Some(kind)
            );
        }
        for alias in ["claude", "claude_code", "ClaudeCode"] {
            assert!(serde_json::from_value::<HarnessKind>(json!(alias)).is_err());
        }
        assert_eq!(HarnessKind::ALL.len(), 5);
    }

    #[test]
    fn claude_bridge_embeds_the_claude_factory_and_common_runner() {
        let source = String::from_utf8(
            bridge_source(HarnessKind::ClaudeCode).expect("Claude Code bridge source"),
        )
        .expect("bridge source is UTF-8");
        assert!(source.contains("export async function createClaudeAdapter("));
        assert!(source.contains("globalThis.__PIUI_BRIDGE_FACTORY__=createClaudeAdapter;"));
        assert!(source.contains("export function runBridge("));
        assert!(
            !source.contains("\"--bare\""),
            "bare mode requires an API key and is never passed"
        );
    }

    #[test]
    fn claude_version_is_verified_by_identity_and_a_range() {
        assert_eq!(
            parse_claude_version("2.1.232 (Claude Code)\n").as_deref(),
            Some("2.1.232")
        );
        assert_eq!(
            parse_claude_version("\n  2.4.0 (Claude Code)  \n").as_deref(),
            Some("2.4.0")
        );
        for output in [
            "2.1.232",
            "claude 2.1.232",
            "2.1 (Claude Code)",
            "(Claude Code)",
            "",
            "2.1.x (Claude Code)",
            "2.1.232.1 (Claude Code)",
        ] {
            assert_eq!(parse_claude_version(output), None, "{output:?}");
        }
        for (version, supported) in [
            ("2.1.0", true),
            ("2.1.232", true),
            ("2.9.14", true),
            ("2.1.232-beta.1", true),
            ("2.0.99", false),
            ("1.0.128", false),
            ("3.0.0", false),
            ("10.1.0", false),
            ("garbage", false),
        ] {
            assert_eq!(
                claude_version_supported(Some(version)),
                supported,
                "{version}"
            );
            assert_eq!(
                harness_version_supported(HarnessKind::ClaudeCode, Some(version)),
                supported
            );
        }
        assert!(!claude_version_supported(None));
        // Codex uses its verified range; other adapters keep exact versions.
        assert!(harness_version_supported(
            HarnessKind::Codex,
            Some("0.157.1")
        ));
        assert!(!harness_version_supported(
            HarnessKind::Codex,
            Some("0.158.0")
        ));
        assert!(!harness_version_supported(
            HarnessKind::PrimeAgent,
            Some("0.9.4")
        ));
        assert!(harness_version_supported(HarnessKind::Pi, None));
    }

    #[test]
    fn claude_launch_accepts_only_a_native_executable() {
        let root = std::env::temp_dir().join(format!(
            "piui-claude-candidates-{}-{}",
            std::process::id(),
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&root).expect("candidate directory");
        let names = [
            "claude.exe",
            "claude.cmd",
            "claude.ps1",
            "claude.bat",
            "claude",
            "cli.js",
        ];
        for name in names {
            std::fs::write(root.join(name), b"fixture").expect("candidate file");
        }
        let accepted = names
            .into_iter()
            .filter(|name| is_native_claude_executable(&root.join(name)))
            .collect::<Vec<_>>();
        if cfg!(windows) {
            assert_eq!(accepted, ["claude.exe"], "shell shims are never spawned");
        } else {
            assert_eq!(
                accepted,
                [
                    "claude.exe",
                    "claude.cmd",
                    "claude.ps1",
                    "claude.bat",
                    "claude"
                ]
            );
        }
        assert!(!is_native_claude_executable(Path::new("claude.exe")));
        assert!(!is_native_claude_executable(&root.join("missing.exe")));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn uuid_like_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    }

    #[test]
    fn claude_bridge_command_removes_every_billing_and_parent_override() {
        let mut config = test_config();
        config.harness = HarnessKind::ClaudeCode;
        let command = bridge_command(Path::new("node"), &config);
        let removed = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().to_uppercase())
            .collect::<HashSet<_>>();
        for name in CLAUDE_SCRUBBED_ENVIRONMENT
            .iter()
            .chain(OPERATOR_ENVIRONMENT)
        {
            assert!(removed.contains(*name), "{name} must be removed");
        }
        // The explicit subscription-only list from ADR-029 and the rework plan.
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_BEDROCK_BASE_URL",
            "ANTHROPIC_VERTEX_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "AWS_BEARER_TOKEN_BEDROCK",
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SSE_PORT",
        ] {
            assert!(removed.contains(name), "{name} must be removed");
        }
        assert!(
            command.get_envs().all(|(_, value)| value.is_none()),
            "the launcher only removes variables"
        );
        // Other harnesses keep the user's environment minus operator capabilities.
        config.harness = HarnessKind::Codex;
        let other = bridge_command(Path::new("node"), &config);
        let other_removed = other
            .get_envs()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect::<HashSet<_>>();
        assert_eq!(
            other_removed,
            OPERATOR_ENVIRONMENT
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<HashSet<_>>()
        );
    }

    #[test]
    fn claude_scrubbed_child_environment_lacks_every_override() {
        let node = resolve_node().expect("node for the environment proof");
        let mut command = std::process::Command::new(node);
        for name in CLAUDE_SCRUBBED_ENVIRONMENT
            .iter()
            .chain(OPERATOR_ENVIRONMENT)
        {
            command.env(name, "SECRET-MUST-NOT-LEAK");
        }
        command.env("PIUI_TEST_USER_SETTING", "kept");
        scrub_claude_environment(&mut command);
        // Only variable names cross back; values are never printed.
        let output = command
            .args([
                "-e",
                "process.stdout.write(JSON.stringify(Object.keys(process.env).map((key) => key.toUpperCase())))",
            ])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .expect("node reports its environment names");
        let names: Vec<String> = serde_json::from_slice(&output.stdout).expect("name list");
        for name in CLAUDE_SCRUBBED_ENVIRONMENT
            .iter()
            .chain(OPERATOR_ENVIRONMENT)
        {
            assert!(
                !names.iter().any(|value| value == name),
                "{name} reached the child"
            );
        }
        assert!(names.iter().any(|value| value == "PIUI_TEST_USER_SETTING"));
    }

    #[test]
    fn claude_scrub_list_matches_the_bridge_list() {
        let start = CLAUDE_SOURCE
            .find("const SCRUBBED_ENVIRONMENT = new Set([")
            .expect("bridge scrub list");
        let body = &CLAUDE_SOURCE[start..];
        let end = body.find("]);").expect("end of bridge scrub list");
        let bridge = body[..end]
            .split('"')
            .skip(1)
            .step_by(2)
            .collect::<std::collections::BTreeSet<_>>();
        let host = CLAUDE_SCRUBBED_ENVIRONMENT
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(bridge, host);
        assert_eq!(
            host.len(),
            CLAUDE_SCRUBBED_ENVIRONMENT.len(),
            "no duplicates"
        );
    }

    #[test]
    fn claude_subscription_refusal_is_typed_and_tracked() {
        assert_eq!(
            map_bridge_failure("claude-subscription-required"),
            BridgeFailureCode::SubscriptionRequired
        );
        let refused = NativeRuntimeError::Bridge(BridgeFailureCode::SubscriptionRequired);
        record_native_account(HarnessKind::ClaudeCode, Ok(()));
        // Other adapters never change the Claude Code verdict.
        record_native_account(HarnessKind::Codex, Err(&refused));
        assert!(!claude_sign_in_required());
        record_native_account(HarnessKind::ClaudeCode, Err(&refused));
        assert!(claude_sign_in_required());
        // An unrelated failure proves nothing about the login.
        record_native_account(HarnessKind::ClaudeCode, Err(&NativeRuntimeError::Timeout));
        assert!(claude_sign_in_required());
        record_native_account(HarnessKind::ClaudeCode, Ok(()));
        assert!(!claude_sign_in_required());
    }

    #[test]
    fn claude_capabilities_are_native_with_coordinator_delegation() {
        let capabilities = verified_harness_capabilities(HarnessKind::ClaudeCode);
        for capability in [
            &capabilities.prompt,
            &capabilities.resume,
            &capabilities.models,
            &capabilities.approvals,
            &capabilities.instructions,
            &capabilities.tool_policy,
        ] {
            assert!(capability.supported);
            assert_eq!(capability.enforcement, Enforcement::Native);
        }
        assert!(capabilities.native_subagents.supported);
        assert_eq!(
            capabilities.native_subagents.enforcement,
            Enforcement::Coordinator
        );
        assert!(
            capabilities
                .approvals
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("only deny"))
        );
    }

    #[test]
    fn claude_fast_mode_is_rejected_by_the_runtime_guard() {
        let mut config = test_config();
        config.harness = HarnessKind::ClaudeCode;
        config.service_tier = Some("fast".into());
        assert_eq!(
            validate_config(&config),
            Err(NativeRuntimeError::InvalidConfiguration)
        );
        config.service_tier = Some("standard".into());
        assert_eq!(validate_config(&config), Ok(()));
        config.service_tier = None;
        assert_eq!(validate_config(&config), Ok(()));
    }
}
