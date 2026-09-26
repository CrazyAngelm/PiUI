//! Contained Node.js process for one plugin backend (ADR-032).
//!
//! The host starts `node <entry>` from the plugin's package folder with a
//! minimal allowlisted environment and contains the whole process tree: a
//! Windows Job Object assigned before the process resumes (killed when PiUI
//! exits), or a Unix process group. The transport is JSON-RPC 2.0 with one
//! JSON object per line, delimited only by LF ([`RpcCodec`]), and frames are
//! bounded. In v1 a backend only answers host requests: any other frame,
//! an unknown response id or a malformed or oversized frame is a protocol
//! violation that stops it. A request that times out or is cancelled stops
//! it too, so nothing it started keeps running. stderr is drained and
//! discarded: plugin output is never logged. This is containment, not a
//! sandbox: the backend runs with the user's file and network access.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

#[cfg(any(unix, windows))]
use piui_platform::ProcessContainment;
#[cfg(unix)]
use piui_platform::{ProcessGroupId, UnixProcessGroup};
#[cfg(windows)]
use piui_platform::{ProcessId, SuspendedProcess, WindowsJob};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot, watch};

use crate::codec::{RpcCodec, RpcCodecConfig};
use crate::script_runner::process_directory;

/// Largest frame read from a backend, without its LF.
pub const PLUGIN_FRAME_BYTES: usize = 1024 * 1024;
/// Host environment variables a plugin backend inherits. Everything else,
/// including API keys, tokens, `NODE_OPTIONS` and PiUI operator variables,
/// is removed.
pub const PLUGIN_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "TZ",
];
const READ_BUFFER_BYTES: usize = 16 * 1024;
const REAP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PluginBackendError {
    #[error("Node.js was not found")]
    NodeUnavailable,
    #[error("the plugin backend could not be started")]
    Spawn,
    #[error("the plugin backend could not be contained")]
    Containment,
    #[error("the plugin backend broke the protocol")]
    Protocol,
    #[error("the plugin backend stopped")]
    Stopped,
    #[error("the plugin backend did not answer in time")]
    Timeout,
    #[error("the request was cancelled")]
    Cancelled,
    /// The backend answered with a JSON-RPC error.
    #[error("the plugin backend reported an error")]
    Remote { code: i64, message: String },
}

/// Why a backend process is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendExit {
    /// The host stopped it (shutdown, disable, removal, quit).
    Stopped,
    /// It exited or closed its output on its own.
    Crashed,
    /// It wrote something that is not a valid response.
    Protocol,
    /// A request timed out and the host stopped it.
    TimedOut,
    /// A cancelled request stopped it.
    Cancelled,
}

/// What to start.
pub struct PluginBackendLaunch<'a> {
    /// Node.js; [`resolve_plugin_node`] finds the one the bridges use.
    pub node: &'a Path,
    /// The backend entry file, absolute and inside `working_dir`.
    pub entry: &'a Path,
    /// The plugin's package folder.
    pub working_dir: &'a Path,
    /// The host environment to filter, normally `std::env::vars_os()`.
    pub host_environment: &'a [(OsString, OsString)],
}

/// Node.js as the harness bridges and script steps find it (`PIUI_NODE`
/// first, then absolute `PATH` entries). Never user-supplied.
pub fn resolve_plugin_node() -> Result<PathBuf, PluginBackendError> {
    crate::workspace_runtime::resolve_node().map_err(|_| PluginBackendError::NodeUnavailable)
}

/// The allowlisted subset of `host`, matching names case-insensitively on
/// Windows where the environment block is case-insensitive.
#[must_use]
pub fn plugin_environment(host: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    host.iter()
        .filter(|(name, _)| {
            PLUGIN_ENVIRONMENT_ALLOWLIST.iter().any(|allowed| {
                if cfg!(windows) {
                    name.to_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(allowed))
                } else {
                    name.as_os_str() == OsStr::new(allowed)
                }
            })
        })
        .cloned()
        .collect()
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, PluginBackendError>>>;

struct Containment {
    #[cfg(unix)]
    group: StdMutex<Option<UnixProcessGroup>>,
    #[cfg(windows)]
    job: StdMutex<Option<WindowsJob>>,
}

impl Containment {
    fn terminate(&self) {
        #[cfg(unix)]
        if let Ok(mut slot) = self.group.lock()
            && let Some(mut group) = slot.take()
        {
            let _ = group.force_terminate_tree();
            group.discard_after_supervisor_cleanup();
        }
        #[cfg(windows)]
        if let Ok(mut slot) = self.job.lock()
            && let Some(mut job) = slot.take()
        {
            let _ = job.force_terminate_tree();
            let _ = job.close();
        }
    }
}

struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: StdMutex<Pending>,
    next_id: AtomicU64,
    stopping: AtomicBool,
    exit: watch::Sender<Option<BackendExit>>,
    containment: Containment,
}

impl Shared {
    fn fail_pending(&self, error: &PluginBackendError) {
        let pending = self
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for (_, sender) in pending {
            let _ = sender.send(Err(error.clone()));
        }
    }

    /// Ends the process tree once and records why.
    fn end(&self, reason: BackendExit) {
        self.stopping.store(true, Ordering::Release);
        self.containment.terminate();
        self.exit.send_if_modified(|exit| {
            if exit.is_none() {
                *exit = Some(reason);
                true
            } else {
                false
            }
        });
        self.fail_pending(&match reason {
            BackendExit::Protocol => PluginBackendError::Protocol,
            BackendExit::TimedOut => PluginBackendError::Timeout,
            BackendExit::Cancelled => PluginBackendError::Cancelled,
            BackendExit::Stopped | BackendExit::Crashed => PluginBackendError::Stopped,
        });
    }
}

/// A running plugin backend.
pub struct PluginBackend {
    shared: Arc<Shared>,
    child: Mutex<Option<Child>>,
}

impl PluginBackend {
    /// Starts the backend contained and returns once it runs. The caller
    /// sends `initialize` next.
    pub async fn spawn(launch: PluginBackendLaunch<'_>) -> Result<Self, PluginBackendError> {
        if !launch.entry.is_absolute() || !launch.entry.starts_with(launch.working_dir) {
            return Err(PluginBackendError::Spawn);
        }
        #[cfg(windows)]
        let mut job = WindowsJob::new().map_err(|_| PluginBackendError::Containment)?;
        let mut standard = std::process::Command::new(launch.node);
        standard
            // Node cannot load a module from a verbatim `\\?\` path.
            .arg(process_directory(launch.entry))
            .current_dir(process_directory(launch.working_dir))
            .env_clear()
            .envs(plugin_environment(launch.host_environment))
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
        let mut child = command.spawn().map_err(|_| PluginBackendError::Spawn)?;

        #[cfg(windows)]
        let containment = {
            // The primary thread stays suspended until the Job owns it, so no
            // plugin code runs outside containment.
            let assignment = child
                .id()
                .and_then(|pid| ProcessId::new(pid).ok())
                .and_then(|pid| {
                    job.assign_before_resume(SuspendedProcess::from_created_suspended(pid))
                        .ok()
                });
            let Some(assignment) = assignment else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(PluginBackendError::Containment);
            };
            if job.resume_assigned(assignment).is_err() {
                let _ = job.force_terminate_tree();
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(PluginBackendError::Containment);
            }
            Containment {
                job: StdMutex::new(Some(job)),
            }
        };
        #[cfg(unix)]
        let containment = {
            let group = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .and_then(|pid| ProcessGroupId::new(pid).ok());
            let Some(group) = group else {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(PluginBackendError::Containment);
            };
            Containment {
                group: StdMutex::new(Some(UnixProcessGroup::from_spawned_group(group))),
            }
        };
        #[cfg(not(any(unix, windows)))]
        let containment = Containment {};

