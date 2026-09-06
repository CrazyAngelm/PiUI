//! Live Pi RPC process adapter and test-only Prime protocol seam.
//!
//! Production spawns a real `pi --mode rpc` child. Prime Agent live control is
//! gated at the host because version 0.8.1 reaches a shared detached daemon;
//! tests may exercise its adapter only with an explicit non-default socket.
//! The adapter drives the LF-only [`RpcCodec`] validated for stdout framing,
//! correlates commands by id, normalizes agent/session events into a small set
//! of host-safe [`SurfaceEvent`]s, and owns a minimal lifecycle state machine
//! (Starting -> Ready -> Running -> ... -> Failed/Dormant).
//!
//! It is deliberately additive: the deterministic fake runtime remains the
//! safe-mode/foundation path. Nothing here reads `auth.json`, prompts, or raw
//! session payloads into the events that cross to the WebView; unknown events
//! are reduced to a payload-free generic notice.

use crate::codec::{RpcCodec, RpcCodecConfig};
use crate::extension_ui::{
    ExtensionUiAction, ExtensionUiDelivery, ExtensionUiMailbox, ExtensionUiResponse,
    sanitize_single_line,
};
use piui_contracts::{AgentKind, RuntimeId, RuntimeState};
#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::timeout;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);
const READ_BUF_BYTES: usize = 16 * 1024;
/// The fixed live-runtime event queue capacity. Snapshot projections may not
/// exceed this queue's established backpressure bound.
const LIVE_EVENT_CHANNEL_CAPACITY: usize = 256;
const MAX_THINKING_LEVELS: usize = 8;
const MAX_RUNTIME_COMMANDS: usize = 512;
const MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS: usize = LIVE_EVENT_CHANNEL_CAPACITY;
const MAX_RUNTIME_COMMAND_NAME_CHARS: usize = 160;
const MAX_RUNTIME_COMMAND_DESCRIPTION_CHARS: usize = 1_000;
const PRIME_SESSION_ACTIVE_STDERR_MARKERS: [&[u8]; 2] =
    [b"Session is already active", b"session_already_active"];
const SUPPORTED_PRIME_AGENT_VERSION: &str = "0.8.1";
/// Version of the host-to-WebView live-runtime event channel.
/// v10 adds an explicit runtime kind and typed Prime activity events while
/// retaining the generic Pi surface and projectless Chats scope.
pub const LOCAL_RUNTIME_EVENT_PROTOCOL: u8 = 10;
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

/// How this host launches the Pi CLI in rpc mode.
#[derive(Clone, Debug)]
pub struct PiLaunch {
    /// Executable path (usually `node` or a `pi` launcher).
    pub program: PathBuf,
    /// Leading arguments before `--mode rpc`.
    pub leading_args: Vec<String>,
    /// Human-readable label for diagnostics.
    pub label: String,
}

/// Errors from the live runtime adapter.
#[derive(Debug, Clone, Error)]
pub enum RealRuntimeError {
    #[error("Agent runtime is not running")]
    NotRunning,
    #[error("Could not resolve an agent installation: {0}")]
    Resolve(String),
    #[error("Could not spawn the agent runtime: {0}")]
    Spawn(String),
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("Command timed out")]
    Timeout,
    #[error("The agent runtime rejected the command: {0}")]
    Command(String),
    #[error("The agent runtime exited before responding: {0}")]
    Exited(String),
    #[error("The Prime Agent session is already active in another client")]
    SessionAlreadyActive,
    #[error("Response channel closed")]
    Channel,
    #[error("The extension UI response is invalid or no longer pending")]
    InvalidExtensionUiResponse,
}

/// A minimal, display-safe model descriptor projected from `get_available_models`.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLite {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A minimal, display-safe command projected from Pi's `get_commands` response.
/// Source metadata is deliberately reduced to its allowlisted provenance labels;
/// paths and base directories never cross this adapter boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandLite {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// A minimal, display-safe session state projected from `get_state`.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateLite {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    pub message_count: usize,
    pub pending_message_count: usize,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub auto_compaction_enabled: bool,
    pub steering_mode: String,
    pub follow_up_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelLite>,
    pub thinking_level: String,
}

/// Typed, display-safe Prime Agent activity. Paths, raw tool payloads, daemon
/// identifiers, environment values, and authentication material are excluded.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PrimeActivity {
    RlmChild {
        id: String,
        label: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replied_since_task: Option<bool>,
    },
    Goal {
        id: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        objective: Option<String>,
        tokens_used: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_budget: Option<u64>,
        time_used_seconds: u64,
        continuations_used: u64,
    },
    SessionActions {
        id: String,
        active_count: usize,
        queued_count: usize,
    },
    Recap {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    Authentication {
        id: String,
        provider: String,
        status: String,
    },
    Refinement {
        id: String,
        status: String,
    },
    Bash {
        id: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
    },
    Heartbeat {
        id: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery_mode: Option<String>,
    },
    Schedule {
        id: String,
        status: String,
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule: Option<String>,
    },
    Unknown {
        id: String,
        wire_type: String,
    },
}

/// Host-safe events the Tauri host forwards to the WebView as `piui://runtime-event`.
/// These never carry raw RPC JSON, credentials, host paths, or prompt text beyond
/// the visible message deltas themselves.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SurfaceEvent {
    State {
        state: RuntimeState,
        revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    StateSnapshot {
        state: SessionStateLite,
        revision: u64,
    },
    ModelsAvailable {
        models: Vec<ModelLite>,
    },
    UserMessage {
        block_id: String,
        text: String,
    },
    AssistantTextStarted {
        block_id: String,
    },
    AssistantTextDelta {
        block_id: String,
        delta: String,
    },
    AssistantMessageCompleted {
        block_id: Option<String>,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    ThinkingStarted {
        block_id: String,
    },
    ThinkingDelta {
        block_id: String,
        delta: String,
    },
    ToolStarted {
        block_id: String,
        tool_name: String,
    },
    ToolUpdated {
        block_id: String,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    ToolCompleted {
        block_id: String,
        tool_name: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    EntryAppended {
        /// Host-opaque id for a non-message entry (compaction/custom/etc.).
        block_id: String,
        entry_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        entry_kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    TurnStarted,
    TurnCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    QueueUpdate {
        steering: usize,
        follow_up: usize,
    },
    Compaction {
        active: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
    },
    ThinkingLevelChanged {
        level: String,
    },
    SessionInfoChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    PrimeActivity {
        activity: PrimeActivity,
    },
    ExtensionUi {
        action: ExtensionUiAction,
    },
    RuntimeError {
        safe_summary: String,
    },
}

/// Public ownership scope for a runtime event. Projectless Chats are a
/// separate surface rather than a project with a hidden/sentinel identifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeEventScope {
    Project,
    Personal,
}

/// Versioned envelope emitted over the `piui://runtime-event` Tauri channel.
/// Flattening keeps the event's discriminant at top level while making the
/// channel version explicit for future desktop clients.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub protocol: u8,
    pub runtime_id: String,
    pub agent_kind: AgentKind,
    pub scope: RuntimeEventScope,
    /// Present only for a user project. The host-owned personal workspace id
    /// is not a public runtime identity and must never be serialized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub event: SurfaceEvent,
}

impl RuntimeEventEnvelope {
    #[must_use]
    pub fn new(
        runtime_id: String,
        project_id: Option<String>,
        session_id: Option<String>,
        event: SurfaceEvent,
    ) -> Self {
        Self::new_for_kind(runtime_id, AgentKind::Pi, project_id, session_id, event)
    }

    #[must_use]
    pub fn new_for_kind(
        runtime_id: String,
        agent_kind: AgentKind,
        project_id: Option<String>,
        session_id: Option<String>,
        event: SurfaceEvent,
    ) -> Self {
        let scope = if project_id.is_some() {
            RuntimeEventScope::Project
        } else {
            RuntimeEventScope::Personal
        };
        // Personal Chats are the host-private ordinary-Pi workspace. Keep that
        // invariant in the serializer even if a future caller passes a wrong
        // kind while constructing an event.
        let agent_kind = if project_id.is_none() {
            AgentKind::Pi
        } else {
            agent_kind
        };
        let event = if agent_kind == AgentKind::Pi
            && matches!(&event, SurfaceEvent::PrimeActivity { .. })
        {
            SurfaceEvent::RuntimeError {
                safe_summary: "A runtime-specific event was ignored.".into(),
            }
        } else {
            event
        };
        Self {
            protocol: LOCAL_RUNTIME_EVENT_PROTOCOL,
            runtime_id,
            agent_kind,
            scope,
            project_id,
            session_id,
            event,
        }
    }
}

/// Configuration for spawning a live runtime bound to one host-verified cwd.
#[derive(Clone, Debug)]
pub struct RealPiConfig {
    pub cwd: PathBuf,
    /// Opens an already indexed agent-owned session file.
    pub session_path: Option<PathBuf>,
    pub session_name: Option<String>,
}

fn runtime_launch_args(
    config: &RealPiConfig,
    agent_kind: AgentKind,
    prime_daemon_socket: Option<&std::ffi::OsStr>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("--mode"), OsString::from("rpc")];
    if agent_kind == AgentKind::PrimeAgent {
        if let Some(socket) = prime_daemon_socket {
            args.push(OsString::from("--daemon-socket"));
            args.push(socket.to_owned());
        }
    }
    if let Some(path) = &config.session_path {
        let flag = match agent_kind {
            AgentKind::Pi => "--session",
            AgentKind::PrimeAgent => "--resume",
        };
        args.push(OsString::from(flag));
        args.push(path.as_os_str().to_owned());
    }
    if let Some(name) = &config.session_name {
        args.push(OsString::from("--name"));
        args.push(OsString::from(name));
    }
    args
}

fn require_isolated_prime_daemon(
    agent_kind: AgentKind,
    prime_daemon_socket: Option<&std::ffi::OsStr>,
) -> Result<(), RealRuntimeError> {
    if agent_kind == AgentKind::Pi {
        return Ok(());
    }
    let Some(socket) = prime_daemon_socket else {
        return Err(RealRuntimeError::Resolve(
            "Prime live control requires an explicit isolated daemon endpoint.".into(),
        ));
    };
    #[cfg(windows)]
    let isolated = socket.to_string_lossy().starts_with(r"\\.\pipe\piui-");
    #[cfg(not(windows))]
    let isolated = Path::new(socket).is_absolute()
        && Path::new(socket)
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("piui-"));
    if !isolated {
        return Err(RealRuntimeError::Resolve(
            "Prime live control requires an explicit isolated daemon endpoint.".into(),
        ));
    }
    Ok(())
}

struct RuntimeShared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, RealRuntimeError>>>>,
    extension_ui: Mutex<ExtensionUiMailbox>,
    extension_ui_timeouts: Mutex<HashMap<String, oneshot::Sender<()>>>,
    extension_ui_response_gate: Mutex<()>,
    state: Mutex<RuntimeState>,
    revision: AtomicU64,
    next_id: AtomicU64,
    /// Set only by the host-owned stop path; a clean EOF without this flag is
    /// a crashed/unexpected child, not an idle runtime.
    shutting_down: AtomicBool,
    session_already_active: AtomicBool,
    extension_ui_ready: AtomicBool,
}

/// Live runtime handle. Callers use `stop()` for graceful protocol cleanup;
/// Drop retains a last-resort OS containment boundary for owned descendants.
pub struct RealPiRuntime {
    shared: Arc<RuntimeShared>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr: Mutex<Option<tokio::task::JoinHandle<()>>>,
    launch_label: String,
    agent_kind: AgentKind,
    #[cfg(unix)]
    unix_group: StdMutex<Option<UnixProcessGroup>>,
    #[cfg(windows)]
    windows_job: StdMutex<Option<WindowsJob>>,
}

impl RealPiRuntime {
    /// Spawns the ordinary Pi process. This compatibility entry point keeps the
    /// established generic runtime path unchanged.
    pub async fn spawn(
        config: RealPiConfig,
    ) -> Result<
        (
            Self,
            mpsc::Receiver<SurfaceEvent>,
            RuntimeId,
            SessionStateLite,
            u64,
        ),
        RealRuntimeError,
    > {
        Self::spawn_for_kind(config).await
    }

    #[cfg(test)]
    async fn spawn_prime_on_isolated_daemon(
        config: RealPiConfig,
        daemon_socket: OsString,
    ) -> Result<
        (
            Self,
            mpsc::Receiver<SurfaceEvent>,
            RuntimeId,
            SessionStateLite,
            u64,
        ),
        RealRuntimeError,
    > {
        Self::spawn_for_kind_with_daemon_socket(config, AgentKind::PrimeAgent, Some(daemon_socket))
            .await
    }

    async fn spawn_for_kind(
        config: RealPiConfig,
    ) -> Result<
        (
            Self,
            mpsc::Receiver<SurfaceEvent>,
            RuntimeId,
            SessionStateLite,
            u64,
        ),
        RealRuntimeError,
    > {
        Self::spawn_for_kind_with_daemon_socket(config, AgentKind::Pi, None).await
    }

    async fn spawn_for_kind_with_daemon_socket(
        config: RealPiConfig,
        agent_kind: AgentKind,
        prime_daemon_socket: Option<OsString>,
    ) -> Result<
        (
            Self,
            mpsc::Receiver<SurfaceEvent>,
            RuntimeId,
            SessionStateLite,
            u64,
        ),
        RealRuntimeError,
    > {
        require_isolated_prime_daemon(agent_kind, prime_daemon_socket.as_deref())?;
        let launch = match agent_kind {
            AgentKind::Pi => resolve_pi_launch(),
            AgentKind::PrimeAgent => resolve_prime_launch(),
        }
        .map_err(RealRuntimeError::Resolve)?;
        #[cfg(windows)]
        let mut windows_job = WindowsJob::new().map_err(|_| {
            RealRuntimeError::Spawn("Windows process containment is unavailable.".into())
        })?;
        let mut std_command = std::process::Command::new(&launch.program);
        std_command
            .args(&launch.leading_args)
            .args(runtime_launch_args(
                &config,
                agent_kind,
                prime_daemon_socket.as_deref(),
            ))
            .current_dir(&config.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            // Suspend before user code runs so it cannot create an unowned
            // descendant between spawn and Job Object assignment.
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std_command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        let mut command = Command::from(std_command);
        command.kill_on_drop(false);
        #[cfg(unix)]
        {
            // New process group so stop() can reliably signal the whole tree.
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|error| RealRuntimeError::Spawn(error.to_string()))?;

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
                return Err(RealRuntimeError::Spawn(
                    "The runtime could not enter Windows process containment.".into(),
                ));
            };
            if windows_job.resume_assigned(assignment).is_err() {
                let _ = windows_job.force_terminate_tree();
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(RealRuntimeError::Spawn(
                    "The contained runtime process could not be resumed.".into(),
                ));
            }
        }

