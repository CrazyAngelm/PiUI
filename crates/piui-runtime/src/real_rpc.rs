//! Live Pi RPC process adapter.
//!
//! This module spawns a real `pi --mode rpc` child process, drives the same
//! LF-only [`RpcCodec`] the foundation already validated for stdout framing,
//! correlates commands by id, normalizes Pi agent/session events into a small
//! set of host-safe [`SurfaceEvent`]s, and owns a minimal lifecycle state
//! machine (Starting -> Ready -> Running -> ... -> Failed/Dormant).
//!
//! It is deliberately additive: the deterministic fake runtime remains the
//! safe-mode/foundation path. Nothing here reads `auth.json`, prompts, or raw
//! session payloads into the events that cross to the WebView; unknown events
//! are reduced to a payload-free generic notice.

use crate::codec::{RpcCodec, RpcCodecConfig};
use piui_contracts::{RuntimeId, RuntimeState};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::timeout;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);
const READ_BUF_BYTES: usize = 16 * 1024;
const MAX_THINKING_LEVELS: usize = 8;
/// Version of the host-to-WebView live-runtime event channel.
/// v5 makes projectless Chats explicit so the host-owned backing workspace id
/// cannot cross the event boundary.
pub const LOCAL_RUNTIME_EVENT_PROTOCOL: u8 = 5;
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
    #[error("Pi runtime is not running")]
    NotRunning,
    #[error("Could not resolve a Pi installation: {0}")]
    Resolve(String),
    #[error("Could not spawn Pi: {0}")]
    Spawn(String),
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("Command timed out")]
    Timeout,
    #[error("Pi rejected the command: {0}")]
    Command(String),
    #[error("Pi exited before responding: {0}")]
    Exited(String),
    #[error("Response channel closed")]
    Channel,
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

/// Host-safe events the Tauri host forwards to the WebView as `piui://runtime-event`.
/// These never carry raw Pi JSON, credentials, host paths, or prompt text beyond
/// the visible message deltas themselves.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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
    ExtensionUiRequest {
        id: String,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safe_summary: Option<String>,
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
        let scope = if project_id.is_some() {
            RuntimeEventScope::Project
        } else {
            RuntimeEventScope::Personal
        };
        Self {
            protocol: LOCAL_RUNTIME_EVENT_PROTOCOL,
            runtime_id,
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
    /// Opens an already indexed Pi-owned session file.
    pub session_path: Option<PathBuf>,
    pub session_name: Option<String>,
}

struct RuntimeShared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, RealRuntimeError>>>>,
    state: Mutex<RuntimeState>,
    revision: AtomicU64,
    next_id: AtomicU64,
    /// Set only by the host-owned stop path; a clean EOF without this flag is
    /// a crashed/unexpected child, not an idle runtime.
    shutting_down: AtomicBool,
}

/// Live runtime handle. Drop is not sufficient to stop the child; callers
/// must `stop()` to drain and terminate the process.
pub struct RealPiRuntime {
    shared: Arc<RuntimeShared>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr: Mutex<Option<tokio::task::JoinHandle<()>>>,
    launch_label: String,
}