        let stdin = child.stdin.take().ok_or(PluginBackendError::Spawn)?;
        let stdout = child.stdout.take().ok_or(PluginBackendError::Spawn)?;
        let stderr = child.stderr.take();
        let (exit, _) = watch::channel(None);
        let shared = Arc::new(Shared {
            stdin: Mutex::new(Some(stdin)),
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            exit,
            containment,
        });
        tokio::spawn(read_frames(stdout, Arc::clone(&shared)));
        if let Some(mut stderr) = stderr {
            tokio::spawn(async move {
                let mut buffer = [0_u8; READ_BUFFER_BYTES];
                // Drained and discarded: plugin diagnostics may hold anything.
                while let Ok(read) = stderr.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                }
            });
        }
        Ok(Self {
            shared,
            child: Mutex::new(Some(child)),
        })
    }

    /// Resolves once the process is gone, with the reason.
    #[must_use]
    pub fn exit(&self) -> watch::Receiver<Option<BackendExit>> {
        self.shared.exit.subscribe()
    }

    /// Whether the process is still accepting requests.
    #[must_use]
    pub fn running(&self) -> bool {
        self.shared.exit.borrow().is_none()
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), PluginBackendError> {
        let mut line = serde_json::to_vec(frame).map_err(|_| PluginBackendError::Protocol)?;
        line.push(b'\n');
        let mut stdin = self.shared.stdin.lock().await;
        let stream = stdin.as_mut().ok_or(PluginBackendError::Stopped)?;
        if stream.write_all(&line).await.is_err() || stream.flush().await.is_err() {
            drop(stdin);
            self.shared.end(BackendExit::Crashed);
            return Err(PluginBackendError::Stopped);
        }
        Ok(())
    }

    /// Sends a notification (no answer expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), PluginBackendError> {
        if !self.running() {
            return Err(PluginBackendError::Stopped);
        }
        self.write_frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    /// Sends a request and waits for its answer, the timeout or `cancel`.
    /// A timeout or a cancellation stops the whole backend.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        mut cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Value, PluginBackendError> {
        if !self.running() {
            return Err(PluginBackendError::Stopped);
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .map_err(|_| PluginBackendError::Stopped)?
            .insert(id, sender);
        if let Err(error) = self
            .write_frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
        {
            if let Ok(mut pending) = self.shared.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        let cancelled = async {
            match cancel.as_mut() {
                Some(cancel) => loop {
                    if *cancel.borrow_and_update() {
                        return;
                    }
                    if cancel.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                },
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            answer = receiver => answer.unwrap_or(Err(PluginBackendError::Stopped)),
            () = tokio::time::sleep(timeout) => {
                self.shared.end(BackendExit::TimedOut);
                self.reap().await;
                Err(PluginBackendError::Timeout)
            }
            () = cancelled => {
                self.shared.end(BackendExit::Cancelled);
                self.reap().await;
                Err(PluginBackendError::Cancelled)
            }
        }
    }

    /// Asks the backend to shut down, waits at most `grace`, then ends the
    /// whole tree. Always leaves nothing running.
    pub async fn shutdown(&self, grace: Duration) {
        if self.running() {
            self.shared.stopping.store(true, Ordering::Release);
            let _ =
                tokio::time::timeout(grace, self.request("shutdown", json!({}), grace, None)).await;
        }
        self.stop().await;
    }

    /// Ends the whole tree immediately.
    pub async fn stop(&self) {
        self.shared.end(BackendExit::Stopped);
        *self.shared.stdin.lock().await = None;
        self.reap().await;
    }

    /// Ends the tree without waiting (for synchronous shutdown paths).
    pub fn stop_now(&self) {
        self.shared.end(BackendExit::Stopped);
    }

    async fn reap(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
        }
    }
}

impl Drop for PluginBackend {
    fn drop(&mut self) {
        self.shared.end(BackendExit::Stopped);
    }
}

/// Routes answers to their requests; anything else ends the backend.
async fn read_frames(mut stdout: tokio::process::ChildStdout, shared: Arc<Shared>) {
    let Ok(mut codec) = RpcCodec::new(RpcCodecConfig::new(PLUGIN_FRAME_BYTES)) else {
        shared.end(BackendExit::Protocol);
        return;
    };
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    loop {
        let read = match stdout.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let Ok(frames) = codec.push(&buffer[..read]) else {
            shared.end(BackendExit::Protocol);
            return;
        };
        for frame in frames {
            if route(&shared, frame).is_err() {
                shared.end(BackendExit::Protocol);
                return;
            }
        }
    }
    let incomplete = codec.finish().is_err();
    let expected = shared.stopping.load(Ordering::Acquire);
    shared.end(if incomplete {
        BackendExit::Protocol
    } else if expected {
        BackendExit::Stopped
    } else {
        BackendExit::Crashed
    });
}

fn route(shared: &Shared, frame: Value) -> Result<(), ()> {
    let object = frame.as_object().ok_or(())?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(());
    }
    let id = object.get("id").and_then(Value::as_u64).ok_or(())?;
    let sender = shared
        .pending
        .lock()
        .map_err(|_| ())?
        .remove(&id)
        .ok_or(())?;
    let answer = match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let code = error.get("code").and_then(Value::as_i64).ok_or(())?;
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .ok_or(())?
                .to_owned();
            Err(PluginBackendError::Remote { code, message })
        }
        _ => return Err(()),
    };
    let _ = sender.send(answer);
    Ok(())
}

#[cfg(test)]
#[path = "plugin_backend_tests.rs"]
mod tests;