        #[cfg(unix)]
        let unix_group = {
            let group_id = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .and_then(|pid| ProcessGroupId::new(pid).ok());
            let Some(group_id) = group_id else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(RealRuntimeError::Spawn(
                    "The runtime process group could not be established.".into(),
                ));
            };
            UnixProcessGroup::from_spawned_group(group_id)
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RealRuntimeError::Spawn("runtime stdin pipe was not captured".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RealRuntimeError::Spawn("runtime stdout pipe was not captured".into())
        })?;
        let stderr = child.stderr.take();

        let instance = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let runtime_prefix = match agent_kind {
            AgentKind::Pi => "piui-live",
            AgentKind::PrimeAgent => "piui-prime",
        };
        let runtime_id = RuntimeId::new(format!(
            "{runtime_prefix}-{}-{instance}",
            std::process::id()
        ));
        let shared = Arc::new(RuntimeShared {
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            extension_ui: Mutex::new(ExtensionUiMailbox::new()),
            extension_ui_timeouts: Mutex::new(HashMap::new()),
            extension_ui_response_gate: Mutex::new(()),
            state: Mutex::new(RuntimeState::Starting),
            revision: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            session_already_active: AtomicBool::new(false),
            extension_ui_ready: AtomicBool::new(false),
        });

        let (event_tx, event_rx) = mpsc::channel::<SurfaceEvent>(LIVE_EVENT_CHANNEL_CAPACITY);
        let reader_shared = Arc::clone(&shared);
        let reader_tx = event_tx.clone();
        let reader_handle = tokio::spawn(async move {
            run_stdout_loop(stdout, reader_shared, reader_tx, agent_kind).await;
        });

        let stderr_shared = Arc::clone(&shared);
        let stderr_handle = stderr.map(|stream| {
            tokio::spawn(async move {
                drain_stderr(stream, stderr_shared).await;
            })
        });

        let runtime = Self {
            shared: Arc::clone(&shared),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(Some(reader_handle)),
            stderr: Mutex::new(stderr_handle),
            launch_label: launch.label,
            agent_kind,
            #[cfg(unix)]
            unix_group: StdMutex::new(Some(unix_group)),
            #[cfg(windows)]
            windows_job: StdMutex::new(Some(windows_job)),
        };

        // Startup handshake: ask Pi for its current state. A success here is the
        // Ready signal; the first turn later flips to Running via events.
        let state_value = match runtime.request("get_state", json!({})).await {
            Ok(value) => value,
            Err(error) => {
                let _ = runtime.shutdown_child().await;
                if agent_kind == AgentKind::PrimeAgent
                    && runtime
                        .shared
                        .session_already_active
                        .load(Ordering::Acquire)
                {
                    return Err(RealRuntimeError::SessionAlreadyActive);
                }
                return Err(error);
            }
        };
        let state = match parse_session_state(state_value.clone()) {
            Ok(state) => state,
            Err(error) => {
                let _ = runtime.shutdown_child().await;
                return Err(error);
            }
        };
        if !transition_starting_to_ready(&runtime.shared, &event_tx).await {
            let _ = runtime.terminate().await;
            return Err(RealRuntimeError::Exited(
                "The agent runtime stopped during the startup handshake.".into(),
            ));
        }
        runtime
            .shared
            .extension_ui_ready
            .store(true, Ordering::Release);
        let revision = runtime.shared.revision.load(Ordering::Relaxed);
        if agent_kind == AgentKind::PrimeAgent {
            for activity in prime_state_activities(&state_value) {
                let _ = event_tx
                    .send(SurfaceEvent::PrimeActivity { activity })
                    .await;
            }
        }

        // Surface the initial model list asynchronously so the composer can
        // show a picker without blocking the first paint.
        let runtime_clone = RealPiRuntime {
            shared: Arc::clone(&shared),
            child: Mutex::new(None),
            reader: Mutex::new(None),
            stderr: Mutex::new(None),
            launch_label: runtime.launch_label.clone(),
            agent_kind,
            #[cfg(unix)]
            unix_group: StdMutex::new(None),
            #[cfg(windows)]
            windows_job: StdMutex::new(None),
        };
        let models_tx = event_tx.clone();
        tokio::spawn(async move {
            if let Ok(value) = runtime_clone
                .request("get_available_models", json!({}))
                .await
            {
                if let Some(models) = map_models(&value) {
                    let _ = models_tx
                        .send(SurfaceEvent::ModelsAvailable { models })
                        .await;
                }
            }
            if agent_kind == AgentKind::PrimeAgent {
                if let Ok(value) = runtime_clone.request("get_heartbeat", json!({})).await {
                    if let Some(activity) = prime_heartbeat_activity(&value) {
                        let _ = models_tx
                            .send(SurfaceEvent::PrimeActivity { activity })
                            .await;
                    }
                }
                if let Ok(value) = runtime_clone
                    .request("list_schedules", json!({ "includeInactive": true }))
                    .await
                {
                    for activity in prime_schedule_activities(&value) {
                        let _ = models_tx
                            .send(SurfaceEvent::PrimeActivity { activity })
                            .await;
                    }
                }
            }
        });

        Ok((runtime, event_rx, runtime_id, state, revision))
    }

    /// Current lifecycle state snapshot.
    pub async fn state(&self) -> RuntimeState {
        *self.shared.state.lock().await
    }

    pub fn revision(&self) -> u64 {
        self.shared.revision.load(Ordering::Relaxed)
    }

    pub fn launch_label(&self) -> &str {
        &self.launch_label
    }

    pub const fn agent_kind(&self) -> AgentKind {
        self.agent_kind
    }

    /// Sends a new user turn. `streamingBehavior` makes this one Pi command
    /// atomic: it starts immediately while idle and queues a follow-up if the
    /// agent began streaming between the UI observation and command arrival.
    pub async fn send_prompt(&self, text: String) -> Result<(), RealRuntimeError> {
        self.send_prompt_with_behavior(text, "followUp").await
    }

    /// Atomically starts a turn while idle or steers an active turn.
    pub async fn send_steer(&self, text: String) -> Result<(), RealRuntimeError> {
        self.send_prompt_with_behavior(text, "steer").await
    }

    /// Atomically starts a turn while idle or queues a follow-up while active.
    pub async fn send_follow_up(&self, text: String) -> Result<(), RealRuntimeError> {
        self.send_prompt_with_behavior(text, "followUp").await
    }

    async fn send_prompt_with_behavior(
        &self,
        text: String,
        streaming_behavior: &'static str,
    ) -> Result<(), RealRuntimeError> {
        let body = prompt_command(self.next_command_id(), text, streaming_behavior);
        self.request_with(body, COMMAND_TIMEOUT).await.map(|_| ())
    }

    pub async fn abort(&self) -> Result<(), RealRuntimeError> {
        let body = abort_command(self.next_command_id());
        self.fire_and_expect_success(body, Duration::from_secs(10))
            .await
    }

    async fn abort_during_shutdown(&self) -> Result<(), RealRuntimeError> {
        let body = abort_command(self.next_command_id());
        self.request_with_shutdown_policy(body, Duration::from_secs(10), true)
            .await
            .map(|_| ())
    }

    pub async fn get_state(&self) -> Result<SessionStateLite, RealRuntimeError> {
        let value = self.request("get_state", json!({})).await?;
        parse_session_state(value)
    }

    pub async fn get_models(&self) -> Result<Vec<ModelLite>, RealRuntimeError> {
        let value = self.request("get_available_models", json!({})).await?;
        map_models(&value)
            .ok_or_else(|| RealRuntimeError::Protocol("missing models payload".into()))
    }

    pub async fn get_thinking_levels(&self) -> Result<Vec<String>, RealRuntimeError> {
        match self.agent_kind {
            AgentKind::Pi => {
                let value = self
                    .request("get_available_thinking_levels", json!({}))
                    .await?;
                map_thinking_levels(&value).ok_or_else(|| {
                    RealRuntimeError::Protocol("missing thinking-level payload".into())
                })
            }
            AgentKind::PrimeAgent => {
                // Prime 0.8.1 supports setting a level but its stdio RPC omits
                // both Pi's catalog command and AgentConnection's available
                // level list. Expose only the proven current value rather than
                // inventing choices the selected model may reject.
                let state = self.get_state().await?;
                Ok((!state.thinking_level.is_empty())
                    .then_some(state.thinking_level)
                    .into_iter()
                    .collect())
            }
        }
    }

    /// Lists invokable Pi slash commands through a bounded, path-free projection.
    pub async fn get_commands(&self) -> Result<Vec<RuntimeCommandLite>, RealRuntimeError> {
        let value = self.request("get_commands", json!({})).await?;
        map_runtime_commands(&value)
    }

    pub async fn set_model(
        &self,
        provider: String,
        model_id: String,
    ) -> Result<(), RealRuntimeError> {
        let body = json!({ "id": self.next_command_id(), "type": "set_model", "provider": provider, "modelId": model_id });
        self.fire_and_expect_success(body, COMMAND_TIMEOUT).await
    }

    pub async fn set_thinking_level(&self, level: String) -> Result<(), RealRuntimeError> {
        let body =
            json!({ "id": self.next_command_id(), "type": "set_thinking_level", "level": level });
        self.fire_and_expect_success(body, COMMAND_TIMEOUT).await
    }

    pub async fn set_session_name(&self, name: String) -> Result<(), RealRuntimeError> {
        let body =
            json!({ "id": self.next_command_id(), "type": "set_session_name", "name": name });
        self.fire_and_expect_success(body, COMMAND_TIMEOUT).await
    }

    /// Resolves one pending extension dialog through Pi's LF-framed RPC stdin.
    /// The mailbox consumes a valid response exactly once; invalid, stale, or
    /// mismatched responses intentionally expose no request or payload detail.
    pub async fn respond_extension_ui(
        &self,
        public_id: String,
        response: ExtensionUiResponse,
    ) -> Result<(), RealRuntimeError> {
        // This lane can run while the originating prompt command holds the
        // host operation gate, but remains serialized with trust revocation
        // and runtime retirement through `terminate`/`stop` below.
        let _response_guard = self.shared.extension_ui_response_gate.lock().await;
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(RealRuntimeError::NotRunning);
        }
        let frame = {
            let mut mailbox = self.shared.extension_ui.lock().await;
            mailbox
                .respond(&public_id, response)
                .map_err(|_| RealRuntimeError::InvalidExtensionUiResponse)?
        };
        self.cancel_extension_ui_timeout(&public_id).await;
        write_extension_ui_frame(&self.shared, frame).await
    }

    /// Graceful stop: cancel extension dialogs, abort a running turn, close
    /// stdin, wait, then kill.
    pub async fn stop(&self) -> Result<(), RealRuntimeError> {
        let _response_guard = self.shared.extension_ui_response_gate.lock().await;
        self.shared.shutting_down.store(true, Ordering::Release);
        self.drain_extension_ui_dialogs().await;
        // Stop first closes admission for every ordinary command, then sends
        // the one typed command that is valid during shutdown. This avoids a
        // prompt/dialog race without silently skipping Prime/Pi's abort frame.
        let _ = self.abort_during_shutdown().await;
        self.shutdown_child().await
    }

    /// Immediately retires a failed or no-longer-authorized runtime without
    /// issuing another RPC command through a stream that may already be bad.
    pub async fn terminate(&self) -> Result<(), RealRuntimeError> {
        let _response_guard = self.shared.extension_ui_response_gate.lock().await;
        self.shared.shutting_down.store(true, Ordering::Release);
        self.shutdown_child().await
    }

    async fn fire_and_expect_success(
        &self,
        body: Value,
        deadline: Duration,
    ) -> Result<(), RealRuntimeError> {
        self.request_with(body, deadline).await.map(|_| ())
    }

    async fn request(&self, command: &str, extra: Value) -> Result<Value, RealRuntimeError> {
        let mut map = match extra {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        map.insert("id".into(), json!(self.next_command_id()));
        map.insert("type".into(), json!(command));
        self.request_with(Value::Object(map), COMMAND_TIMEOUT).await
    }

    async fn request_with(
        &self,
        body: Value,
        deadline: Duration,
    ) -> Result<Value, RealRuntimeError> {
        self.request_with_shutdown_policy(body, deadline, false)
            .await
    }

    async fn request_with_shutdown_policy(
        &self,
        body: Value,
        deadline: Duration,
        allow_during_shutdown: bool,
    ) -> Result<Value, RealRuntimeError> {
        let command_id = body
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| RealRuntimeError::Protocol("command missing id".into()))?;
        let expected_command = body
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| RealRuntimeError::Protocol("command missing type".into()))?;
        if request_is_blocked(
            self.shared.shutting_down.load(Ordering::Acquire),
            allow_during_shutdown,
        ) {
            return Err(RealRuntimeError::NotRunning);
        }
        let encoded = serde_json::to_vec(&body)
            .map_err(|error| RealRuntimeError::Protocol(error.to_string()))?;
        let framed = {
            let mut bytes = encoded;
            bytes.push(b'\n');
            bytes
        };

        let (tx, rx) = oneshot::channel::<Result<Value, RealRuntimeError>>();
        {
            let mut pending = self.shared.pending.lock().await;
            pending.insert(command_id.clone(), tx);
        }
        if request_is_blocked(
            self.shared.shutting_down.load(Ordering::Acquire),
            allow_during_shutdown,
        ) {
            self.shared.pending.lock().await.remove(&command_id);
            return Err(RealRuntimeError::NotRunning);
        }
        let write_result = {
            let mut stdin_guard = self.shared.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                match stdin.write_all(&framed).await {
                    Ok(()) => stdin.flush().await,
                    Err(error) => Err(error),
                }
            } else {
                Err(std::io::Error::other("Agent runtime stdin is unavailable"))
            }
        };
        if write_result.is_err() {
            self.shared.pending.lock().await.remove(&command_id);
            return Err(RealRuntimeError::NotRunning);
        }

        let mut rx = rx;
        loop {
            match timeout(deadline, &mut rx).await {
                Ok(Ok(Ok(value))) => {
                    validate_success_response(&value, &expected_command)?;
                    return Ok(value);
                }
                Ok(Ok(Err(error))) => return Err(error),
                Ok(Err(_)) => {
                    return Err(RealRuntimeError::Exited(
                        "The agent runtime closed the response channel before replying.".into(),
                    ));
                }
                Err(_) => {
                    // Extension slash commands reply only after their handler
                    // returns. A documented UI dialog may therefore keep the
                    // `prompt` request open beyond the normal command budget.
                    let waiting_for_dialog = expected_command == "prompt"
                        && self.shared.extension_ui.lock().await.pending_len() > 0;
                    if waiting_for_dialog {
                        continue;
                    }
                    self.shared.pending.lock().await.remove(&command_id);
                    return Err(RealRuntimeError::Timeout);
                }
            }
        }
    }

    fn next_command_id(&self) -> String {
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        format!("piui-c-{n}")
    }

    async fn cancel_extension_ui_timeout(&self, public_id: &str) {
        if let Some(cancel) = self
            .shared
            .extension_ui_timeouts
            .lock()
            .await
            .remove(public_id)
        {
            let _ = cancel.send(());
        }
    }

    async fn cancel_extension_ui_timeouts(&self) {
        let cancellations = std::mem::take(&mut *self.shared.extension_ui_timeouts.lock().await);
        for cancel in cancellations.into_values() {
            let _ = cancel.send(());
        }
    }

    async fn drain_extension_ui_dialogs(&self) {
        let frames = {
            let mut mailbox = self.shared.extension_ui.lock().await;
            mailbox.drain_cancellations()
        };
        for frame in frames {
            // Shutdown must not be blocked by an already-failed stdin pipe.
            // The source id remains host-private and is never logged.
            let _ = write_extension_ui_frame(&self.shared, frame).await;
        }
    }

    fn terminate_process_containment(&self) -> Result<(), RealRuntimeError> {
        #[cfg(unix)]
        {
            let mut slot = self.unix_group.lock().map_err(|_| {
                RealRuntimeError::Exited("Unix process containment became unavailable.".into())
            })?;
            if let Some(mut group) = slot.take() {
                group.force_terminate_tree().map_err(|_| {
                    RealRuntimeError::Exited(
                        "The runtime process group could not be terminated.".into(),
                    )
                })?;
                group.discard_after_supervisor_cleanup();
            }
        }
        #[cfg(windows)]
        {
            let mut slot = self.windows_job.lock().map_err(|_| {
                RealRuntimeError::Exited("Windows process containment became unavailable.".into())
            })?;
            if let Some(mut job) = slot.take() {
                let terminated = job.force_terminate_tree();
                let closed = job.close();
                if terminated.is_err() || closed.is_err() {
                    return Err(RealRuntimeError::Exited(
                        "The contained runtime process tree could not be terminated.".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    async fn shutdown_child(&self) -> Result<(), RealRuntimeError> {
        self.shared.shutting_down.store(true, Ordering::Release);
        self.cancel_extension_ui_timeouts().await;
        // Resolve every dialog before stdin closes so a waiting extension can
        // unwind normally where the child is still able to read the response.
        self.drain_extension_ui_dialogs().await;
        // Close stdin so Pi's reader reaches EOF and exits gracefully.
        {
            let mut stdin = self.shared.stdin.lock().await;
            *stdin = None;
        }
        // Wait briefly for the reader to drain stdout and for Pi to exit.
        let reader = self.reader.lock().await.take();
        if let Some(handle) = reader {
            let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, handle).await;
        }
        let stderr = self.stderr.lock().await.take();
        if let Some(handle) = stderr {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }

        let mut child_guard = self.child.lock().await;
        let Some(mut child) = child_guard.take() else {
            return self.terminate_process_containment();
        };
        match timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
            Ok(Ok(_status)) => self.terminate_process_containment(),
            _ => {
                let containment_result = self.terminate_process_containment();
                let _ = child.kill().await;
                let _ = child.wait().await;
                containment_result
            }
        }
    }
}

impl Drop for RealPiRuntime {
    fn drop(&mut self) {
        let _ = self.terminate_process_containment();
    }
}

const fn request_is_blocked(shutting_down: bool, allow_during_shutdown: bool) -> bool {
    shutting_down && !allow_during_shutdown
}

async fn write_extension_ui_frame(
    shared: &Arc<RuntimeShared>,
    response: Value,
) -> Result<(), RealRuntimeError> {
    let mut frame = serde_json::to_vec(&response).map_err(|_| {
        RealRuntimeError::Protocol("Could not encode an extension UI response.".into())
    })?;
    frame.push(b'\n');
    let write_result = {
        let mut stdin_guard = shared.stdin.lock().await;
        if let Some(stdin) = stdin_guard.as_mut() {
            match stdin.write_all(&frame).await {
                Ok(()) => stdin.flush().await,
                Err(error) => Err(error),
            }
        } else {
            Err(std::io::Error::other("Agent runtime stdin is unavailable"))
        }
    };
    write_result.map_err(|_| RealRuntimeError::NotRunning)
}

fn abort_command(command_id: String) -> Value {
    json!({ "id": command_id, "type": "abort" })
}

fn prompt_command(command_id: String, text: String, streaming_behavior: &str) -> Value {
    json!({
        "id": command_id,
        "type": "prompt",
        "message": text,
        "streamingBehavior": streaming_behavior,
    })
}

fn validate_success_response(
    value: &Value,
    expected_command: &str,
) -> Result<(), RealRuntimeError> {
    let object = value
        .as_object()
        .ok_or_else(|| RealRuntimeError::Protocol("Pi response was not an object".into()))?;
    if object.get("type").and_then(Value::as_str) != Some("response") {
        return Err(RealRuntimeError::Protocol(
            "Pi frame was not a response for the pending command".into(),
        ));
    }
    if object.get("command").and_then(Value::as_str) != Some(expected_command) {
        return Err(RealRuntimeError::Protocol(
            "Pi response command did not match the request".into(),
        ));
    }
    match object.get("success").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => Err(RealRuntimeError::Command(format!(
            "Pi rejected the `{expected_command}` command"
        ))),
        None => Err(RealRuntimeError::Protocol(
            "Pi response lacked a boolean success flag".into(),
        )),
    }
}

fn required_response_data<'a>(
    value: &'a Value,
    command: &str,
) -> Result<&'a serde_json::Map<String, Value>, RealRuntimeError> {
    value.get("data").and_then(Value::as_object).ok_or_else(|| {
        RealRuntimeError::Protocol(format!("Agent `{command}` response lacked object data"))
    })
}

fn parse_session_state(value: Value) -> Result<SessionStateLite, RealRuntimeError> {
    required_response_data(&value, "get_state")?;
    let state = map_session_state(&value);
    if state.session_id.is_empty() {
        return Err(RealRuntimeError::Protocol(
            "Agent `get_state` response lacked a session id".into(),
        ));
    }
    Ok(state)
}