impl RealPiRuntime {
    /// Spawns the Pi process and a background stdout reader that emits
    /// [`SurfaceEvent`]s on the returned channel. Performs the startup
    /// `get_state` handshake and returns the initial state + revision.
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
        let launch = resolve_pi_launch().map_err(RealRuntimeError::Resolve)?;
        let mut std_command = std::process::Command::new(&launch.program);
        std_command
            .args(&launch.leading_args)
            .arg("--mode")
            .arg("rpc")
            .current_dir(&config.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(path) = &config.session_path {
            std_command.arg("--session").arg(path);
        }
        if let Some(name) = &config.session_name {
            std_command.arg("--name").arg(name);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            // CREATE_NO_WINDOW: never pop a console for the spawned CLI.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std_command.creation_flags(CREATE_NO_WINDOW);
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
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RealRuntimeError::Spawn("Pi stdin pipe was not captured".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RealRuntimeError::Spawn("Pi stdout pipe was not captured".into()))?;
        let stderr = child.stderr.take();

        let instance = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let runtime_id = RuntimeId::new(format!("piui-live-{}-{instance}", std::process::id()));
        let shared = Arc::new(RuntimeShared {
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            state: Mutex::new(RuntimeState::Starting),
            revision: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
        });

        let (event_tx, event_rx) = mpsc::channel::<SurfaceEvent>(256);
        let reader_shared = Arc::clone(&shared);
        let reader_tx = event_tx.clone();
        let reader_handle = tokio::spawn(async move {
            run_stdout_loop(stdout, reader_shared, reader_tx).await;
        });

        let stderr_handle = stderr.map(|stream| {
            tokio::spawn(async move {
                drain_stderr(stream).await;
            })
        });

        let runtime = Self {
            shared: Arc::clone(&shared),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(Some(reader_handle)),
            stderr: Mutex::new(stderr_handle),
            launch_label: launch.label,
        };

        // Startup handshake: ask Pi for its current state. A success here is the
        // Ready signal; the first turn later flips to Running via events.
        let state = match runtime
            .request("get_state", json!({}))
            .await
            .and_then(parse_session_state)
        {
            Ok(state) => state,
            Err(error) => {
                let _ = runtime.shutdown_child().await;
                return Err(error);
            }
        };
        if !transition_starting_to_ready(&runtime.shared, &event_tx).await {
            let _ = runtime.terminate().await;
            return Err(RealRuntimeError::Exited(
                "Pi stopped during the startup handshake.".into(),
            ));
        }
        let revision = runtime.shared.revision.load(Ordering::Relaxed);

        // Surface the initial model list asynchronously so the composer can
        // show a picker without blocking the first paint.
        let runtime_clone = RealPiRuntime {
            shared: Arc::clone(&shared),
            child: Mutex::new(None),
            reader: Mutex::new(None),
            stderr: Mutex::new(None),
            launch_label: runtime.launch_label.clone(),
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
        let body = json!({ "id": self.next_command_id(), "type": "abort" });
        self.fire_and_expect_success(body, Duration::from_secs(10))
            .await
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
        let value = self
            .request("get_available_thinking_levels", json!({}))
            .await?;
        map_thinking_levels(&value)
            .ok_or_else(|| RealRuntimeError::Protocol("missing thinking-level payload".into()))
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

    /// Graceful stop: abort a running turn, close stdin, wait, then kill.
    pub async fn stop(&self) -> Result<(), RealRuntimeError> {
        self.shared.shutting_down.store(true, Ordering::Release);
        let _ = self.abort().await;
        self.terminate().await
    }

    /// Immediately retires a failed or no-longer-authorized runtime without
    /// issuing another RPC command through a stream that may already be bad.
    pub async fn terminate(&self) -> Result<(), RealRuntimeError> {
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
        let write_result = {
            let mut stdin_guard = self.shared.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                match stdin.write_all(&framed).await {
                    Ok(()) => stdin.flush().await,
                    Err(error) => Err(error),
                }
            } else {
                Err(std::io::Error::other("Pi stdin is unavailable"))
            }
        };
        if write_result.is_err() {
            self.shared.pending.lock().await.remove(&command_id);
            return Err(RealRuntimeError::NotRunning);
        }

        match timeout(deadline, rx).await {
            Ok(Ok(Ok(value))) => {
                validate_success_response(&value, &expected_command)?;
                Ok(value)
            }
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(RealRuntimeError::Exited(
                "Pi closed the response channel before replying.".into(),
            )),
            Err(_) => {
                self.shared.pending.lock().await.remove(&command_id);
                Err(RealRuntimeError::Timeout)
            }
        }
    }

    fn next_command_id(&self) -> String {
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        format!("piui-c-{n}")
    }

    async fn shutdown_child(&self) -> Result<(), RealRuntimeError> {
        self.shared.shutting_down.store(true, Ordering::Release);
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
            return Ok(());
        };
        match timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
            Ok(Ok(_status)) => Ok(()),
            _ => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Ok(())
            }
        }
    }
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
        RealRuntimeError::Protocol(format!("Pi `{command}` response lacked object data"))
    })
}

