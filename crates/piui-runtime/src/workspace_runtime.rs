//! Host-private supervisor for the native multi-harness Node bridge.
//!
//! Native session references and paths in this module must be mapped to opaque
//! workspace ids before any WebView IPC. The bridge owns no model or tool loop.

use crate::codec::{RpcCodec, RpcCodecConfig};
use crate::real_rpc::resolve_pi_launch;
#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
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
const EVENT_CHANNEL_CAPACITY: usize = 256;

const RUNNER_SOURCE: &str = include_str!("../bridge/runner.mjs");
const PI_SOURCE: &str = include_str!("../bridge/pi.mjs");
const PRIME_SOURCE: &str = include_str!("../bridge/prime.mjs");
const CODEX_SOURCE: &str = include_str!("../bridge/codex.mjs");

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
}

impl HarnessKind {
    const fn display_name(self) -> &'static str {
        match self {
            Self::Pi => "Pi",
            Self::PrimeAgent => "Prime Agent",
            Self::Codex => "Codex",
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSnapshot {
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
    Spawn {
        step_id: String,
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
    pub permission_mode: PermissionMode,
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
    UnsupportedPolicy,
    InvalidRequest,
    InvalidResponse,
    StaleApproval,
    RuntimeUnavailable,
    NativeCommandRejected,
    AlreadyInitialized,
    NotInitialized,
    NotRunning,
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeFrame {
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

struct RuntimeShared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, NativeRuntimeError>>>>,
    timed_out: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    accepting: AtomicBool,
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
    shared: Arc<RuntimeShared>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr: Mutex<Option<tokio::task::JoinHandle<()>>>,
    containment: Arc<RuntimeContainment>,
}

impl NativeRuntime {
    pub async fn spawn(
        config: NativeRuntimeConfig,
    ) -> Result<(Self, mpsc::Receiver<NativeEvent>), NativeRuntimeError> {
        let config = resolve_native_runtime_config(config)?;
        validate_config(&config)?;
        let node = resolve_node()?;
        let launch = resolve_harness_launch_for_config(&config)?;
        let source = bridge_source(config.harness)?;
        Self::spawn_resolved(config, node, launch, source).await
    }

    async fn spawn_resolved(
        config: NativeRuntimeConfig,
        node: PathBuf,
        launch: ResolvedHarnessLaunch,
        source: Vec<u8>,
    ) -> Result<(Self, mpsc::Receiver<NativeEvent>), NativeRuntimeError> {
        let source_len =
            u32::try_from(source.len()).map_err(|_| NativeRuntimeError::BridgeSourceTooLarge)?;
        #[cfg(windows)]
        let mut windows_job = WindowsJob::new().map_err(|_| NativeRuntimeError::Containment)?;

        let mut standard = std::process::Command::new(node);
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
        let mut command = Command::from(standard);
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
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: AtomicBool::new(true),
            shutting_down: AtomicBool::new(false),
        });
        let containment = Arc::new(RuntimeContainment {
            #[cfg(unix)]
            unix_group: StdMutex::new(Some(unix_group)),
            #[cfg(windows)]
            windows_job: StdMutex::new(Some(windows_job)),
        });
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
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
        };
        if let Err(error) = runtime
            .request("initialize", json!(initialize), REQUEST_TIMEOUT, false)
            .await
        {
            let _ = runtime.terminate().await;
            return Err(error);
        }
        Ok((runtime, event_rx))
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

    pub async fn interrupt(&self) -> Result<(), NativeRuntimeError> {
        self.request("interrupt", json!({}), INTERRUPT_TIMEOUT, false)
            .await
            .map(|_| ())
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
    ) -> Result<(), NativeRuntimeError> {
        self.request(
            "setModel",
            json!({ "model": model, "thinkingLevel": thinking_level }),
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
    /// while a full sink or a closed sink during active operation remains fatal.
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
        let _ = self.terminate_containment();
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
        let _ = events.try_send(NativeEvent::Status {
            status: SessionStatus::Failed,
        });
        let _ = events.try_send(NativeEvent::Error {
            message: if failed {
                "The native bridge protocol failed."
            } else {
                "The native runtime exited unexpectedly."
            }
            .into(),
        });
        *shared.stdin.lock().await = None;
        if let Some(containment) = containment {
            let _ = containment.terminate();
        }
    }
}

async fn route_bridge_frame(
    value: Value,
    shared: &Arc<RuntimeShared>,
    events: &mpsc::Sender<NativeEvent>,
) -> Result<(), NativeRuntimeError> {
    let frame: BridgeFrame =
        serde_json::from_value(value).map_err(|_| NativeRuntimeError::Protocol)?;
    match (frame.id, frame.ok, frame.event) {
        (None, None, Some(event)) => match events.try_send(event) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(_))
                if !shared.accepting.load(Ordering::Acquire) =>
            {
                Ok(())
            }
            Err(_) => Err(NativeRuntimeError::Protocol),
        },
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
        "unsupported-policy" => BridgeFailureCode::UnsupportedPolicy,
        "invalid-request" => BridgeFailureCode::InvalidRequest,
        "invalid-response" => BridgeFailureCode::InvalidResponse,
        "stale-approval" => BridgeFailureCode::StaleApproval,
        "runtime-unavailable" => BridgeFailureCode::RuntimeUnavailable,
        "native-command-rejected" => BridgeFailureCode::NativeCommandRejected,
        "already-initialized" => BridgeFailureCode::AlreadyInitialized,
        "not-initialized" => BridgeFailureCode::NotInitialized,
        "not-running" => BridgeFailureCode::NotRunning,
        _ => BridgeFailureCode::OperationFailed,
    }
}

/// Resolves native package/auth-resource locations from installed package
/// metadata and the native runtime's documented directory convention. This is
/// host-only, offline, and never reads credentials.
pub fn resolve_native_runtime_config(
    mut config: NativeRuntimeConfig,
) -> Result<NativeRuntimeConfig, NativeRuntimeError> {
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
    if let Some(path) = &config.native_path {
        if !path.is_absolute() {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
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
        && package.get("version").and_then(Value::as_str) == Some("0.9.2")
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
    let (factory, name) = match kind {
        HarnessKind::Pi => (PI_SOURCE, "createPiAdapter"),
        HarnessKind::PrimeAgent => (PRIME_SOURCE, "createPrimeAdapter"),
        HarnessKind::Codex => (CODEX_SOURCE, "createCodexAdapter"),
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
        if launch.version.as_deref() != Some("0.147.0") {
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
        version: Some("0.9.2".into()),
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
    }
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

fn resolve_node() -> Result<PathBuf, NativeRuntimeError> {
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
    match kind {
        HarnessKind::Pi => HarnessCapabilities {
            prompt: capability(true, Enforcement::Native, None),
            resume: capability(true, Enforcement::Native, None),
            models: capability(true, Enforcement::Native, None),
            approvals: capability(true, Enforcement::Native, None),
            instructions: capability(
                false,
                Enforcement::Unsupported,
                Some("Safe instruction injection is not available through Pi RPC."),
            ),
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
    }
}

/// Offline installed-harness metadata. This performs filesystem reads only.
#[must_use]
pub fn probe_native_harnesses() -> Vec<NativeHarnessSummary> {
    [
        HarnessKind::Pi,
        HarnessKind::PrimeAgent,
        HarnessKind::Codex,
    ]
    .into_iter()
    .map(|kind| match resolve_harness_launch(kind) {
        Ok(launch) => {
            let expected = match kind {
                HarnessKind::Pi => None,
                HarnessKind::PrimeAgent => Some("0.9.2"),
                HarnessKind::Codex => Some("0.147.0"),
            };
            let version_supported = expected.is_none_or(|expected| {
                launch.version.as_deref() == Some(expected)
            });
            let platform_verified = cfg!(windows);
            let (status, reason) = if !version_supported {
                (
                    HarnessAvailability::Unverified,
                    Some("The installed native harness version is not supported by this adapter.".into()),
                )
            } else if !platform_verified {
                (
                    HarnessAvailability::Unverified,
                    Some("Native lifecycle containment is not yet verified on this platform.".into()),
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
            instructions: None,
            permission_mode: PermissionMode::Native,
            allowed_tools: None,
            native_subagents: None,
            daemon_socket: None,
            package_root: None,
            agent_dir: None,
            kernel_python: None,
            coordination: false,
        }
    }

    fn test_bridge_source(factory_body: &str) -> Vec<u8> {
        format!(
            "export async function createTestAdapter(config,emit,coordinatorRequest){{{factory_body}}}\nglobalThis.__PIUI_BRIDGE_FACTORY__=createTestAdapter;\n{RUNNER_SOURCE}"
        )
        .into_bytes()
    }

    async fn spawn_test_bridge(
        factory_body: &str,
    ) -> Result<(NativeRuntime, mpsc::Receiver<NativeEvent>), NativeRuntimeError> {
        let node = resolve_node()?;
        NativeRuntime::spawn_resolved(
            test_config(),
            node.clone(),
            ResolvedHarnessLaunch {
                program: node,
                args: Vec::new(),
                version: None,
            },
            test_bridge_source(factory_body),
        )
        .await
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
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: AtomicBool::new(true),
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
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::from(["late".into()])),
            next_id: AtomicU64::new(1),
            accepting: AtomicBool::new(true),
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
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: AtomicBool::new(true),
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
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            timed_out: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            accepting: AtomicBool::new(true),
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
}