/// The stdout reader: feeds bytes into the validated LF codec, routes
/// `response` frames to pending command slots, and normalizes events.
async fn run_stdout_loop<R>(
    mut reader: R,
    shared: Arc<RuntimeShared>,
    event_tx: mpsc::Sender<SurfaceEvent>,
    agent_kind: AgentKind,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut codec = match RpcCodec::new(RpcCodecConfig::default()) {
        Ok(codec) => codec,
        Err(_) => {
            let _ = event_tx
                .send(SurfaceEvent::RuntimeError {
                    safe_summary: "Could not initialize the RPC stream codec.".into(),
                })
                .await;
            return;
        }
    };
    let mut buf = vec![0u8; READ_BUF_BYTES];
    let mut tracker = StreamTracker::default();

    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let values = match codec.push(&buf[..n]) {
                    Ok(values) => values,
                    Err(_) => {
                        mark_failed(
                            &shared,
                            &event_tx,
                            "The agent runtime emitted a malformed RPC frame.",
                        )
                        .await;
                        return;
                    }
                };
                for value in values {
                    handle_frame_for_kind(value, &shared, &event_tx, &mut tracker, agent_kind)
                        .await;
                }
            }
            Err(_) => {
                mark_failed(
                    &shared,
                    &event_tx,
                    "The agent runtime output could not be read.",
                )
                .await;
                return;
            }
        }
    }
    if codec.finish().is_err() {
        mark_failed(
            &shared,
            &event_tx,
            "The agent runtime ended with an incomplete RPC frame.",
        )
        .await;
    } else if shared.shutting_down.load(Ordering::Acquire) {
        mark_settled(&shared, &event_tx).await;
    } else {
        mark_failed(&shared, &event_tx, "The agent runtime exited unexpectedly.").await;
    }
}

/// Holds in-flight rendering state for the currently streaming assistant
/// message so deltas can be keyed to stable block ids.
#[derive(Default)]
struct StreamTracker {
    /// Host-assigned message counter, used to mint block ids.
    message_seq: u64,
    /// Id of the assistant message currently streaming.
    current_message_id: Option<String>,
    /// contentIndex -> block id within the current assistant message.
    content_blocks: HashMap<usize, String>,
    /// The most recently started assistant text block, so message completion
    /// can be attributed to a single durable block for the common case.
    last_text_block: Option<String>,
}

#[cfg(test)]
async fn handle_frame(
    value: Value,
    shared: &Arc<RuntimeShared>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    tracker: &mut StreamTracker,
) {
    handle_frame_for_kind(value, shared, event_tx, tracker, AgentKind::Pi).await;
}

async fn handle_frame_for_kind(
    value: Value,
    shared: &Arc<RuntimeShared>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    tracker: &mut StreamTracker,
    agent_kind: AgentKind,
) {
    // Response frames resolve pending command slots.
    if let Some(obj) = value.as_object() {
        if obj.get("type").and_then(Value::as_str) == Some("response") {
            let Some(id) = obj.get("id").and_then(Value::as_str).map(str::to_owned) else {
                if agent_kind == AgentKind::PrimeAgent {
                    mark_failed(
                        shared,
                        event_tx,
                        "The Prime Agent runtime emitted an uncorrelated response.",
                    )
                    .await;
                }
                return;
            };
            let slot = shared.pending.lock().await.remove(&id);
            if let Some(tx) = slot {
                let _ = tx.send(Ok(value.clone()));
            }
            let command = obj.get("command").and_then(Value::as_str).unwrap_or("");
            if obj.get("success").and_then(Value::as_bool) == Some(false) {
                if let Some(error) = obj.get("error").and_then(Value::as_str) {
                    let _ = event_tx
                        .send(SurfaceEvent::RuntimeError {
                            safe_summary: redact_command_error(command, error),
                        })
                        .await;
                }
            }
            return;
        }
        if obj.get("type").and_then(Value::as_str) == Some("extension_ui_request") {
            handle_extension_ui(obj, event_tx, shared).await;
            return;
        }
    }

    let Some(event_type) = value
        .as_object()
        .and_then(|o| o.get("type"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        if agent_kind == AgentKind::PrimeAgent {
            let _ = event_tx
                .send(SurfaceEvent::PrimeActivity {
                    activity: prime_unknown_activity("malformed-event"),
                })
                .await;
        }
        return;
    };
    match event_type.as_str() {
        "agent_start" => {
            set_shared_state(shared, RuntimeState::Running, event_tx).await;
        }
        "agent_end" => {
            if agent_kind == AgentKind::PrimeAgent {
                // Prime Agent 0.8.1 does not emit Pi's additive agent_settled
                // boundary. A later queued agent_start can move Ready back to
                // Running, so agent_end is the only proven idle signal here.
                set_shared_state(shared, RuntimeState::Ready, event_tx).await;
            }
        }
        "agent_settled" => {
            set_shared_state(shared, RuntimeState::Ready, event_tx).await;
        }
        "turn_start" => {
            let _ = event_tx.send(SurfaceEvent::TurnStarted).await;
        }
        "turn_end" => {
            let _ = event_tx
                .send(SurfaceEvent::TurnCompleted { safe_summary: None })
                .await;
        }
        "message_start" => {
            handle_message_start(value, tracker, event_tx).await;
        }
        "message_update" => {
            handle_message_update(value, tracker, event_tx).await;
        }
        "message_end" => {
            handle_message_end(value, tracker, event_tx).await;
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            handle_tool_execution(&event_type, value, event_tx).await;
        }
        "entry_appended" => {
            handle_entry_appended(value, event_tx).await;
        }
        "queue_update" => {
            let steering = value
                .get("steering")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let follow_up = value
                .get("followUp")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let _ = event_tx
                .send(SurfaceEvent::QueueUpdate {
                    steering,
                    follow_up,
                })
                .await;
        }
        "compaction_start" => {
            let _ = event_tx
                .send(SurfaceEvent::Compaction {
                    active: true,
                    safe_summary: Some("Context is being compacted.".into()),
                })
                .await;
        }
        "compaction_end" => {
            let _ = event_tx
                .send(SurfaceEvent::Compaction {
                    active: false,
                    safe_summary: None,
                })
                .await;
        }
        "thinking_level_changed" => {
            if let Some(level) = value
                .get("level")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                let _ = event_tx
                    .send(SurfaceEvent::ThinkingLevelChanged { level })
                    .await;
            }
        }
        "session_info_changed" => {
            let name = value.get("name").and_then(Value::as_str).map(str::to_owned);
            let _ = event_tx
                .send(SurfaceEvent::SessionInfoChanged {
                    name: name.filter(|name| !name.is_empty()),
                })
                .await;
        }
        "rlm_child_update"
        | "goal_update"
        | "session_action_update"
        | "recap_update"
        | "auth_stale"
        | "refine_complete"
        | "refine_failed"
        | "bash_start"
        | "bash_end" => {
            if agent_kind == AgentKind::PrimeAgent {
                let activity = prime_event_activity(&event_type, &value)
                    .unwrap_or_else(|| prime_unknown_activity(&event_type));
                let _ = event_tx
                    .send(SurfaceEvent::PrimeActivity { activity })
                    .await;
            }
        }
        // Prime can stream an unbounded number of raw `bash_output` chunks.
        // The bounded `bash_end` projection is the only safe activity summary;
        // drop chunks before any awaited event-channel send so they cannot
        // delay a correlated response or terminal lifecycle event.
        "bash_output" => {}
        "auto_retry_end" if agent_kind == AgentKind::PrimeAgent => {
            let _ = event_tx
                .send(SurfaceEvent::PrimeActivity {
                    activity: PrimeActivity::Unknown {
                        id: "prime:auto-retry".into(),
                        wire_type: "auto_retry_end".into(),
                    },
                })
                .await;
        }
        "auto_retry_start"
        | "summarization_retry_scheduled"
        | "summarization_retry_attempt_start" => {
            let _ = event_tx
                .send(SurfaceEvent::RuntimeError {
                    safe_summary: subtype_notice(&event_type),
                })
                .await;
        }
        _ => {
            if agent_kind == AgentKind::PrimeAgent {
                // Preserve an open event union without exposing its raw payload.
                let _ = event_tx
                    .send(SurfaceEvent::PrimeActivity {
                        activity: prime_unknown_activity(&event_type),
                    })
                    .await;
            }
        }
    }
}

fn prime_unknown_activity(event_type: &str) -> PrimeActivity {
    let wire_type = sanitize_single_line(event_type, 80).unwrap_or_else(|| "unknown".into());
    PrimeActivity::Unknown {
        id: opaque_surface_id("prime-event", &wire_type),
        wire_type,
    }
}

fn prime_state_activities(value: &Value) -> Vec<PrimeActivity> {
    let data = value.get("data").unwrap_or(value);
    let mut activities = Vec::new();
    if let Some(goal) = data.get("goal") {
        activities.push(prime_goal_activity(goal));
    }
    if let Some(actions) = data.get("sessionActions") {
        activities.push(prime_session_actions_activity(actions));
    }
    activities
}

fn prime_event_activity(event_type: &str, value: &Value) -> Option<PrimeActivity> {
    match event_type {
        "rlm_child_update" => {
            let child = value.get("child")?.as_object()?;
            let source_id = child.get("id")?.as_str()?;
            let status = allowlisted_string(
                child.get("status"),
                &["queued", "running", "done", "error", "cancelled"],
                "unknown",
            );
            let activity = child
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("kind"))
                .and_then(Value::as_str)
                .filter(|kind| matches!(*kind, "waiting" | "writing" | "executing"))
                .map(str::to_owned);
            let tool_name = child
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("toolName"))
                .and_then(Value::as_str)
                .and_then(|name| sanitize_single_line(name, 80));
            Some(PrimeActivity::RlmChild {
                id: opaque_surface_id("prime-child", source_id),
                // Prime 0.8.1 derives both `label` and the default
                // `sessionName` from the full child task prompt. Keep that
                // prompt host-private and expose only a fixed role label.
                label: "Subagent".into(),
                status,
                model: child
                    .get("model")
                    .and_then(Value::as_str)
                    .and_then(|model| sanitize_single_line(model, 200))
                    .filter(|model| !model.is_empty()),
                activity,
                tool_name,
                duration_ms: child.get("durationMs").and_then(Value::as_u64),
                tool_use_count: child.get("toolUseCount").and_then(Value::as_u64),
                token_count: child.get("tokenCount").and_then(Value::as_u64),
                replied_since_task: child.get("repliedSinceTask").and_then(Value::as_bool),
            })
        }
        "goal_update" => value
            .get("goal")
            .filter(|goal| goal.is_object())
            .map(prime_goal_activity),
        "session_action_update" => value
            .get("actions")
            .filter(|actions| actions.is_object())
            .map(prime_session_actions_activity),
        "recap_update" => Some(PrimeActivity::Recap {
            id: "prime:recap".into(),
            // Prime emits the complete recap body, which can repeat prompts,
            // paths, or credentials. Until upstream provides a safe derived
            // summary, expose only that recap state changed.
            summary: None,
        }),
        "auth_stale" => {
            let provider = value
                .get("provider")
                .and_then(Value::as_str)
                .and_then(|provider| sanitize_single_line(provider, 120))
                .filter(|provider| !provider.is_empty())
                .unwrap_or_else(|| "provider".into());
            Some(PrimeActivity::Authentication {
                id: opaque_surface_id("prime-auth", &provider),
                provider,
                status: "stale".into(),
            })
        }
        "refine_complete" => Some(PrimeActivity::Refinement {
            id: "prime:refinement".into(),
            status: "complete".into(),
        }),
        "refine_failed" => Some(PrimeActivity::Refinement {
            id: "prime:refinement".into(),
            status: "failed".into(),
        }),
        "bash_start" => {
            let source_id = value
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or("owned-bash");
            Some(PrimeActivity::Bash {
                id: opaque_surface_id("prime-bash", source_id),
                status: "running".into(),
                exit_code: None,
                truncated: None,
            })
        }
        "bash_end" => {
            let source_id = value
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or("owned-bash");
            let cancelled = value
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let exit_code = value.get("exitCode").and_then(Value::as_i64);
            Some(PrimeActivity::Bash {
                id: opaque_surface_id("prime-bash", source_id),
                status: if cancelled {
                    "cancelled".into()
                } else if exit_code == Some(0) {
                    "complete".into()
                } else {
                    "failed".into()
                },
                exit_code,
                truncated: value.get("truncated").and_then(Value::as_bool),
            })
        }
        _ => None,
    }
}