fn parse_session_state(value: Value) -> Result<SessionStateLite, RealRuntimeError> {
    required_response_data(&value, "get_state")?;
    let state = map_session_state(&value);
    if state.session_id.is_empty() {
        return Err(RealRuntimeError::Protocol(
            "Pi `get_state` response lacked a session id".into(),
        ));
    }
    Ok(state)
}

/// The stdout reader: feeds bytes into the validated LF codec, routes
/// `response` frames to pending command slots, and normalizes events.
async fn run_stdout_loop(
    stdout: tokio::process::ChildStdout,
    shared: Arc<RuntimeShared>,
    event_tx: mpsc::Sender<SurfaceEvent>,
) {
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
    let mut reader = stdout;
    let mut buf = vec![0u8; READ_BUF_BYTES];
    let mut tracker = StreamTracker::default();

    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let values = match codec.push(&buf[..n]) {
                    Ok(values) => values,
                    Err(_) => {
                        mark_failed(&shared, &event_tx, "Pi emitted a malformed RPC frame.").await;
                        return;
                    }
                };
                for value in values {
                    handle_frame(value, &shared, &event_tx, &mut tracker).await;
                }
            }
            Err(_) => {
                mark_failed(&shared, &event_tx, "Pi stdout could not be read.").await;
                return;
            }
        }
    }
    if codec.finish().is_err() {
        mark_failed(&shared, &event_tx, "Pi ended with an incomplete RPC frame.").await;
    } else if shared.shutting_down.load(Ordering::Acquire) {
        mark_settled(&shared, &event_tx).await;
    } else {
        mark_failed(&shared, &event_tx, "Pi exited unexpectedly.").await;
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

async fn handle_frame(
    value: Value,
    shared: &Arc<RuntimeShared>,
    event_tx: &mpsc::Sender<SurfaceEvent>,
    tracker: &mut StreamTracker,
) {
    // Response frames resolve pending command slots.
    if let Some(obj) = value.as_object() {
        if obj.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(id) = obj.get("id").and_then(Value::as_str).map(str::to_owned) {
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
        return;
    };
    match event_type.as_str() {
        "agent_start" => {
            set_shared_state(shared, RuntimeState::Running, event_tx).await;
        }
        "agent_end" => {
            // Pi can retry, compact, or dispatch queued work after agent_end.
            // Only agent_settled is its documented idle boundary.
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
            // Unknown events are intentionally still surfaced as a generic
            // durable entry if they clearly represent a persisted record;
            // otherwise they are dropped to keep the surface set finite.
        }
    }
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
    fail_pending(shared, "Pi runtime stopped.").await;
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
            safe_summary: Some("Pi runtime exited.".into()),
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
    let source_id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let source_method = obj
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let public_id = opaque_surface_id("extension", &source_id);
    let public_method = safe_extension_method(&source_method);
    let safe_summary = extension_safe_summary(&source_method);
    // `spawn()` has not handed its receiver to the host until the get_state
    // handshake returns. Do not let an extension's startup-notification burst
    // fill that bounded channel and block protocol response routing. Status
    // notices are best-effort; blocking dialogs still receive cancellation.
    let _ = event_tx.try_send(SurfaceEvent::ExtensionUiRequest {
        id: public_id,
        method: public_method,
        safe_summary,
    });
    // Blocking dialog methods must receive a response or Pi waits forever.
    // For MVP we cancel them immediately; the UI still shows a generic notice.
    if matches!(
        source_method.as_str(),
        "select" | "confirm" | "input" | "editor"
    ) {
        let response =
            json!({ "type": "extension_ui_response", "id": source_id, "cancelled": true });
        if let Ok(bytes) = serde_json::to_vec(&response) {
            let mut frame = bytes;
            frame.push(b'\n');
            let mut stdin = shared.stdin.lock().await;
            if let Some(stdin) = stdin.as_mut() {
                let _ = stdin.write_all(&frame).await;
                let _ = stdin.flush().await;
            }
        }
    }
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

fn safe_extension_method(method: &str) -> String {
    match method {
        "notify" => "notify".into(),
        "setStatus" => "setStatus".into(),
        "setWidget" => "setWidget".into(),
        "setTitle" => "setTitle".into(),
        "set_editor_text" => "set_editor_text".into(),
        "select" | "confirm" | "input" | "editor" => method.to_owned(),
        _ => "extension request".into(),
    }
}

fn extension_safe_summary(method: &str) -> Option<String> {
    match method {
        "notify" => Some("Extension notification received.".into()),
        "setStatus" => Some("Extension status updated.".into()),
        "setWidget" => Some("Extension updated a status widget.".into()),
        "setTitle" => Some("Extension title updated.".into()),
        "set_editor_text" => Some("Extension updated the composer draft.".into()),
        "select" | "confirm" | "input" | "editor" => Some(format!(
            "An extension requested input (`{method}`) and was auto-cancelled."
        )),
        _ => Some("An unrecognized extension request was ignored.".into()),
    }
}

fn redact_command_error(command: &str, _error: &str) -> String {
    // Pi's raw error can contain a local path, provider details, or text from
    // the prompt. Keep it host-private and expose only the action that failed.
    format!("Pi rejected the `{command}` command.")
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
            .map(|value| value as usize)
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

async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    let mut buf = vec![0u8; READ_BUF_BYTES];
    // Stderr is intentionally not surfaced to the WebView as raw bytes. We
    // drain it fully so Pi cannot block on a full pipe, and retain nothing.
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => continue,
        }
    }
}

/// Resolves how to launch the installed Pi CLI in rpc mode.
pub fn resolve_pi_launch() -> Result<PiLaunch, String> {
    if let Some(cli) = std::env::var_os("PIUI_PI_CLI") {
        let cli_path = PathBuf::from(cli);
        if cli_path.is_file() {
            let node = std::env::var_os("PIUI_PI_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("node"));
            return Ok(PiLaunch {
                program: node,
                leading_args: vec![cli_path.to_string_lossy().into_owned()],
                label: "PIUI_PI_CLI override".into(),
            });
        }
    }

    if let Some(cli_path) = resolve_global_cli_js() {
        let node = std::env::var_os("PIUI_PI_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
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
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        for name in names {
            let candidate = dir.join(name);
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
    use super::{
        LOCAL_RUNTIME_EVENT_PROTOCOL, RealPiConfig, RealPiRuntime, RealRuntimeError,
        RuntimeEventEnvelope, RuntimeShared, StreamTracker, SurfaceEvent, extension_safe_summary,
        fail_pending, handle_frame, map_models, map_session_state, map_thinking_levels,
        opaque_surface_id, prompt_command, required_response_data, safe_extension_method,
        safe_tool_name, transition_starting_to_ready, validate_success_response,
    };
    use piui_contracts::RuntimeState;
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tokio::sync::{Mutex, mpsc, oneshot};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn runtime_extension_projection_is_opaque_and_payload_free() {
        assert_eq!(safe_extension_method("notify"), "notify");
        assert_eq!(safe_extension_method("/private/path"), "extension request");
        assert_eq!(
            extension_safe_summary("notify").as_deref(),
            Some("Extension notification received.")
        );
        assert!(
            !extension_safe_summary("notify")
                .expect("safe summary")
                .contains("private")
        );
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

    fn shared_for_test(state: RuntimeState) -> Arc<RuntimeShared> {
        Arc::new(RuntimeShared {
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            state: Mutex::new(state),
            revision: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
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
        fail_pending(&shared, "Pi exited unexpectedly.").await;
        assert!(matches!(
            receiver.await,
            Ok(Err(RealRuntimeError::Exited(message))) if message == "Pi exited unexpectedly."
        ));
    }

    #[test]
    fn runtime_events_have_an_explicit_v5_scope_envelope() {
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