fn prime_goal_activity(goal: &Value) -> PrimeActivity {
    let source_id = goal
        .get("goalId")
        .and_then(Value::as_str)
        .unwrap_or("thread-goal");
    PrimeActivity::Goal {
        id: opaque_surface_id("prime-goal", source_id),
        status: allowlisted_string(
            goal.get("status"),
            &[
                "idle",
                "active",
                "paused",
                "budget_limited",
                "complete",
                "error",
            ],
            "idle",
        ),
        objective: goal
            .get("objective")
            .and_then(Value::as_str)
            .and_then(|objective| sanitize_single_line(objective, 500))
            .filter(|objective| !objective.is_empty()),
        tokens_used: goal.get("tokensUsed").and_then(Value::as_u64).unwrap_or(0),
        token_budget: goal.get("tokenBudget").and_then(Value::as_u64),
        time_used_seconds: goal
            .get("timeUsedSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        continuations_used: goal
            .get("continuationsUsed")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn prime_session_actions_activity(actions: &Value) -> PrimeActivity {
    let active_count = usize::from(actions.get("active").is_some_and(|value| !value.is_null()));
    let queued_count = actions
        .get("queuedCount")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or_else(|| {
            actions
                .get("steering")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
                .saturating_add(
                    actions
                        .get("followUps")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0),
                )
        });
    PrimeActivity::SessionActions {
        id: "prime:session-actions".into(),
        active_count,
        queued_count,
    }
}

fn prime_heartbeat_activity(value: &Value) -> Option<PrimeActivity> {
    let heartbeat = value.get("data")?.get("heartbeat")?;
    if heartbeat.is_null() {
        return Some(PrimeActivity::Heartbeat {
            id: "prime:heartbeat".into(),
            status: "not-configured".into(),
            schedule: None,
            delivery_mode: None,
        });
    }
    let source_id = heartbeat
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("heartbeat");
    Some(PrimeActivity::Heartbeat {
        id: opaque_surface_id("prime-heartbeat", source_id),
        status: allowlisted_string(
            heartbeat.get("status"),
            &["active", "paused", "completed", "cancelled"],
            "unknown",
        ),
        schedule: prime_schedule_label(heartbeat.get("schedule")),
        delivery_mode: heartbeat
            .get("deliveryMode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "steer" | "follow_up"))
            .map(str::to_owned),
    })
}

fn prime_schedule_activities(value: &Value) -> Vec<PrimeActivity> {
    value
        .get("data")
        .and_then(|data| data.get("jobs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        // Bound input inspection, not only output collection: an untrusted
        // schedule array must not turn one response into unbounded host work.
        .take(MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS)
        .filter_map(|job| {
            let source_id = job.get("id")?.as_str()?;
            Some(PrimeActivity::Schedule {
                id: opaque_surface_id("prime-schedule", source_id),
                status: allowlisted_string(
                    job.get("status"),
                    &["active", "paused", "completed", "cancelled"],
                    "unknown",
                ),
                source: allowlisted_string(
                    job.get("source"),
                    &["cron", "heartbeat", "rlm_heartbeat"],
                    "cron",
                ),
                schedule: prime_schedule_label(job.get("schedule")),
            })
        })
        .collect()
}

fn prime_schedule_label(schedule: Option<&Value>) -> Option<String> {
    let schedule = schedule?.as_object()?;
    let kind = schedule.get("kind")?.as_str()?;
    if !matches!(kind, "once" | "cron" | "interval") {
        return None;
    }
    let expression = schedule
        .get("expression")
        .and_then(Value::as_str)
        .and_then(|value| sanitize_single_line(value, 160))
        .filter(|value| !value.is_empty());
    Some(match expression {
        Some(expression) => format!("{kind}: {expression}"),
        None => kind.to_owned(),
    })
}

fn allowlisted_string(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|candidate| allowed.contains(candidate))
        .unwrap_or(fallback)
        .to_owned()
}

fn subtype_notice(event_type: &str) -> String {
    match event_type {
        "auto_retry_start" => "Pi is retrying the last turn automatically.".into(),
        "summarization_retry_scheduled" | "summarization_retry_attempt_start" => {
            "Phase a branch/compaction summary.".into()
        }
        _ => format!("Unrecognized Pi event `{event_type}` was ignored."),
    }
}

/// Completes startup only from its initial state. A reader-detected terminal
/// failure must never be overwritten by a late get_state success response.
async fn transition_starting_to_ready(
    shared: &Arc<RuntimeShared>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) -> bool {
    let mut guard = shared.state.lock().await;
    match *guard {
        RuntimeState::Starting => {}
        // A trusted startup hook may legitimately begin a turn before the
        // get_state response reaches us; preserve that newer live state.
        RuntimeState::Ready | RuntimeState::Running => return true,
        RuntimeState::Dormant
        | RuntimeState::Recovering
        | RuntimeState::Stopping
        | RuntimeState::Failed => {
            return false;
        }
    }
    *guard = RuntimeState::Ready;
    let revision = shared.revision.fetch_add(1, Ordering::Relaxed) + 1;
    drop(guard);
    let _ = event_tx
        .send(SurfaceEvent::State {
            state: RuntimeState::Ready,
            revision,
            safe_summary: None,
        })
        .await;
    true
}

async fn set_shared_state(
    shared: &Arc<RuntimeShared>,
    state: RuntimeState,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) {
    let mut guard = shared.state.lock().await;
    if *guard == state {
        return;
    }
    *guard = state;
    let revision = shared.revision.fetch_add(1, Ordering::Relaxed) + 1;
    drop(guard);
    let _ = event_tx
        .send(SurfaceEvent::State {
            state,
            revision,
            safe_summary: None,
        })
        .await;
}

async fn fail_pending(shared: &Arc<RuntimeShared>, summary: &str) {
    let pending = {
        let mut guard = shared.pending.lock().await;
        std::mem::take(&mut *guard)
    };
    let error = RealRuntimeError::Exited(summary.to_owned());
    for (_, sender) in pending {
        let _ = sender.send(Err(error.clone()));
    }
}

async fn mark_failed(
    shared: &Arc<RuntimeShared>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    summary: &str,
) {
    fail_pending(shared, summary).await;
    let mut guard = shared.state.lock().await;
    *guard = RuntimeState::Failed;
    let revision = shared.revision.fetch_add(1, Ordering::Relaxed) + 1;
    drop(guard);
    let _ = event_tx
        .send(SurfaceEvent::State {
            state: RuntimeState::Failed,
            revision,
            safe_summary: Some(summary.into()),
        })
        .await;
    let _ = event_tx
        .send(SurfaceEvent::RuntimeError {
            safe_summary: summary.into(),
        })
        .await;
}

async fn mark_settled(shared: &Arc<RuntimeShared>, event_tx: &mpsc::Sender<SurfaceEvent>) {
    fail_pending(shared, "Agent runtime stopped.").await;
    let mut guard = shared.state.lock().await;
    if *guard == RuntimeState::Failed {
        return;
    }
    *guard = RuntimeState::Dormant;
    let revision = shared.revision.fetch_add(1, Ordering::Relaxed) + 1;
    drop(guard);
    let _ = event_tx
        .send(SurfaceEvent::State {
            state: RuntimeState::Dormant,
            revision,
            safe_summary: Some("Agent runtime exited.".into()),
        })
        .await;
}

async fn handle_message_start(
    value: Value,
    tracker: &mut StreamTracker,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) {
    let Some(message) = value.get("message") else {
        return;
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if role == "user" {
        let block_id = format!("piui-u-{}", tracker.message_seq.wrapping_add(1));
        let text = extract_message_text(message);
        let _ = event_tx
            .send(SurfaceEvent::UserMessage {
                block_id: block_id.clone(),
                text,
            })
            .await;
        return;
    }
    if role == "assistant" {
        tracker.message_seq = tracker.message_seq.wrapping_add(1);
        tracker.current_message_id = Some(format!("piui-m-{}", tracker.message_seq));
        tracker.content_blocks.clear();
        tracker.last_text_block = None;
    }
}

async fn handle_message_update(
    value: Value,
    tracker: &mut StreamTracker,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) {
    let Some(event) = value.get("assistantMessageEvent") else {
        return;
    };
    let Some(kind) = event.get("type").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let message_id = tracker
        .current_message_id
        .clone()
        .unwrap_or_else(|| format!("piui-m-{}", tracker.message_seq));
    match kind.as_str() {
        "text_start" => {
            let block_id = ensure_block(tracker, &message_id, event, "text");
            tracker.last_text_block = Some(block_id.clone());
            let _ = event_tx
                .send(SurfaceEvent::AssistantTextStarted { block_id })
                .await;
        }
        "text_delta" => {
            let block_id = ensure_block(tracker, &message_id, event, "text");
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                let _ = event_tx
                    .send(SurfaceEvent::AssistantTextDelta {
                        block_id,
                        delta: delta.to_owned(),
                    })
                    .await;
            }
        }
        "thinking_start" => {
            let block_id = ensure_block(tracker, &message_id, event, "thinking");
            let _ = event_tx
                .send(SurfaceEvent::ThinkingStarted { block_id })
                .await;
        }
        "thinking_delta" => {
            let block_id = ensure_block(tracker, &message_id, event, "thinking");
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                let _ = event_tx
                    .send(SurfaceEvent::ThinkingDelta {
                        block_id,
                        delta: delta.to_owned(),
                    })
                    .await;
            }
        }
        "text_end" => {
            let block_id = ensure_block(tracker, &message_id, event, "text");
            complete_block(event_tx, block_id, false, None).await;
        }
        "thinking_end" => {
            let block_id = ensure_block(tracker, &message_id, event, "thinking");
            complete_block(event_tx, block_id, false, None).await;
        }
        "done" => {
            complete_tracked_blocks(tracker, event_tx, false, None).await;
            tracker.last_text_block = None;
        }
        "error" => {
            complete_tracked_blocks(
                tracker,
                event_tx,
                true,
                Some("The assistant turn ended with an error.".into()),
            )
            .await;
            tracker.last_text_block = None;
        }
        _ => {}
    }
}

async fn complete_block(
    event_tx: &mpsc::Sender<SurfaceEvent>,
    block_id: String,
    is_error: bool,
    safe_summary: Option<String>,
) {
    let _ = event_tx
        .send(SurfaceEvent::AssistantMessageCompleted {
            block_id: Some(block_id),
            is_error,
            safe_summary,
        })
        .await;
}

async fn complete_tracked_blocks(
    tracker: &StreamTracker,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    is_error: bool,
    safe_summary: Option<String>,
) {
    let block_ids = tracker.content_blocks.values().cloned().collect::<Vec<_>>();
    for block_id in block_ids {
        complete_block(event_tx, block_id, is_error, safe_summary.clone()).await;
    }
}

async fn handle_message_end(
    value: Value,
    tracker: &mut StreamTracker,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) {
    let Some(message) = value.get("message") else {
        return;
    };
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "assistant" {
        let is_error = message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(|reason| reason == "error" || reason == "aborted")
            .unwrap_or(false);
        complete_tracked_blocks(tracker, event_tx, is_error, None).await;
        tracker.last_text_block = None;
        tracker.current_message_id = None;
        tracker.content_blocks.clear();
    }
}

async fn handle_tool_execution(
    event_type: &str,
    value: Value,
    event_tx: &mpsc::Sender<SurfaceEvent>,
) {
    let Some(tool_call_id) = value
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let block_id = opaque_surface_id("tool", &tool_call_id);
    let tool_name = safe_tool_name(
        value
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("tool"),
    );
    match event_type {
        "tool_execution_start" => {
            let _ = event_tx
                .send(SurfaceEvent::ToolStarted {
                    block_id,
                    tool_name,
                })
                .await;
        }
        "tool_execution_update" => {
            let _ = event_tx
                .send(SurfaceEvent::ToolUpdated {
                    block_id,
                    tool_name,
                    safe_summary: redact_tool_partial(&value),
                })
                .await;
        }
        "tool_execution_end" => {
            let is_error = value
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let _ = event_tx
                .send(SurfaceEvent::ToolCompleted {
                    block_id,
                    tool_name,
                    is_error,
                    safe_summary: redact_tool_result(&value),
                })
                .await;
        }
        _ => {}
    }
}

async fn handle_entry_appended(value: Value, event_tx: &mpsc::Sender<SurfaceEvent>) {
    // Message entries are already rendered from the live streaming deltas;
    // surface only non-message persisted records (compaction/custom/etc.) so
    // the UI never receives duplicate blocks for the same turn.
    let Some(entry) = value.get("entry") else {
        return;
    };
    let entry_type = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("custom")
        .to_owned();
    if entry_type == "message" {
        return;
    }
    let source_entry_id = entry.get("id").and_then(Value::as_str).unwrap_or("entry");
    let entry_id = opaque_surface_id("entry", source_entry_id);
    let parent_id = entry
        .get("parentId")
        .and_then(Value::as_str)
        .map(|parent| opaque_surface_id("entry", parent));
    let kind = entry_kind(&entry_type);
    // Entry summaries/names are persisted Pi text and may contain native paths
    // or extension-controlled payloads. The authoritative bounded projection
    // will provide the readable detail after the turn; live events stay label-only.
    let _ = event_tx
        .send(SurfaceEvent::EntryAppended {
            block_id: entry_id.clone(),
            entry_id,
            parent_id,
            entry_kind: kind,
            text: None,
        })
        .await;
}

async fn handle_extension_ui(
    obj: &serde_json::Map<String, Value>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    shared: &Arc<RuntimeShared>,
) {
    let dispatch = {
        let mut mailbox = shared.extension_ui.lock().await;
        mailbox.project(obj)
    };
    let crate::extension_ui::ExtensionUiDispatch {
        action,
        delivery,
        immediate_response,
        pending_id,
    } = dispatch;

    let dialog_timeout_ms = extension_dialog_timeout_ms(&action);

    // A malformed, overflowing, or unsupported dialog must resume Pi even if
    // the event queue is unavailable. The raw frame remains host-private.
    if let Some(response) = immediate_response {
        let _ = write_extension_ui_frame(shared, response).await;
    }

    // Pi may emit presentation updates during session_start, but the Tauri
    // live-runtime slot does not exist until the startup handshake completes.
    // Cancel an awaited startup dialog rather than deadlocking Pi; active-
    // session dialogs use the interactive mailbox immediately after Ready.
    if delivery == ExtensionUiDelivery::Dialog && !shared.extension_ui_ready.load(Ordering::Acquire)
    {
        if let Some(public_id) = pending_id {
            let cancellation = {
                let mut mailbox = shared.extension_ui.lock().await;
                mailbox.cancel(&public_id)
            };
            if let Some(response) = cancellation {
                let _ = write_extension_ui_frame(shared, response).await;
            }
            let _ = event_tx.try_send(SurfaceEvent::ExtensionUi {
                action: crate::extension_ui::ExtensionUiAction::Unsupported {
                    id: public_id,
                    method: "startupDialog".into(),
                    safe_summary: "An extension dialog was cancelled during runtime startup."
                        .into(),
                },
            });
        }
        return;
    }

    // A dialog received while shutdown is in progress has no usable consumer.
    // Remove it and best-effort cancel before stdin is closed instead of
    // blocking the stdout reader on an event that cannot be answered.
    if shared.shutting_down.load(Ordering::Acquire) {
        if let Some(public_id) = pending_id {
            let cancellation = {
                let mut mailbox = shared.extension_ui.lock().await;
                mailbox.cancel(&public_id)
            };
            if let Some(response) = cancellation {
                let _ = write_extension_ui_frame(shared, response).await;
            }
        }
        return;
    }

    let event = SurfaceEvent::ExtensionUi { action };
    match delivery {
        ExtensionUiDelivery::Dialog => {
            // Dialogs are not lossy: the producer is backpressured until the
            // host can render an actionable request.
            if event_tx.send(event).await.is_err() {
                if let Some(public_id) = pending_id {
                    let cancellation = {
                        let mut mailbox = shared.extension_ui.lock().await;
                        mailbox.cancel(&public_id)
                    };
                    if let Some(response) = cancellation {
                        let _ = write_extension_ui_frame(shared, response).await;
                    }
                }
            } else if let (Some(public_id), Some(timeout_ms)) = (pending_id, dialog_timeout_ms) {
                mirror_extension_dialog_timeout(
                    Arc::clone(shared),
                    event_tx.clone(),
                    public_id,
                    timeout_ms,
                )
                .await;
            }
        }
        ExtensionUiDelivery::FireAndForget => {
            // Notifications and presentation updates never block protocol
            // routing. Preserve capacity for lifecycle/dialog events while a
            // startup receiver has not yet been handed to the host.
            if event_tx.capacity() > 32 {
                let _ = event_tx.try_send(event);
            }
        }
    }
}

fn extension_dialog_timeout_ms(action: &ExtensionUiAction) -> Option<u64> {
    match action {
        ExtensionUiAction::Dialog { request } => match request {
            crate::extension_ui::ExtensionDialogRequest::Select { timeout_ms, .. }
            | crate::extension_ui::ExtensionDialogRequest::Confirm { timeout_ms, .. }
            | crate::extension_ui::ExtensionDialogRequest::Input { timeout_ms, .. }
            | crate::extension_ui::ExtensionDialogRequest::Editor { timeout_ms, .. } => *timeout_ms,
        },
        _ => None,
    }
}

async fn mirror_extension_dialog_timeout(
    shared: Arc<RuntimeShared>,
    event_tx: mpsc::Sender<SurfaceEvent>,
    public_id: String,
    timeout_ms: u64,
) {
    let mailbox = shared.extension_ui.lock().await;
    if !mailbox.contains(&public_id) {
        return;
    }
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let previous = shared
        .extension_ui_timeouts
        .lock()
        .await
        .insert(public_id.clone(), cancel_tx);
    drop(mailbox);
    if let Some(previous) = previous {
        let _ = previous.send(());
    }
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {}
            _ = cancel_rx => return,
        }
        shared.extension_ui_timeouts.lock().await.remove(&public_id);
        let expired = {
            let mut mailbox = shared.extension_ui.lock().await;
            mailbox.forget(&public_id)
        };
        if expired && !shared.shutting_down.load(Ordering::Acquire) {
            let _ = event_tx
                .send(SurfaceEvent::ExtensionUi {
                    action: ExtensionUiAction::Unsupported {
                        id: public_id,
                        method: "dialogTimeout".into(),
                        safe_summary: "An extension dialog expired.".into(),
                    },
                })
                .await;
        }
    });
}

fn ensure_block(
    tracker: &mut StreamTracker,
    message_id: &str,
    event: &Value,
    variant: &str,
) -> String {
    let idx = content_index(event);
    let prefix = match variant {
        "thinking" => 'k',
        _ => 't',
    };
    tracker
        .content_blocks
        .entry(idx)
        .or_insert_with(|| format!("{message_id}-{prefix}{idx}"))
        .clone()
}

fn content_index(event: &Value) -> usize {
    event
        .get("contentIndex")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(0)
}

fn extract_message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text").and_then(Value::as_str).map(str::to_owned)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn entry_kind(entry_type: &str) -> String {
    match entry_type {
        "compaction" => "compaction".into(),
        "branch_summary" => "compaction".into(),
        "custom" | "custom_message" => "custom".into(),
        "label" => "custom".into(),
        "session_info" => "custom".into(),
        "model_change" => "custom".into(),
        "thinking_level_change" => "thinking".into(),
        _ => "unknown".into(),
    }
}

fn redact_command_error(_command: &str, _error: &str) -> String {
    // Both fields are untrusted runtime text and can contain a local path,
    // credential, or prompt fragment. The pending typed request already knows
    // its operation; the generic event must reveal neither raw field.
    "The agent runtime rejected a command.".into()
}

fn redact_tool_partial(value: &Value) -> Option<String> {
    let name = value
        .get("toolName")
        .and_then(Value::as_str)
        .map(safe_tool_name)
        .unwrap_or_else(|| "Tool activity".to_owned());
    Some(format!("`{name}` produced a partial result."))
}

fn redact_tool_result(value: &Value) -> Option<String> {
    let is_error = value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let name = value
        .get("toolName")
        .and_then(Value::as_str)
        .map(safe_tool_name)
        .unwrap_or_else(|| "Tool activity".to_owned());
    Some(if is_error {
        format!("`{name}` reported an error.")
    } else {
        format!("`{name}` completed.")
    })
}

fn opaque_surface_id(kind: &str, source_id: &str) -> String {
    format!("piui-{kind}-{:x}", Sha256::digest(source_id.as_bytes()))
}

fn safe_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "bash" => "bash".to_owned(),
        "read" | "read_file" => "Read file".to_owned(),
        "write" | "write_file" => "Write file".to_owned(),
        "edit" | "edit_file" => "Edit file".to_owned(),
        "grep" | "search" => "Search workspace".to_owned(),
        _ => "Tool activity".to_owned(),
    }
}

fn map_session_state(value: &Value) -> SessionStateLite {
    let data = value.get("data").unwrap_or(value);
    let model = data.get("model").and_then(|model| {
        let provider = model.get("provider").and_then(Value::as_str)?;
        let id = model.get("id").and_then(Value::as_str)?;
        Some(ModelLite {
            provider: provider.to_owned(),
            id: id.to_owned(),
            label: model
                .get("label")
                .or_else(|| model.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    });
    SessionStateLite {
        session_id: data
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        session_name: data
            .get("sessionName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        message_count: data
            .get("messageCount")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(0),
        pending_message_count: data
            .get("pendingMessageCount")
            .and_then(Value::as_u64)
            .or_else(|| {
                data.get("sessionActions")
                    .and_then(|actions| actions.get("queuedCount"))
                    .and_then(Value::as_u64)
            })
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0),
        is_streaming: data
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_compacting: data
            .get("isCompacting")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        auto_compaction_enabled: data
            .get("autoCompactionEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        steering_mode: data
            .get("steeringMode")
            .and_then(Value::as_str)
            .unwrap_or("all")
            .to_owned(),
        follow_up_mode: data
            .get("followUpMode")
            .and_then(Value::as_str)
            .unwrap_or("all")
            .to_owned(),
        model,
        thinking_level: data
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_owned(),
    }
}

fn map_models(value: &Value) -> Option<Vec<ModelLite>> {
    let data = value.get("data").unwrap_or(value);
    let models = data.get("models")?.as_array()?;
    Some(
        models
            .iter()
            .filter_map(|model| {
                let provider = model.get("provider").and_then(Value::as_str)?;
                let id = model.get("id").and_then(Value::as_str)?;
                Some(ModelLite {
                    provider: provider.to_owned(),
                    id: id.to_owned(),
                    label: model
                        .get("label")
                        .or_else(|| model.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
            })
            .collect(),
    )
}

fn map_runtime_commands(value: &Value) -> Result<Vec<RuntimeCommandLite>, RealRuntimeError> {
    let data = required_response_data(value, "get_commands")?;
    let commands = data
        .get("commands")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RealRuntimeError::Protocol("Pi `get_commands` response lacked commands".into())
        })?;
    if commands.len() > MAX_RUNTIME_COMMANDS {
        return Err(RealRuntimeError::Protocol(
            "Pi `get_commands` response exceeded the command limit".into(),
        ));
    }

    let mut projected = Vec::with_capacity(commands.len());
    for command in commands {
        if let Some(command) = parse_runtime_command(command) {
            // Preserve collisions even when their private source paths reduce
            // to identical public provenance. The frontend suppresses every
            // ambiguous invocation instead of executing an arbitrary winner.
            projected.push(command);
        }
    }
    Ok(projected)
}

fn parse_runtime_command(value: &Value) -> Option<RuntimeCommandLite> {
    let command = value.as_object()?;
    let name = command.get("name")?.as_str()?;
    if !valid_runtime_command_name(name) {
        return None;
    }
    let source = command.get("source")?.as_str()?;
    if !matches!(source, "extension" | "prompt" | "skill") {
        return None;
    }

    let description = match command.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(description)) => {
            Some(sanitize_runtime_command_description(description, name)?)
        }
        Some(_) => return None,
    };

    let source_info = match command.get("sourceInfo") {
        None | Some(Value::Null) => None,
        Some(Value::Object(source_info)) => Some(source_info),
        Some(_) => return None,
    };
    let scope = parse_runtime_command_scope(source_info, command)?;
    let origin = parse_runtime_command_origin(source_info)?;

    Some(RuntimeCommandLite {
        name: name.to_owned(),
        description,
        source: source.to_owned(),
        scope,
        origin,
    })
}

fn valid_runtime_command_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_RUNTIME_COMMAND_NAME_CHARS
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn parse_runtime_command_scope(
    source_info: Option<&serde_json::Map<String, Value>>,
    command: &serde_json::Map<String, Value>,
) -> Option<Option<String>> {
    let scope = source_info
        .and_then(|source_info| source_info.get("scope"))
        .or_else(|| command.get("location"));
    parse_runtime_command_provenance(scope, &["user", "project", "temporary"])
}

fn parse_runtime_command_origin(
    source_info: Option<&serde_json::Map<String, Value>>,
) -> Option<Option<String>> {
    parse_runtime_command_provenance(
        source_info.and_then(|source_info| source_info.get("origin")),
        &["package", "top-level"],
    )
}

fn parse_runtime_command_provenance(
    value: Option<&Value>,
    allowed: &[&str],
) -> Option<Option<String>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => {
            Some(Some(value.clone()))
        }
        Some(_) => None,
    }
}

fn sanitize_runtime_command_description(value: &str, command_name: &str) -> Option<String> {
    const COMMAND_SENTINEL: &str = "\u{fdd0}piui-slash-command\u{fdd1}";
    let invocation = format!("/{command_name}");
    let mut protected = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = value[cursor..].find(&invocation) {
        let start = cursor + relative;
        let end = start + invocation.len();
        protected.push_str(&value[cursor..start]);
        let boundary_before = value[..start].chars().next_back().is_none_or(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-')
        });
        let boundary_after = value[end..].chars().next().is_none_or(|character| {
            !character.is_ascii_alphanumeric()
                && !matches!(character, '_' | '-' | '.' | ':' | '/' | '\\')
        });
        if boundary_before && boundary_after {
            protected.push_str(COMMAND_SENTINEL);
        } else {
            protected.push_str(&invocation);
        }
        cursor = end;
    }
    protected.push_str(&value[cursor..]);
    sanitize_single_line(&protected, MAX_RUNTIME_COMMAND_DESCRIPTION_CHARS)
        .map(|description| description.replace(COMMAND_SENTINEL, &invocation))
}

fn map_thinking_levels(value: &Value) -> Option<Vec<String>> {
    let data = value.get("data").unwrap_or(value);
    let levels = data.get("levels")?.as_array()?;
    if levels.len() > MAX_THINKING_LEVELS {
        return None;
    }

    let mut projected = Vec::with_capacity(levels.len());
    for level in levels {
        let level = level.as_str()?;
        if !known_thinking_level(level) || projected.iter().any(|item| item == level) {
            return None;
        }
        projected.push(level.to_owned());
    }
    Some(projected)
}

fn known_thinking_level(value: &str) -> bool {
    matches!(
        value,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn scan_fixed_marker(chunk: &[u8], marker: &[u8], matched: &mut usize) -> bool {
    for byte in chunk {
        if *byte == marker[*matched] {
            *matched += 1;
            if *matched == marker.len() {
                return true;
            }
        } else {
            *matched = usize::from(*byte == marker[0]);
        }
    }
    false
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr, shared: Arc<RuntimeShared>) {
    let mut buf = vec![0u8; READ_BUF_BYTES];
    let mut marker_offsets = [0_usize; PRIME_SESSION_ACTIVE_STDERR_MARKERS.len()];
    // Stderr is never surfaced or retained. Match only fixed upstream ownership
    // markers so startup can return a typed, path-free conflict instead of a
    // generic EOF failure, while still draining the pipe fully.
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if !shared.session_already_active.load(Ordering::Relaxed)
                    && PRIME_SESSION_ACTIVE_STDERR_MARKERS
                        .iter()
                        .zip(marker_offsets.iter_mut())
                        .any(|(marker, matched)| scan_fixed_marker(&buf[..read], marker, matched))
                {
                    shared.session_already_active.store(true, Ordering::Release);
                }
            }
        }
    }
}

/// Resolves how to launch the installed Pi CLI in rpc mode.
pub fn resolve_pi_launch() -> Result<PiLaunch, String> {
    if let Some(cli) = std::env::var_os("PIUI_PI_CLI") {
        let cli_path = PathBuf::from(cli);
        if cli_path.is_file() {
            let node = resolve_node_program(
                &cli_path,
                std::env::var_os("PIUI_PI_NODE"),
                std::env::var_os("PATH"),
            );
            return Ok(PiLaunch {
                program: node,
                leading_args: vec![cli_path.to_string_lossy().into_owned()],
                label: "PIUI_PI_CLI override".into(),
            });
        }
    }

    if let Some(cli_path) = resolve_global_cli_js() {
        let node = resolve_node_program(
            &cli_path,
            std::env::var_os("PIUI_PI_NODE"),
            std::env::var_os("PATH"),
        );
        return Ok(PiLaunch {
            program: node,
            leading_args: vec![cli_path.to_string_lossy().into_owned()],
            label: "node + pi-coding-agent cli.js".into(),
        });
    }

    // Fallback: invoke the `pi` launcher directly.
    #[cfg(windows)]
    let program = PathBuf::from("pi.cmd");
    #[cfg(not(windows))]
    let program = PathBuf::from("pi");
    Ok(PiLaunch {
        program,
        leading_args: Vec::new(),
        label: "pi launcher (PATH)".into(),
    })
}

/// Resolves the installed Prime Agent CLI without invoking an npm shell shim
/// when its package entry point can be found directly.
pub fn resolve_prime_launch() -> Result<PiLaunch, String> {
    if let Some(cli) = std::env::var_os("PIUI_PRIME_AGENT_CLI") {
        let cli_path = PathBuf::from(cli);
        return resolve_configured_prime_launch(
            &cli_path,
            std::env::var_os("PIUI_PRIME_AGENT_NODE"),
            std::env::var_os("PATH"),
        );
    }

    if let Some(cli_path) = resolve_global_prime_cli_js() {
        validate_supported_prime_cli_identity(&cli_path)?;
        let node = resolve_node_program(
            &cli_path,
            std::env::var_os("PIUI_PRIME_AGENT_NODE"),
            std::env::var_os("PATH"),
        );
        return Ok(PiLaunch {
            program: node,
            leading_args: vec![cli_path.to_string_lossy().into_owned()],
            label: "node + supported prime-agent 0.8.1 cli.js".into(),
        });
    }

    Err("A supported prime-agent 0.8.1 package entry point was not found.".into())
}

fn resolve_configured_prime_launch(
    cli_path: &Path,
    node_override: Option<OsString>,
    path_env: Option<OsString>,
) -> Result<PiLaunch, String> {
    if !cli_path.is_file() {
        return Err("The configured Prime Agent entry point is unavailable.".into());
    }
    validate_supported_prime_cli_identity(cli_path)?;
    Ok(PiLaunch {
        program: resolve_node_program(cli_path, node_override, path_env),
        leading_args: vec![cli_path.to_string_lossy().into_owned()],
        label: "supported prime-agent 0.8.1 override".into(),
    })
}

fn validate_supported_prime_cli_identity(cli_path: &Path) -> Result<(), String> {
    let package_root = cli_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "The Prime Agent package layout is unsupported.".to_owned())?;
    let package_bytes = std::fs::read(package_root.join("package.json"))
        .map_err(|_| "The Prime Agent package identity is unavailable.".to_owned())?;
    let package: Value = serde_json::from_slice(&package_bytes)
        .map_err(|_| "The Prime Agent package identity is invalid.".to_owned())?;
    if package.get("name").and_then(Value::as_str) != Some("prime-agent")
        || package.get("version").and_then(Value::as_str) != Some(SUPPORTED_PRIME_AGENT_VERSION)
    {
        return Err(
            "The configured Prime Agent package does not have the supported name and version."
                .into(),
        );
    }
    Ok(())
}

fn prime_cli_from_launcher(launcher: &Path) -> Option<PathBuf> {
    const PACKAGE: &str = "prime-agent";
    const REL: &str = "dist/bundle/cli.js";
    #[cfg(not(windows))]
    {
        // npm/nvm normally exposes `<prefix>/bin/prime-agent` as a symlink to
        // the package entry point under `<prefix>/lib/node_modules`. Resolve
        // that target instead of assuming a fixed global prefix.
        if let Ok(target) = std::fs::canonicalize(launcher) {
            if target.is_file() && target.ends_with(Path::new(REL)) {
                return Some(target);
            }
        }
    }
    let bin_dir = launcher.parent()?;
    let candidate = bin_dir.join("node_modules").join(PACKAGE).join(REL);
    candidate.is_file().then_some(candidate)
}

fn resolve_global_prime_cli_js() -> Option<PathBuf> {
    const PACKAGE: &str = "prime-agent";
    const REL: &str = "dist/bundle/cli.js";
    if let Some(candidate) = find_prime_launcher()
        .as_deref()
        .and_then(prime_cli_from_launcher)
    {
        return Some(candidate);
    }
    for root in common_global_roots() {
        let candidate = root.join(PACKAGE).join(REL);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_prime_launcher() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["prime-agent.cmd", "prime-agent.CMD", "prime-agent"]
    } else {
        &["prime-agent"]
    };
    find_launcher_in_path(names, std::env::var_os("PATH"))
}

fn resolve_global_cli_js() -> Option<PathBuf> {
    const PACKAGE: &str = "@earendil-works/pi-coding-agent";
    const REL: &str = "dist/cli.js";

    // Derive the npm global bin directory from the `pi` launcher, then climb to
    // the sibling node_modules entry. Keeps this cross-platform without
    // spawning `npm` or hard-coding install roots.
    let pi_path = find_pi_launcher()?;
    let bin_dir = pi_path.parent()?;
    let candidate = bin_dir.join("node_modules").join(PACKAGE).join(REL);
    if candidate.is_file() {
        return Some(candidate);
    }

    for root in common_global_roots() {
        let candidate = root.join(PACKAGE).join(REL);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_pi_launcher() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["pi.cmd", "pi.CMD", "pi"]
    } else {
        &["pi"]
    };
    find_launcher_in_path(names, std::env::var_os("PATH"))
}

/// Prefer the Node executable installed beside npm's global launcher. Desktop
/// apps inherit Explorer's environment, which can lag behind a recent Node/Pi
/// installation even though the global package itself is already discoverable
/// through APPDATA. An explicit override remains authoritative.
fn resolve_node_program(
    cli_path: &Path,
    override_program: Option<OsString>,
    path_env: Option<OsString>,
) -> PathBuf {
    if let Some(program) = override_program.filter(|value| !value.is_empty()) {
        return PathBuf::from(program);
    }

    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    // npm's Windows shims and optional node.exe live at the global bin root,
    // while cli.js is nested below node_modules/@scope/package/dist. Search
    // only this already-resolved package's ancestors before consulting PATH.
    for directory in cli_path.ancestors().skip(1) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    find_launcher_in_path(names, path_env)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }))
}

fn find_launcher_in_path(names: &[&str], path_env: Option<OsString>) -> Option<PathBuf> {
    let path_env = path_env?;
    for directory in std::env::split_paths(&path_env) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn common_global_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm").join("node_modules"));
    }
    if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
        roots.push(
            PathBuf::from(local_appdata)
                .join("pnpm")
                .join("global")
                .join("5")
                .join("node_modules"),
        );
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".npm-global").join("lib").join("node_modules"));
        roots.push(
            home.join(".local")
                .join("share")
                .join("npm")
                .join("lib")
                .join("node_modules"),
        );
        roots.push(home.join(".pnpm-global").join("lib").join("node_modules"));
    }
    roots.push(PathBuf::from("/usr/local/lib/node_modules"));
    roots.push(PathBuf::from("/usr/lib/node_modules"));
    roots
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::prime_cli_from_launcher;
    use super::{
        COMMAND_TIMEOUT, LIVE_EVENT_CHANNEL_CAPACITY, LOCAL_RUNTIME_EVENT_PROTOCOL,
        MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS, PRIME_SESSION_ACTIVE_STDERR_MARKERS, PrimeActivity,
        RealPiConfig, RealPiRuntime, RealRuntimeError, RuntimeEventEnvelope, RuntimeShared,
        StreamTracker, SurfaceEvent, abort_command, fail_pending, handle_extension_ui,
        handle_frame, handle_frame_for_kind, map_models, map_runtime_commands, map_session_state,
        map_thinking_levels, opaque_surface_id, prime_event_activity, prime_heartbeat_activity,
        prime_schedule_activities, prime_state_activities, prompt_command, redact_command_error,
        request_is_blocked, require_isolated_prime_daemon, required_response_data,
        resolve_configured_prime_launch, resolve_node_program, run_stdout_loop,
        runtime_launch_args, safe_tool_name, sanitize_runtime_command_description,
        scan_fixed_marker, transition_starting_to_ready, validate_success_response,
        validate_supported_prime_cli_identity,
    };
    use crate::extension_ui::{
        ExtensionDialogRequest, ExtensionUiAction, ExtensionUiMailbox, ExtensionUiResponse,
    };
    use piui_contracts::{AgentKind, RuntimeState};
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::sync::{Mutex, mpsc, oneshot};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);
    // Live Prime tests share externally supplied session roots. This guard keeps
    // their independent create/resume/lease probes from racing one another.
    static LIVE_PRIME_TEST_LOCK: Mutex<()> = Mutex::const_new(());
    // A failed startup can consume the 20-second command bound, then run the
    // 6-second reader wait, 1-second stderr drain, and 6-second child wait.
    const LIVE_PRIME_OPERATION_TIMEOUT: Duration = Duration::from_secs(33);

    #[test]
    fn installed_cli_prefers_a_sibling_node_without_relying_on_explorer_path() {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-node-resolution-test-{}-{serial}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let cli = root
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js");
        fs::create_dir_all(cli.parent().expect("cli parent")).expect("creates resolver fixture");
        fs::write(&cli, "// fixture").expect("writes cli fixture");
        let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        fs::write(&node, b"fixture").expect("writes node fixture");

        let resolved = resolve_node_program(&cli, None, None);

        assert_eq!(resolved, node);
        fs::remove_dir_all(root).expect("removes resolver fixture");
    }

    #[test]
    fn prime_launch_accepts_only_the_supported_name_and_version_identity() {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-prime-version-test-{}-{serial}",
            std::process::id()
        ));
        let cli = root
            .join("prime-agent")
            .join("dist")
            .join("bundle")
            .join("cli.js");
        fs::create_dir_all(cli.parent().expect("Prime CLI parent"))
            .expect("creates Prime resolver fixture");
        fs::write(&cli, "// fixture").expect("writes Prime CLI fixture");
        fs::write(
            root.join("prime-agent").join("package.json"),
            r#"{"name":"prime-agent","version":"0.8.1"}"#,
        )
        .expect("writes supported package identity");
        assert!(validate_supported_prime_cli_identity(&cli).is_ok());

        fs::write(
            root.join("prime-agent").join("package.json"),
            r#"{"name":"prime-agent","version":"0.9.0"}"#,
        )
        .expect("writes unsupported package identity");
        let error = validate_supported_prime_cli_identity(&cli)
            .expect_err("rejects an unsupported name/version identity");
        assert!(!error.contains("0.9.0"));
        fs::remove_dir_all(root).expect("removes Prime resolver fixture");
    }

    #[test]
    fn configured_missing_prime_cli_is_rejected_without_disclosing_path() {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let unavailable = std::env::temp_dir().join(format!(
            "piui-missing-prime-cli-{}-{serial}",
            std::process::id()
        ));

        let error = resolve_configured_prime_launch(&unavailable, None, None)
            .expect_err("missing configured Prime entry point is rejected");

        assert_eq!(
            error,
            "The configured Prime Agent entry point is unavailable."
        );
        assert!(!error.contains(unavailable.to_string_lossy().as_ref()));
    }

    #[test]
    fn production_prime_launch_requires_an_explicit_isolated_daemon_endpoint() {
        assert!(
            require_isolated_prime_daemon(AgentKind::PrimeAgent, None).is_err(),
            "the shared default Prime daemon must never be a live-runtime target",
        );
        #[cfg(windows)]
        let isolated = std::ffi::OsStr::new(r"\\.\pipe\piui-test-daemon");
        #[cfg(not(windows))]
        let isolated = std::ffi::OsStr::new("/tmp/piui-test-daemon.sock");
        assert!(require_isolated_prime_daemon(AgentKind::PrimeAgent, Some(isolated)).is_ok());
        assert!(
            require_isolated_prime_daemon(
                AgentKind::PrimeAgent,
                Some(std::ffi::OsStr::new("prime-agent-daemon")),
            )
            .is_err(),
        );
        assert!(require_isolated_prime_daemon(AgentKind::Pi, None).is_ok());
    }

    #[test]
    fn prime_launch_arguments_keep_new_sessions_unselected_and_resume_only_the_chosen_file() {
        let new_args = runtime_launch_args(
            &RealPiConfig {
                cwd: std::path::PathBuf::from("one-project"),
                session_path: None,
                session_name: None,
            },
            AgentKind::PrimeAgent,
            Some(std::ffi::OsStr::new("isolated-prime-daemon")),
        )
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        assert_eq!(
            new_args,
            ["--mode", "rpc", "--daemon-socket", "isolated-prime-daemon"]
        );

        let selected_a = runtime_launch_args(
            &RealPiConfig {
                cwd: std::path::PathBuf::from("one-project"),
                session_path: Some(std::path::PathBuf::from("session-a.jsonl")),
                session_name: None,
            },
            AgentKind::PrimeAgent,
            Some(std::ffi::OsStr::new("isolated-prime-daemon")),
        )
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        let selected_b = runtime_launch_args(
            &RealPiConfig {
                cwd: std::path::PathBuf::from("one-project"),
                session_path: Some(std::path::PathBuf::from("session-b.jsonl")),
                session_name: None,
            },
            AgentKind::PrimeAgent,
            Some(std::ffi::OsStr::new("isolated-prime-daemon")),
        )
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

        assert_eq!(
            selected_a,
            [
                "--mode",
                "rpc",
                "--daemon-socket",
                "isolated-prime-daemon",
                "--resume",
                "session-a.jsonl"
            ]
        );
        assert_eq!(
            selected_b,
            [
                "--mode",
                "rpc",
                "--daemon-socket",
                "isolated-prime-daemon",
                "--resume",
                "session-b.jsonl"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn prime_launch_resolves_an_npm_prefix_symlink() {
        use std::os::unix::fs::symlink;

        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-prime-symlink-test-{}-{serial}",
            std::process::id()
        ));
        let cli = root
            .join("lib")
            .join("node_modules")
            .join("prime-agent")
            .join("dist")
            .join("bundle")
            .join("cli.js");
        let launcher = root.join("bin").join("prime-agent");
        fs::create_dir_all(cli.parent().expect("Prime CLI parent"))
            .expect("creates npm package fixture");
        fs::create_dir_all(launcher.parent().expect("launcher parent"))
            .expect("creates npm bin fixture");
        fs::write(&cli, "// fixture").expect("writes npm Prime fixture");
        symlink(&cli, &launcher).expect("links npm Prime launcher");
        assert_eq!(
            prime_cli_from_launcher(&launcher),
            fs::canonicalize(&cli).ok()
        );
        fs::remove_dir_all(root).expect("removes npm symlink fixture");
    }

    #[tokio::test]
    async fn startup_dialog_is_cancelled_instead_of_blocking_the_handshake() {
        let shared = shared_for_test(RuntimeState::Starting);
        shared.extension_ui_ready.store(false, Ordering::Release);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let request = json!({
            "id": "startup-confirm",
            "method": "confirm",
            "title": "Continue?",
            "message": "Startup dialog",
        });
        handle_extension_ui(
            request.as_object().expect("extension request object"),
            &event_tx,
            &shared,
        )
        .await;

        assert_eq!(shared.extension_ui.lock().await.pending_len(), 0);
        assert!(matches!(
            event_rx.recv().await,
            Some(SurfaceEvent::ExtensionUi {
                action: ExtensionUiAction::Unsupported { ref method, .. }
            }) if method == "startupDialog"
        ));
    }

    #[tokio::test]
    async fn dialog_timeout_is_mirrored_without_sending_a_competing_response() {
        let shared = shared_for_test(RuntimeState::Ready);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let request = json!({
            "id": "timed-confirm",
            "method": "confirm",
            "title": "Continue?",
            "message": "Timed dialog",
            "timeout": 5,
        });
        handle_extension_ui(
            request.as_object().expect("extension request object"),
            &event_tx,
            &shared,
        )
        .await;

        assert!(matches!(
            event_rx.recv().await,
            Some(SurfaceEvent::ExtensionUi {
                action: ExtensionUiAction::Dialog { .. }
            })
        ));
        let expired = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .expect("timeout mirror arrives");
        assert!(matches!(
            expired,
            Some(SurfaceEvent::ExtensionUi {
                action: ExtensionUiAction::Unsupported { ref method, .. }
            }) if method == "dialogTimeout"
        ));
        assert_eq!(shared.extension_ui.lock().await.pending_len(), 0);
    }

    #[tokio::test]
    async fn answering_a_timed_dialog_cancels_its_expiry_task() {
        let shared = shared_for_test(RuntimeState::Ready);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let request = json!({
            "id": "answered-confirm",
            "method": "confirm",
            "title": "Continue?",
            "message": "Timed dialog",
            "timeout": 60_000,
        });
        handle_extension_ui(
            request.as_object().expect("extension request object"),
            &event_tx,
            &shared,
        )
        .await;
        let public_id = match event_rx.recv().await {
            Some(SurfaceEvent::ExtensionUi {
                action:
                    ExtensionUiAction::Dialog {
                        request: ExtensionDialogRequest::Confirm { id, .. },
                    },
            }) => id,
            _ => panic!("expected confirm dialog"),
        };
        assert_eq!(shared.extension_ui_timeouts.lock().await.len(), 1);
        let runtime = RealPiRuntime {
            shared: Arc::clone(&shared),
            child: Mutex::new(None),
            reader: Mutex::new(None),
            stderr: Mutex::new(None),
            launch_label: "test".into(),
            agent_kind: AgentKind::Pi,
            #[cfg(unix)]
            unix_group: StdMutex::new(None),
            #[cfg(windows)]
            windows_job: StdMutex::new(None),
        };
        assert!(matches!(
            runtime
                .respond_extension_ui(public_id, ExtensionUiResponse::Confirmed { value: true },)
                .await,
            Err(RealRuntimeError::NotRunning)
        ));
        tokio::task::yield_now().await;
        assert!(shared.extension_ui_timeouts.lock().await.is_empty());
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn runtime_extension_projection_is_opaque_bounded_and_path_safe() {
        let mut mailbox = ExtensionUiMailbox::new();
        let request = json!({
            "id": "C:\\private\\extension-request",
            "method": "notify",
            "message": "Read C:\\private\\notice.txt\u{0007}",
            "notifyType": "warning",
        });
        let object = request.as_object().expect("extension request object");
        let dispatch = mailbox.project(object);
        let payload = serde_json::to_value(SurfaceEvent::ExtensionUi {
            action: dispatch.action,
        })
        .expect("serializes extension action");

        assert_eq!(payload["kind"], "extensionUi");
        assert_eq!(payload["action"]["action"], "notify");
        assert_eq!(payload["action"]["level"], "warning");
        assert_eq!(
            payload["action"]["message"],
            "Read <external-path>/notice.txt"
        );
        let id = payload["action"]["id"]
            .as_str()
            .expect("opaque notification id");
        assert!(id.starts_with("piui-extension-"));
        assert!(!id.contains("private"));
        assert!(!payload.to_string().contains("C:\\private"));
    }

    #[test]
    fn state_projection_never_serializes_the_pi_session_file_path() {
        let state = map_session_state(&json!({
            "data": {
                "sessionId": "session-id",
                "sessionName": "A local session",
                "sessionFile": "C:\\private\\sessions\\secret.jsonl",
                "messageCount": 3,
                "pendingMessageCount": 0,
                "isStreaming": false,
                "isCompacting": false,
                "autoCompactionEnabled": true,
                "steeringMode": "all",
                "followUpMode": "all",
                "thinkingLevel": "high",
                "model": { "provider": "test", "id": "model", "name": "Model label" }
            }
        }));

        let serialized = serde_json::to_string(&state).expect("serializes safe state");
        assert_eq!(state.session_id, "session-id");
        assert_eq!(
            state.model.and_then(|model| model.label),
            Some("Model label".into())
        );
        assert!(!serialized.contains("secret.jsonl"));
        assert!(!serialized.contains("C:\\private"));
    }

    #[test]
    fn runtime_surface_ids_are_opaque() {
        let id = opaque_surface_id("tool", "private-call-id");
        assert!(id.starts_with("piui-tool-"));
        assert!(!id.contains("private-call-id"));
        assert_eq!(id, opaque_surface_id("tool", "private-call-id"));
    }

    #[test]
    fn runtime_tool_labels_are_allowlisted_and_path_safe() {
        assert_eq!(safe_tool_name("bash"), "bash");
        assert_eq!(safe_tool_name("read_file"), "Read file");
        assert_eq!(
            safe_tool_name(r"D:\\private\\tool-with-secret"),
            "Tool activity"
        );
        assert_eq!(safe_tool_name("../../secret"), "Tool activity");
    }

    #[test]
    fn model_projection_accepts_the_upstream_name_field() {
        let models = map_models(&json!({
            "data": {
                "models": [
                    { "provider": "openai-codex", "id": "gpt", "name": "GPT test" }
                ]
            }
        }))
        .expect("maps models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label.as_deref(), Some("GPT test"));
    }

    #[test]
    fn command_projection_is_bounded_collision_preserving_and_path_safe() {
        let commands = map_runtime_commands(&json!({
            "data": {
                "commands": [
                    {
                        "name": "review:1",
                        "description": "Review C:\\private\\project\\secret.md\u{0007}",
                        "source": "extension",
                        "sourceInfo": {
                            "scope": "project",
                            "origin": "package",
                            "path": "C:\\private\\extension.ts",
                            "baseDir": "C:\\private"
                        }
                    },
                    {
                        "name": "review:1",
                        "description": "Duplicate is ignored",
                        "source": "extension",
                        "sourceInfo": { "scope": "project", "origin": "package" }
                    },
                    {
                        "name": "review:1",
                        "description": "Same name, different provenance remains",
                        "source": "prompt",
                        "location": "user",
                        "sourceInfo": {
                            "path": "/home/private/.pi/prompts/review.md",
                            "baseDir": "/home/private"
                        }
                    },
                    { "name": "unsafe name", "source": "extension" },
                    { "name": "unknown", "source": "built-in" },
                    {
                        "name": "bad-origin",
                        "source": "skill",
                        "sourceInfo": { "origin": "untrusted" }
                    }
                ]
            }
        }))
        .expect("valid catalog");

        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0].name, "review:1");
        assert_eq!(commands[0].scope.as_deref(), Some("project"));
        assert_eq!(commands[0].origin.as_deref(), Some("package"));
        assert_eq!(
            commands[0].description.as_deref(),
            Some("Review <external-path>/secret.md")
        );
        assert_eq!(commands[1].name, "review:1");
        assert_eq!(commands[1].source, "extension");
        assert_eq!(commands[2].scope.as_deref(), Some("user"));
        assert_eq!(commands[2].origin, None);
        let serialized = serde_json::to_string(&commands).expect("serializes safe commands");
        assert!(!serialized.contains("C:\\\\private"));
        assert!(!serialized.contains("/home/private"));
        assert!(!serialized.contains("sourceInfo"));
        assert!(!serialized.contains("baseDir"));
    }

    #[test]
    fn command_descriptions_preserve_their_own_slash_invocation_only() {
        assert_eq!(
            sanitize_runtime_command_description(
                "Usage: /goal <objective>; config: <external-path>/home/private/goal.json \u{001b}[32mready\u{001b}[0m",
                "goal",
            )
            .as_deref(),
            Some("Usage: /goal <objective>; config: <external-path>/goal.json ready")
        );
        assert!(sanitize_runtime_command_description(&"x".repeat(1_001), "goal").is_none());
    }

    #[test]
    fn command_projection_rejects_malformed_or_oversized_catalogs() {
        assert!(map_runtime_commands(&json!({ "data": { "commands": {} } })).is_err());
        let commands = (0..513)
            .map(|index| json!({ "name": format!("command-{index}"), "source": "extension" }))
            .collect::<Vec<_>>();
        assert!(map_runtime_commands(&json!({ "data": { "commands": commands } })).is_err());
    }

    #[test]
    fn prompt_submission_carries_atomic_streaming_behavior() {
        let prompt = prompt_command("request".into(), "hello".into(), "followUp");
        assert_eq!(
            prompt.get("type").and_then(serde_json::Value::as_str),
            Some("prompt")
        );
        assert_eq!(
            prompt
                .get("streamingBehavior")
                .and_then(serde_json::Value::as_str),
            Some("followUp")
        );
    }

    #[test]
    fn shutdown_admission_blocks_normal_commands_but_preserves_the_abort_frame() {
        assert!(request_is_blocked(true, false));
        assert!(!request_is_blocked(true, true));
        let abort = abort_command("shutdown-abort".into());
        assert_eq!(abort["id"], "shutdown-abort");
        assert_eq!(abort["type"], "abort");
    }

    #[test]
    fn prime_active_session_stderr_marker_is_chunk_safe_and_path_free() {
        let marker = PRIME_SESSION_ACTIVE_STDERR_MARKERS[0];
        let mut matched = 0;
        assert!(!scan_fixed_marker(
            b"Error: Session is already ",
            marker,
            &mut matched
        ));
        assert!(scan_fixed_marker(
            b"active in private-id: C:\\private\\session.jsonl",
            marker,
            &mut matched,
        ));
        assert_eq!(
            RealRuntimeError::SessionAlreadyActive.to_string(),
            "The Prime Agent session is already active in another client"
        );
    }

    #[test]
    fn thinking_level_projection_is_finite_known_and_includes_off() {
        let levels = map_thinking_levels(&json!({
            "data": { "levels": ["off", "low", "high"] }
        }))
        .expect("maps Pi thinking levels");
        assert_eq!(levels, vec!["off", "low", "high"]);
        assert!(
            map_thinking_levels(&json!({
                "data": { "levels": ["off", "unsafe-future-level"] }
            }))
            .is_none()
        );
    }

    #[test]
    fn response_validation_rejects_malformed_or_failed_frames() {
        let success =
            json!({ "type": "response", "command": "get_state", "success": true, "data": {} });
        assert!(validate_success_response(&success, "get_state").is_ok());
        assert!(required_response_data(&success, "get_state").is_ok());

        let wrong_command = json!({ "type": "response", "command": "abort", "success": true });
        assert!(validate_success_response(&wrong_command, "get_state").is_err());

        let failed = json!({ "type": "response", "command": "get_state", "success": false });
        assert!(validate_success_response(&failed, "get_state").is_err());
        let redacted =
            redact_command_error("C:\\private\\TOKEN_SECRET", "prompt and provider secret");
        assert_eq!(redacted, "The agent runtime rejected a command.");
        assert!(!redacted.contains("private"));
        assert!(!redacted.contains("secret"));

        let missing_success = json!({ "type": "response", "command": "get_state", "data": {} });
        assert!(validate_success_response(&missing_success, "get_state").is_err());
        assert!(
            required_response_data(
                &json!({ "type": "response", "command": "get_state", "success": true }),
                "get_state"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn malformed_prime_transport_fails_closed_without_exposing_the_frame() {
        let shared = shared_for_test(RuntimeState::Ready);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let (mut writer, reader) = tokio::io::duplex(256);
        let reader_task = tokio::spawn(run_stdout_loop(
            reader,
            Arc::clone(&shared),
            event_tx,
            AgentKind::PrimeAgent,
        ));
        writer
            .write_all(b"{\"type\":\"goal_update\",\"objective\":\"TOKEN_SECRET\"\n")
            .await
            .expect("writes malformed JSONL frame");
        drop(writer);

        let joined = tokio::time::timeout(Duration::from_secs(1), reader_task)
            .await
            .expect("in-memory transport loop completes");
        assert!(joined.is_ok(), "transport loop task does not panic");
        assert_eq!(*shared.state.lock().await, RuntimeState::Failed);

        let mut events = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            events.push(event);
        }
        assert!(events.iter().any(|event| matches!(
            event,
            SurfaceEvent::RuntimeError { safe_summary }
                if safe_summary == "The agent runtime emitted a malformed RPC frame."
        )));
        let serialized = serde_json::to_string(&events).expect("serializes safe failure events");
        assert!(!serialized.contains("TOKEN_SECRET"));
    }

    #[tokio::test]
    async fn malformed_prime_response_without_an_id_fails_closed() {
        let shared = shared_for_test(RuntimeState::Ready);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let mut tracker = StreamTracker::default();
        handle_frame_for_kind(
            json!({ "type": "response", "command": "get_state", "success": true }),
            &shared,
            &event_tx,
            &mut tracker,
            AgentKind::PrimeAgent,
        )
        .await;

        assert_eq!(*shared.state.lock().await, RuntimeState::Failed);
        assert!(matches!(
            event_rx.recv().await,
            Some(SurfaceEvent::State {
                state: RuntimeState::Failed,
                safe_summary: Some(ref summary),
                ..
            }) if summary == "The Prime Agent runtime emitted an uncorrelated response."
        ));
        assert!(matches!(
            event_rx.recv().await,
            Some(SurfaceEvent::RuntimeError { ref safe_summary })
                if safe_summary == "The Prime Agent runtime emitted an uncorrelated response."
        ));
    }

    fn shared_for_test(state: RuntimeState) -> Arc<RuntimeShared> {
        Arc::new(RuntimeShared {
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            extension_ui: Mutex::new(ExtensionUiMailbox::new()),
            extension_ui_timeouts: Mutex::new(HashMap::new()),
            extension_ui_response_gate: Mutex::new(()),
            state: Mutex::new(state),
            revision: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            session_already_active: AtomicBool::new(false),
            extension_ui_ready: AtomicBool::new(true),
        })
    }

    #[tokio::test]
    async fn startup_ready_transition_never_overwrites_a_terminal_failure() {
        let shared = shared_for_test(RuntimeState::Failed);
        let (event_tx, _event_rx) = mpsc::channel(2);

        assert!(!transition_starting_to_ready(&shared, &event_tx).await);
        assert_eq!(*shared.state.lock().await, RuntimeState::Failed);
    }

    #[tokio::test]
    async fn stream_projection_finishes_text_and_thinking_blocks() {
        let shared = shared_for_test(RuntimeState::Dormant);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let mut tracker = StreamTracker::default();
        handle_frame(
            json!({ "type": "message_start", "message": { "role": "assistant", "content": [] } }),
            &shared,
            &event_tx,
            &mut tracker,
        )
        .await;
        for event in [
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start", "contentIndex": 0 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "hello" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_end", "contentIndex": 0 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 1 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 1, "delta": "reason" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_end", "contentIndex": 1 } }),
        ] {
            handle_frame(event, &shared, &event_tx, &mut tracker).await;
        }
        let mut events = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            events.push(event);
        }
        assert!(events.iter().any(|event| matches!(
            event,
            SurfaceEvent::AssistantTextDelta { block_id, delta }
                if block_id == "piui-m-1-t0" && delta == "hello"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            SurfaceEvent::ThinkingDelta { block_id, delta }
                if block_id == "piui-m-1-k1" && delta == "reason"
        )));
        let completed = events
            .iter()
            .filter(|event| matches!(event, SurfaceEvent::AssistantMessageCompleted { .. }))
            .count();
        assert_eq!(completed, 2);
    }

    #[tokio::test]
    async fn agent_end_is_not_idle_and_pending_requests_fail_at_runtime_end() {
        let shared = shared_for_test(RuntimeState::Dormant);
        let (event_tx, _event_rx) = mpsc::channel(8);
        let mut tracker = StreamTracker::default();
        handle_frame(
            json!({ "type": "agent_start" }),
            &shared,
            &event_tx,
            &mut tracker,
        )
        .await;
        assert_eq!(*shared.state.lock().await, RuntimeState::Running);
        handle_frame(
            json!({ "type": "agent_end" }),
            &shared,
            &event_tx,
            &mut tracker,
        )
        .await;
        assert_eq!(*shared.state.lock().await, RuntimeState::Running);
        handle_frame(
            json!({ "type": "agent_settled" }),
            &shared,
            &event_tx,
            &mut tracker,
        )
        .await;
        assert_eq!(*shared.state.lock().await, RuntimeState::Ready);

        let (sender, receiver) = oneshot::channel();
        shared.pending.lock().await.insert("pending".into(), sender);
        fail_pending(&shared, "The agent runtime exited unexpectedly.").await;
        assert!(matches!(
            receiver.await,
            Ok(Err(RealRuntimeError::Exited(message))) if message == "The agent runtime exited unexpectedly."
        ));
    }

    #[tokio::test]
    async fn prime_agent_end_is_the_idle_boundary_without_pi_agent_settled() {
        let shared = shared_for_test(RuntimeState::Dormant);
        let (event_tx, _event_rx) = mpsc::channel(8);
        let mut tracker = StreamTracker::default();
        handle_frame_for_kind(
            json!({ "type": "agent_start" }),
            &shared,
            &event_tx,
            &mut tracker,
            AgentKind::PrimeAgent,
        )
        .await;
        assert_eq!(*shared.state.lock().await, RuntimeState::Running);

        handle_frame_for_kind(
            json!({ "type": "agent_end" }),
            &shared,
            &event_tx,
            &mut tracker,
            AgentKind::PrimeAgent,
        )
        .await;
        assert_eq!(*shared.state.lock().await, RuntimeState::Ready);
    }

    #[tokio::test]
    async fn prime_bash_output_beyond_live_queue_capacity_does_not_block_terminal_frames() {
        let shared = shared_for_test(RuntimeState::Running);
        let (event_tx, mut event_rx) = mpsc::channel(LIVE_EVENT_CHANNEL_CAPACITY);
        let (response_tx, response_rx) = oneshot::channel();
        shared
            .pending
            .lock()
            .await
            .insert("correlated".into(), response_tx);

        let task_shared = Arc::clone(&shared);
        let mut projection_task = tokio::spawn(async move {
            let mut tracker = StreamTracker::default();
            // This is 257 chunks against the established 256-event live queue.
            for chunk in 0..=LIVE_EVENT_CHANNEL_CAPACITY {
                handle_frame_for_kind(
                    json!({
                        "type": "bash_output",
                        "runId": "private-run-id",
                        "output": format!("private output chunk {chunk}"),
                    }),
                    &task_shared,
                    &event_tx,
                    &mut tracker,
                    AgentKind::PrimeAgent,
                )
                .await;
            }
            handle_frame_for_kind(
                json!({
                    "type": "response",
                    "id": "correlated",
                    "command": "get_state",
                    "success": true,
                    "data": {},
                }),
                &task_shared,
                &event_tx,
                &mut tracker,
                AgentKind::PrimeAgent,
            )
            .await;
            handle_frame_for_kind(
                json!({ "type": "agent_end" }),
                &task_shared,
                &event_tx,
                &mut tracker,
                AgentKind::PrimeAgent,
            )
            .await;
        });

        let joined = tokio::time::timeout(Duration::from_secs(1), &mut projection_task).await;
        if joined.is_err() {
            projection_task.abort();
        }
        joined
            .expect("raw bash chunks never fill the live event queue")
            .expect("bash projection task does not panic");

        let response = tokio::time::timeout(Duration::from_secs(1), response_rx)
            .await
            .expect("correlated response is not delayed by bash chunks")
            .expect("correlated response sender remains open")
            .expect("correlated response succeeds");
        assert_eq!(response["id"], "correlated");
        let terminal = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .expect("terminal event is not delayed by bash chunks")
            .expect("event channel remains open");
        assert!(matches!(
            terminal,
            SurfaceEvent::State {
                state: RuntimeState::Ready,
                ..
            }
        ));
        assert!(
            event_rx.try_recv().is_err(),
            "raw bash output must not create fallback activity events"
        );
    }

    #[tokio::test]
    async fn prime_activity_projection_is_typed_and_unknown_events_drop_raw_payloads() {
        let child = prime_event_activity(
            "rlm_child_update",
            &json!({
                "child": {
                    "id": "private-daemon-child-id",
                    "label": "Review C:\\private\\adapter and rotate TOKEN_SECRET",
                    "sessionName": "Review-C-private-adapter-TOKEN_SECRET",
                    "status": "running",
                    "model": "review-model",
                    "activity": { "kind": "executing", "toolName": "read" },
                    "tokenCount": 42,
                    "prompt": "DO NOT EXPOSE THE CHILD PROMPT"
                },
                "authToken": "SECRET"
            }),
        )
        .expect("projects known Prime child activity");
        let child_json = serde_json::to_value(&child).expect("serializes child activity");
        assert_eq!(child_json["type"], "rlmChild");
        assert_eq!(child_json["status"], "running");
        assert_eq!(child_json["label"], "Subagent");
        assert!(child_json.get("name").is_none());
        assert_eq!(child_json["toolName"], "read");
        assert_eq!(child_json["tokenCount"], 42);
        assert!(child_json.get("tool_name").is_none());
        assert!(child_json.get("token_count").is_none());
        assert!(
            child_json["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("piui-prime-child-"))
        );
        let serialized_child = child_json.to_string();
        assert!(!serialized_child.contains("private-daemon-child-id"));
        assert!(!serialized_child.contains("DO NOT EXPOSE"));
        assert!(!serialized_child.contains("private"));
        assert!(!serialized_child.contains("TOKEN_SECRET"));
        assert!(!serialized_child.contains("SECRET"));

        let recap = prime_event_activity(
            "recap_update",
            &json!({ "recap": "Full recap with TOKEN_SECRET and C:\\private\\path" }),
        )
        .expect("projects recap status");
        let recap_json = serde_json::to_value(recap).expect("serializes recap status");
        assert_eq!(recap_json["type"], "recap");
        assert!(recap_json.get("summary").is_none());
        assert!(!recap_json.to_string().contains("TOKEN_SECRET"));

        let shared = shared_for_test(RuntimeState::Ready);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        let mut tracker = StreamTracker::default();
        handle_frame_for_kind(
            json!({
                "type": "future_prime_event",
                "prompt": "RAW FUTURE PROMPT",
                "cwd": "C:\\private\\project",
                "environment": { "TOKEN": "SECRET" }
            }),
            &shared,
            &event_tx,
            &mut tracker,
            AgentKind::PrimeAgent,
        )
        .await;
        let unknown = event_rx
            .recv()
            .await
            .expect("emits generic unknown activity");
        let unknown_json = serde_json::to_value(unknown).expect("serializes unknown activity");
        assert_eq!(unknown_json["kind"], "primeActivity");
        assert_eq!(unknown_json["activity"]["type"], "unknown");
        assert_eq!(unknown_json["activity"]["wireType"], "future_prime_event");
        let serialized_unknown = unknown_json.to_string();
        assert!(!serialized_unknown.contains("RAW FUTURE PROMPT"));
        assert!(!serialized_unknown.contains("private"));
        assert!(!serialized_unknown.contains("SECRET"));
    }

    #[tokio::test]
    async fn malformed_prime_activity_events_use_payload_free_fallbacks() {
        let cases = [
            (
                "rlm_child_update",
                json!({
                    "type": "rlm_child_update",
                    "child": {
                        "id": 42,
                        "prompt": "TOKEN_SECRET",
                        "sessionName": "C:\\private\\child"
                    }
                }),
            ),
            (
                "goal_update",
                json!({
                    "type": "goal_update",
                    "objective": "TOKEN_SECRET",
                    "path": "C:\\private\\goal.jsonl"
                }),
            ),
            (
                "session_action_update",
                json!({
                    "type": "session_action_update",
                    "actions": "TOKEN_SECRET"
                }),
            ),
            (
                "malformed-event",
                json!({
                    "type": { "private": "TOKEN_SECRET" },
                    "payload": "C:\\private\\event"
                }),
            ),
        ];

        for (wire_type, frame) in cases {
            let shared = shared_for_test(RuntimeState::Ready);
            let (event_tx, mut event_rx) = mpsc::channel(4);
            let mut tracker = StreamTracker::default();
            handle_frame_for_kind(
                frame,
                &shared,
                &event_tx,
                &mut tracker,
                AgentKind::PrimeAgent,
            )
            .await;

            let event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .expect("malformed Prime event is surfaced")
                .expect("Prime event channel stays open");
            let payload = serde_json::to_value(event).expect("serializes safe fallback");
            assert_eq!(payload["kind"], "primeActivity");
            assert_eq!(payload["activity"]["type"], "unknown");
            assert_eq!(payload["activity"]["wireType"], wire_type);
            let serialized = payload.to_string();
            assert!(!serialized.contains("TOKEN_SECRET"));
            assert!(!serialized.contains("private"));
        }
    }

    #[test]
    fn prime_state_heartbeat_and_schedule_snapshots_are_bounded_typed_projections() {
        let state = prime_state_activities(&json!({
            "data": {
                "goal": {
                    "goalId": "private-goal-id",
                    "status": "active",
                    "objective": "Ship the adapter",
                    "tokensUsed": 10,
                    "tokenBudget": 100,
                    "timeUsedSeconds": 5,
                    "continuationsUsed": 1,
                    "rawPrompt": "SECRET"
                },
                "sessionActions": { "active": { "private": true }, "queuedCount": 2 }
            }
        }));
        assert_eq!(state.len(), 2);
        assert!(matches!(state[0], PrimeActivity::Goal { ref status, .. } if status == "active"));
        assert!(matches!(
            state[1],
            PrimeActivity::SessionActions {
                active_count: 1,
                queued_count: 2,
                ..
            }
        ));

        let heartbeat = prime_heartbeat_activity(&json!({
            "data": {
                "heartbeat": {
                    "id": "private-heartbeat-id",
                    "status": "active",
                    "deliveryMode": "follow_up",
                    "schedule": { "kind": "interval", "expression": "15m", "private": "SECRET" }
                }
            }
        }))
        .expect("projects heartbeat");
        assert!(
            matches!(heartbeat, PrimeActivity::Heartbeat { ref status, ref delivery_mode, .. }
            if status == "active" && delivery_mode.as_deref() == Some("follow_up"))
        );

        let schedules = prime_schedule_activities(&json!({
            "data": {
                "jobs": [{
                    "id": "private-schedule-id",
                    "status": "paused",
                    "source": "cron",
                    "schedule": { "kind": "cron", "expression": "0 9 * * *", "payload": "SECRET" }
                }]
            }
        }));
        assert_eq!(schedules.len(), 1);
        let serialized = serde_json::to_string(&(state, heartbeat, schedules))
            .expect("serializes typed Prime snapshots");
        assert!(!serialized.contains("private-goal-id"));
        assert!(!serialized.contains("private-heartbeat-id"));
        assert!(!serialized.contains("private-schedule-id"));
        assert!(!serialized.contains("SECRET"));
    }

    #[test]
    fn prime_schedule_projection_caps_untrusted_snapshot_input_at_live_queue_capacity() {
        let jobs = (0..=MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS)
            .map(|index| {
                json!({
                    "id": format!("private-schedule-{index}"),
                    "status": "active",
                    "source": "cron",
                    "schedule": {
                        "kind": "interval",
                        "expression": format!("{index}m"),
                    },
                })
            })
            .collect::<Vec<_>>();
        let schedules = prime_schedule_activities(&json!({ "data": { "jobs": jobs } }));

        assert_eq!(schedules.len(), MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS);
        let serialized = serde_json::to_string(&schedules).expect("serializes bounded schedules");
        assert!(serialized.contains(&format!(
            "interval: {}m",
            MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS - 1
        )));
        assert!(!serialized.contains(&format!("interval: {}m", MAX_PRIME_ACTIVITY_SNAPSHOT_ITEMS)));
    }

    #[test]
    fn runtime_events_have_an_explicit_v10_kind_and_scope_envelope() {
        let payload = serde_json::to_value(RuntimeEventEnvelope::new(
            "runtime".into(),
            Some("project".into()),
            Some("session".into()),
            SurfaceEvent::ModelsAvailable { models: Vec::new() },
        ))
        .expect("serializes event envelope");
        assert_eq!(
            payload.get("protocol").and_then(serde_json::Value::as_u64),
            Some(u64::from(LOCAL_RUNTIME_EVENT_PROTOCOL))
        );
        assert_eq!(
            payload.get("runtimeId").and_then(serde_json::Value::as_str),
            Some("runtime")
        );
        assert_eq!(
            payload.get("agentKind").and_then(serde_json::Value::as_str),
            Some("pi")
        );
        assert_eq!(
            payload.get("scope").and_then(serde_json::Value::as_str),
            Some("project")
        );
        assert_eq!(
            payload.get("projectId").and_then(serde_json::Value::as_str),
            Some("project")
        );
        assert_eq!(
            payload.get("kind").and_then(serde_json::Value::as_str),
            Some("modelsAvailable")
        );
        let personal = serde_json::to_value(RuntimeEventEnvelope::new(
            "runtime".into(),
            None,
            None,
            SurfaceEvent::ModelsAvailable { models: Vec::new() },
        ))
        .expect("serializes personal event envelope");
        assert_eq!(
            personal.get("scope").and_then(serde_json::Value::as_str),
            Some("personal")
        );
        assert!(personal.get("projectId").is_none());
        assert_eq!(
            personal
                .get("agentKind")
                .and_then(serde_json::Value::as_str),
            Some("pi")
        );
        let prime = serde_json::to_value(RuntimeEventEnvelope::new_for_kind(
            "prime-runtime".into(),
            AgentKind::PrimeAgent,
            Some("prime-project".into()),
            None,
            SurfaceEvent::PrimeActivity {
                activity: PrimeActivity::SessionActions {
                    id: "opaque".into(),
                    active_count: 1,
                    queued_count: 2,
                },
            },
        ))
        .expect("serializes Prime event envelope");
        assert_eq!(
            prime.get("agentKind").and_then(serde_json::Value::as_str),
            Some("prime-agent")
        );
        assert_eq!(
            prime.get("kind").and_then(serde_json::Value::as_str),
            Some("primeActivity")
        );
        let rejected_pi_activity = serde_json::to_value(RuntimeEventEnvelope::new_for_kind(
            "pi-runtime".into(),
            AgentKind::Pi,
            Some("pi-project".into()),
            None,
            SurfaceEvent::PrimeActivity {
                activity: PrimeActivity::SessionActions {
                    id: "opaque".into(),
                    active_count: 0,
                    queued_count: 0,
                },
            },
        ))
        .expect("serializes rejected cross-kind activity safely");
        assert_eq!(rejected_pi_activity["kind"], "runtimeError");
        assert!(rejected_pi_activity.get("activity").is_none());
    }

    fn configured_live_prime_session_root() -> std::path::PathBuf {
        let primary = std::env::var_os("PRIME_AGENT_SESSION_DIR")
            .map(std::path::PathBuf::from)
            .expect("requires an explicit isolated PRIME_AGENT_SESSION_DIR");
        let legacy = std::env::var_os("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
            .map(std::path::PathBuf::from)
            .expect("requires an explicit isolated PRIME_AGENT_CODING_AGENT_SESSION_DIR");
        let primary =
            fs::canonicalize(primary).expect("requires an existing isolated Prime session root");
        let legacy = fs::canonicalize(legacy)
            .expect("requires an existing isolated legacy Prime session root");
        assert!(
            primary == legacy,
            "both Prime session-root environment variables must name the same isolated directory"
        );
        primary
    }

    fn configured_live_prime_daemon_socket() -> std::ffi::OsString {
        let socket = std::env::var_os("PIUI_PRIME_AGENT_DAEMON_SOCKET")
            .expect("requires an explicit isolated PIUI_PRIME_AGENT_DAEMON_SOCKET");
        let rendered = socket.to_string_lossy();
        #[cfg(windows)]
        assert!(
            rendered.starts_with(r"\\.\pipe\piui-")
                && rendered.as_ref() != r"\\.\pipe\prime-agent-daemon",
            "the live Prime test socket must be a non-default PiUI named pipe"
        );
        #[cfg(not(windows))]
        assert!(
            std::path::Path::new(socket.as_os_str()).is_absolute()
                && std::path::Path::new(socket.as_os_str())
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("piui-")),
            "the live Prime test socket must be an absolute non-default PiUI socket path"
        );
        socket
    }

    fn prime_session_files(session_root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        collect_jsonl_files(session_root, &mut files)
            .expect("reads the isolated Prime session root");
        files.sort();
        files
    }

    fn added_prime_session_files(
        session_root: &std::path::Path,
        before: &[std::path::PathBuf],
    ) -> Vec<std::path::PathBuf> {
        prime_session_files(session_root)
            .into_iter()
            .filter(|candidate| !before.contains(candidate))
            .collect()
    }

    fn prime_session_header_id(path: &std::path::Path) -> String {
        let bytes = fs::read(path).expect("reads the isolated Prime root source");
        let newline = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("Prime root source has an LF-terminated header");
        let mut record = &bytes[..newline];
        if record.last() == Some(&b'\r') {
            record = &record[..record.len() - 1];
        }
        let header: serde_json::Value =
            serde_json::from_slice(record).expect("Prime root source has a JSON header");
        assert_eq!(
            header.get("type").and_then(serde_json::Value::as_str),
            Some("session")
        );
        header
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .expect("Prime root header has a native session id")
    }

    fn live_prime_workspace(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-live-prime-{label}-{}-{serial}",
            std::process::id()
        ));
        let project = root.join("project");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project).expect("creates an isolated Prime project workspace");
        let cwd = fs::canonicalize(project).expect("canonicalizes the isolated Prime workspace");
        (root, cwd)
    }

    /// Dynamic Prime 0.8.1 evidence. Each fresh launch performs only the
    /// adapter's `get_state` handshake; it does not submit a provider prompt.
    #[tokio::test]
    #[ignore = "requires prime-agent 0.8.1, isolated Prime session roots, and PIUI_PRIME_AGENT_DAEMON_SOCKET"]
    async fn live_prime_new_and_resumed_sessions_add_only_the_expected_sources() {
        let _live_guard = LIVE_PRIME_TEST_LOCK.lock().await;
        let session_root = configured_live_prime_session_root();
        let initial_files = prime_session_files(&session_root);
        let (workspace_root, cwd) = live_prime_workspace("new-resume");

        let first_spawn = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd: cwd.clone(),
                    session_path: None,
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (first_runtime, mut first_events, _runtime_id, first_state, _revision) = first_spawn
            .expect("first Prime startup stays within its adapter bounds")
            .expect("starts a fresh Prime root session");
        let first_session_id = first_state.session_id.clone();
        let initial_goal = tokio::time::timeout(COMMAND_TIMEOUT, async {
            while let Some(event) = first_events.recv().await {
                if let SurfaceEvent::PrimeActivity {
                    activity:
                        PrimeActivity::Goal {
                            status, objective, ..
                        },
                } = event
                {
                    return Some((status, objective));
                }
            }
            None
        })
        .await;
        let first_stop =
            tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, first_runtime.stop()).await;
        let first_stop_state = first_runtime.state().await;
        drop(first_events);
        drop(first_runtime);
        let after_first = prime_session_files(&session_root);
        let first_created = added_prime_session_files(&session_root, &initial_files);

        assert!(
            matches!(first_stop, Ok(Ok(()))),
            "fresh Prime session stops cleanly"
        );
        assert!(
            first_stop_state == RuntimeState::Dormant,
            "fresh Prime runtime reaches Dormant after stop"
        );
        assert!(
            !first_session_id.is_empty(),
            "fresh Prime runtime returns a session identity"
        );
        assert!(
            matches!(initial_goal, Ok(Some((ref status, _))) if status == "idle"),
            "initial Prime get_state goal reaches the typed activity surface"
        );
        assert!(
            first_created.len() == 1,
            "one fresh Prime launch adds exactly one root session source"
        );
        assert_eq!(
            prime_session_header_id(&first_created[0]),
            first_session_id,
            "the Prime handshake id exactly matches its root JSONL header id"
        );
        let selected_session = first_created
            .into_iter()
            .next()
            .expect("the one fresh Prime session source is present");

        let resumed_spawn = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd: cwd.clone(),
                    session_path: Some(selected_session),
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (resumed_runtime, resumed_events, _runtime_id, resumed_state, _revision) =
            resumed_spawn
                .expect("resumed Prime startup stays within its adapter bounds")
                .expect("resumes the selected Prime root session");
        let resumed_stop =
            tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, resumed_runtime.stop()).await;
        let resumed_stop_state = resumed_runtime.state().await;
        drop(resumed_events);
        drop(resumed_runtime);
        let after_resume = prime_session_files(&session_root);

        let second_spawn = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd,
                    session_path: None,
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (second_runtime, second_events, _runtime_id, second_state, _revision) = second_spawn
            .expect("second Prime startup stays within its adapter bounds")
            .expect("starts a second fresh Prime root session");
        let second_stop =
            tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, second_runtime.stop()).await;
        let second_stop_state = second_runtime.state().await;
        drop(second_events);
        drop(second_runtime);
        let second_created = added_prime_session_files(&session_root, &after_resume);
        let workspace_cleanup = fs::remove_dir_all(&workspace_root);

        assert!(
            matches!(resumed_stop, Ok(Ok(()))),
            "resumed Prime session stops cleanly"
        );
        assert!(
            resumed_stop_state == RuntimeState::Dormant,
            "resumed Prime runtime reaches Dormant after stop"
        );
        assert!(
            resumed_state.session_id == first_session_id,
            "resume preserves the selected Prime session identity"
        );
        assert!(
            after_resume == after_first,
            "resuming a Prime session does not create a ghost source"
        );
        assert!(
            matches!(second_stop, Ok(Ok(()))),
            "second Prime session stops cleanly"
        );
        assert!(
            second_stop_state == RuntimeState::Dormant,
            "second Prime runtime reaches Dormant after stop"
        );
        assert!(
            !second_state.session_id.is_empty() && second_state.session_id != first_session_id,
            "two new Prime launches in one project receive distinct session identities"
        );
        assert!(
            second_created.len() == 1,
            "the second fresh Prime launch adds exactly one further root source"
        );
        assert_eq!(
            prime_session_header_id(&second_created[0]),
            second_state.session_id,
            "the second Prime handshake id matches only its new root header"
        );
        assert!(
            workspace_cleanup.is_ok(),
            "removes the isolated Prime workspace"
        );
    }

    /// Dynamic lease evidence. The contender resumes the exact same source as
    /// the owner; a separate fresh session is intentionally not treated as a
    /// project-wide conflict.
    #[tokio::test]
    #[ignore = "requires prime-agent 0.8.1, isolated Prime session roots, and PIUI_PRIME_AGENT_DAEMON_SOCKET"]
    async fn live_prime_same_session_lease_is_reported_without_creating_a_ghost() {
        let _live_guard = LIVE_PRIME_TEST_LOCK.lock().await;
        let session_root = configured_live_prime_session_root();
        let initial_files = prime_session_files(&session_root);
        let (workspace_root, cwd) = live_prime_workspace("lease");

        let seed_spawn = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd: cwd.clone(),
                    session_path: None,
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (seed_runtime, seed_events, _runtime_id, _seed_state, _revision) = seed_spawn
            .expect("seed Prime startup stays within its adapter bounds")
            .expect("starts a seed Prime session");
        let seed_stop =
            tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, seed_runtime.stop()).await;
        drop(seed_events);
        drop(seed_runtime);
        let seeded = added_prime_session_files(&session_root, &initial_files);

        assert!(
            matches!(seed_stop, Ok(Ok(()))),
            "seed Prime session stops cleanly"
        );
        assert!(
            seeded.len() == 1,
            "the seed launch creates exactly one selected session source"
        );
        let selected_session = seeded
            .into_iter()
            .next()
            .expect("the selected seed session source is present");
        let after_seed = prime_session_files(&session_root);

        let owner_spawn = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd: cwd.clone(),
                    session_path: Some(selected_session.clone()),
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (owner_runtime, owner_events, _runtime_id, _owner_state, _revision) = owner_spawn
            .expect("owner Prime startup stays within its adapter bounds")
            .expect("opens the selected Prime session as its owner");

        let contender = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd,
                    session_path: Some(selected_session),
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let owner_stop =
            tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, owner_runtime.stop()).await;
        let owner_stop_state = owner_runtime.state().await;
        drop(owner_events);
        drop(owner_runtime);
        let after_contender = prime_session_files(&session_root);
        let workspace_cleanup = fs::remove_dir_all(&workspace_root);

        assert!(
            matches!(contender, Ok(Err(RealRuntimeError::SessionAlreadyActive))),
            "only the active selected Prime session returns the typed lease conflict"
        );
        assert!(
            matches!(owner_stop, Ok(Ok(()))),
            "owner Prime session stops cleanly"
        );
        assert!(
            owner_stop_state == RuntimeState::Dormant,
            "owner Prime runtime reaches Dormant after stop"
        );
        assert!(
            after_contender == after_seed,
            "same-session lease rejection does not create a ghost source"
        );
        assert!(
            workspace_cleanup.is_ok(),
            "removes the isolated Prime workspace"
        );
    }

    /// This exercises a real Prime `goal_update` after the initial `get_state`
    /// goal projection. `/goal` starts a continuation, so it is deliberately
    /// separate from the no-provider session/lease probes above.
    #[tokio::test]
    #[ignore = "requires prime-agent 0.8.1, a configured model, isolated session roots, and PIUI_PRIME_AGENT_DAEMON_SOCKET"]
    async fn live_prime_initial_and_goal_update_activity_are_projected_then_stopped() {
        let _live_guard = LIVE_PRIME_TEST_LOCK.lock().await;
        let _session_root = configured_live_prime_session_root();
        let (workspace_root, cwd) = live_prime_workspace("activity");
        let spawned = tokio::time::timeout(
            LIVE_PRIME_OPERATION_TIMEOUT,
            RealPiRuntime::spawn_prime_on_isolated_daemon(
                RealPiConfig {
                    cwd,
                    session_path: None,
                    session_name: None,
                },
                configured_live_prime_daemon_socket(),
            ),
        )
        .await;
        let (runtime, mut events, _runtime_id, _state, _revision) = spawned
            .expect("Prime activity startup stays within its adapter bounds")
            .expect("starts a Prime activity probe session");

        let initial_goal = tokio::time::timeout(COMMAND_TIMEOUT, async {
            while let Some(event) = events.recv().await {
                if let SurfaceEvent::PrimeActivity {
                    activity:
                        PrimeActivity::Goal {
                            status, objective, ..
                        },
                } = event
                {
                    return Some((status, objective));
                }
            }
            None
        })
        .await;
        let goal_prompt = if matches!(&initial_goal, Ok(Some(_))) {
            Some(
                tokio::time::timeout(
                    LIVE_PRIME_OPERATION_TIMEOUT,
                    runtime.send_prompt("/goal PiUI live activity probe".into()),
                )
                .await,
            )
        } else {
            None
        };
        let live_goal = if matches!(&goal_prompt, Some(Ok(Ok(())))) {
            Some(
                tokio::time::timeout(COMMAND_TIMEOUT, async {
                    while let Some(event) = events.recv().await {
                        if let SurfaceEvent::PrimeActivity {
                            activity:
                                PrimeActivity::Goal {
                                    status, objective, ..
                                },
                        } = event
                        {
                            if status == "active" {
                                return Some((status, objective));
                            }
                        }
                    }
                    None
                })
                .await,
            )
        } else {
            None
        };
        let stop = tokio::time::timeout(LIVE_PRIME_OPERATION_TIMEOUT, runtime.stop()).await;
        let stop_state = runtime.state().await;
        drop(events);
        drop(runtime);
        let workspace_cleanup = fs::remove_dir_all(&workspace_root);

        assert!(
            matches!(initial_goal, Ok(Some(_))),
            "initial Prime get_state goal reaches the activity surface"
        );
        assert!(
            matches!(goal_prompt, Some(Ok(Ok(())))),
            "the built-in Prime goal command is accepted"
        );
        assert!(
            matches!(
                live_goal,
                Some(Ok(Some((ref status, Some(ref objective)))))
                    if status == "active" && objective == "PiUI live activity probe"
            ),
            "live Prime goal_update reaches the typed activity surface"
        );
        assert!(
            matches!(stop, Ok(Ok(()))),
            "Prime activity probe stops cleanly"
        );
        assert!(
            stop_state == RuntimeState::Dormant,
            "Prime activity runtime reaches Dormant after stop"
        );
        assert!(
            workspace_cleanup.is_ok(),
            "removes the isolated Prime workspace"
        );
    }

    /// Manual integration evidence only. It opens a synthetic, explicit
    /// session with the locally installed Pi CLI, completes the `get_state`
    /// handshake through this adapter, and shuts down through stdin EOF.
    #[tokio::test]
    #[ignore = "requires a locally installed Pi CLI"]
    async fn live_pi_existing_session_handshake() {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-live-rpc-test-{}-{serial}",
            std::process::id()
        ));
        let project = root.join("project");
        let session = root.join("existing.jsonl");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&project).expect("creates project");
        let cwd = fs::canonicalize(&project).expect("canonical project");
        let source = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"019f946f-ba47-7e1d-97a2-3ec3934eef48\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":{}}}\n",
            serde_json::to_string(&cwd.to_string_lossy().to_string()).expect("encodes cwd")
        );
        fs::write(&session, &source).expect("writes synthetic session");

        let result = RealPiRuntime::spawn(RealPiConfig {
            cwd: project,
            session_path: Some(session.clone()),
            session_name: None,
        })
        .await;
        let (runtime, events, _runtime_id, state, _revision) = result.expect("starts Pi RPC");
        assert_eq!(state.session_id, "019f946f-ba47-7e1d-97a2-3ec3934eef48");
        let thinking_levels = runtime
            .get_thinking_levels()
            .await
            .expect("gets Pi thinking levels");
        assert!(thinking_levels.iter().all(|level| matches!(
            level.as_str(),
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )));
        drop(events);
        runtime.stop().await.expect("stops Pi RPC");
        drop(runtime);

        let persisted = fs::read_to_string(&session).expect("keeps session source");
        assert!(persisted.starts_with("{\"type\":\"session\""));
        let _ = fs::remove_dir_all(root);
    }

    /// Manual integration evidence for the documented RPC Extension UI
    /// protocol. The fixture is project-local and synthetic; no provider call,
    /// user prompt content, or authoritative session mutation is involved.
    #[tokio::test]
    #[ignore = "requires a locally installed Pi CLI"]
    async fn live_pi_extension_ui_dialog_sequence_round_trips() {
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-live-extension-ui-test-{}-{serial}",
            std::process::id()
        ));
        let extensions = root.join(".pi").join("extensions");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&extensions).expect("creates isolated extension directory");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../spikes/rpc/fixtures/rpc_ui_fixture.ts");
        fs::copy(&fixture, extensions.join("rpc-ui-fixture.ts"))
            .expect("copies synthetic extension fixture");
        let cwd = fs::canonicalize(&root).expect("canonical fixture workspace");

        let (runtime, mut events, _runtime_id, _state, _revision) =
            RealPiRuntime::spawn(RealPiConfig {
                cwd,
                session_path: None,
                session_name: Some("PiUI synthetic extension UI probe".into()),
            })
            .await
            .expect("starts Pi with the synthetic fixture");
        assert!(
            runtime
                .get_commands()
                .await
                .expect("lists commands")
                .iter()
                .any(|command| command.name == "piui-rpc-ui-fixture")
        );

        let flow = tokio::time::timeout(Duration::from_secs(20), async {
            let prompt = runtime.send_prompt("/piui-rpc-ui-fixture".into());
            tokio::pin!(prompt);
            let mut prompt_complete = false;
            let mut fixture_complete = false;
            while !prompt_complete || !fixture_complete {
                tokio::select! {
                    result = &mut prompt, if !prompt_complete => {
                        result.expect("extension command completes");
                        prompt_complete = true;
                    }
                    event = events.recv() => {
                        let event = event.expect("runtime event channel stays open");
                        let SurfaceEvent::ExtensionUi { action } = event else {
                            continue;
                        };
                        match action {
                            ExtensionUiAction::Dialog {
                                request: ExtensionDialogRequest::Select { id, options, .. },
                            } => {
                                let option_id = options.first().expect("select option").id.clone();
                                runtime.respond_extension_ui(
                                    id,
                                    ExtensionUiResponse::Selected { option_id },
                                ).await.expect("responds to select");
                            }
                            ExtensionUiAction::Dialog {
                                request: ExtensionDialogRequest::Confirm { id, .. },
                            } => runtime.respond_extension_ui(
                                id,
                                ExtensionUiResponse::Confirmed { value: true },
                            ).await.expect("responds to confirm"),
                            ExtensionUiAction::Dialog {
                                request: ExtensionDialogRequest::Input { id, .. },
                            } => runtime.respond_extension_ui(
                                id,
                                ExtensionUiResponse::Submitted { value: "synthetic value".into() },
                            ).await.expect("responds to input"),
                            ExtensionUiAction::Dialog {
                                request: ExtensionDialogRequest::Editor { id, .. },
                            } => runtime.respond_extension_ui(
                                id,
                                ExtensionUiResponse::Submitted { value: "synthetic\ntext".into() },
                            ).await.expect("responds to editor"),
                            ExtensionUiAction::Notify { message, .. }
                                if message == "Synthetic fixture completed" => {
                                    fixture_complete = true;
                                }
                            _ => {}
                        }
                    }
                }
            }
        })
        .await;

        assert!(flow.is_ok(), "synthetic dialog sequence timed out");

        let stop_flow = tokio::time::timeout(Duration::from_secs(20), async {
            let prompt = runtime.send_prompt("/piui-rpc-ui-fixture".into());
            tokio::pin!(prompt);
            loop {
                tokio::select! {
                    result = &mut prompt => panic!("untimed dialog completed before stop: {result:?}"),
                    event = events.recv() => {
                        let event = event.expect("runtime event channel stays open");
                        if matches!(
                            event,
                            SurfaceEvent::ExtensionUi {
                                action: ExtensionUiAction::Dialog { .. }
                            }
                        ) {
                            runtime.stop().await.expect("preemptively stops pending dialog");
                            assert!(prompt.await.is_err());
                            break;
                        }
                    }
                }
            }
        })
        .await;
        assert!(stop_flow.is_ok(), "pending dialog prevented runtime stop");
        drop(runtime);
        let _ = fs::remove_dir_all(&root);
    }

    /// Manual integration evidence for the projectless-chat backing workspace.
    /// The caller supplies an empty `PI_CODING_AGENT_SESSION_DIR` so this test
    /// never writes into a user's normal Pi history. Pi deliberately keeps a
    /// new session in memory until its first assistant response; PiUI must not
    /// manufacture a JSONL file merely to make an empty chat appear persisted.
    #[tokio::test]
    #[ignore = "requires a locally installed Pi CLI and an isolated PI_CODING_AGENT_SESSION_DIR"]
    async fn live_pi_new_session_is_in_memory_until_first_assistant() {
        let session_root = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
            .map(std::path::PathBuf::from)
            .expect("requires PI_CODING_AGENT_SESSION_DIR");
        let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "piui-live-rpc-new-session-test-{}-{serial}",
            std::process::id()
        ));
        let workspace = root.join("neutral-workspace");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&workspace).expect("creates neutral workspace");
        fs::create_dir_all(&session_root).expect("creates isolated session root");
        let cwd = fs::canonicalize(&workspace).expect("canonical workspace");

        let (runtime, events, _runtime_id, state, _revision) = RealPiRuntime::spawn(RealPiConfig {
            cwd: workspace,
            session_path: None,
            session_name: None,
        })
        .await
        .expect("starts a new Pi RPC session");
        assert!(!state.session_id.is_empty());
        drop(events);
        runtime.stop().await.expect("stops Pi RPC");
        drop(runtime);

        let mut session_files = Vec::new();
        collect_jsonl_files(&session_root, &mut session_files).expect("reads isolated Pi sessions");
        assert!(
            session_files.is_empty(),
            "Pi keeps an empty new session in memory until its first assistant response"
        );
        assert!(cwd.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    fn collect_jsonl_files(
        directory: &std::path::Path,
        files: &mut Vec<std::path::PathBuf>,
    ) -> std::io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                collect_jsonl_files(&path, files)?;
            } else if metadata.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
            {
                files.push(path);
            }
        }
        Ok(())
    }
}
