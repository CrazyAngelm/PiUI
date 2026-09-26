//! Host supervisor of plugin backends (ADR-032).
//!
//! A backend starts lazily on its first use, contained
//! (`piui_runtime::plugin_backend`), and is initialized with the permissions
//! the user trusted, its settings and a private data folder. A crash (an
//! unexpected exit or a protocol violation) is recorded and the next use
//! restarts it after a backoff of 1, 2, 4 … 60 seconds; five crashes within
//! ten minutes stop it until the user restarts it from Settings. Disable,
//! removal, reload and quit stop the whole process tree. Only metadata is
//! logged: never arguments, results or plugin output.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piui_plugins::Permission;
use piui_runtime::plugin_backend::{
    BackendExit, PluginBackend, PluginBackendError, PluginBackendLaunch, resolve_plugin_node,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

/// How long `initialize` may take (Node start-up and module load included).
pub(crate) const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a `shutdown` request may take before the tree is terminated.
pub(crate) const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);
const CRASH_LOOP_LIMIT: usize = 5;
const MAX_BACKOFF_SECONDS: u64 = 60;
const MAX_LOG_ENTRIES: usize = 20;

/// Metadata events shown in Settings → Plugins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LogEvent {
    Installed,
    Updated,
    Enabled,
    Disabled,
    Reloaded,
    VerificationFailed,
    BackendStarted,
    BackendStopped,
    BackendCrashed,
    BackendTimeout,
    BackendProtocol,
    BackendStartFailed,
    CrashLoop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogEntry {
    pub at: String,
    pub event: LogEvent,
}

/// What Settings shows for a backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BackendState {
    Stopped,
    Starting,
    Running,
    Crashed,
    CrashLoop,
    Unavailable,
}

/// Everything needed to start one plugin's backend.
#[derive(Clone, Debug)]
pub(crate) struct BackendSpec {
    pub plugin_id: String,
    pub version: String,
    pub root: PathBuf,
    pub entry: PathBuf,
    pub permissions: Vec<Permission>,
    pub settings: Map<String, Value>,
    pub data_dir: PathBuf,
    pub piui_version: String,
}

/// Why a backend could not take a request; in every case nothing was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartFailure {
    NodeMissing,
    Backoff,
    CrashLoop,
    Failed,
    ShuttingDown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CallError {
    /// Nothing was sent to the backend.
    NotStarted(StartFailure),
    /// The backend answered with an error message.
    Remote(String),
    /// No answer in time; the backend was stopped.
    Timeout,
    /// The caller cancelled; the backend was stopped.
    Cancelled,
    /// The backend stopped or broke the protocol while handling the request:
    /// its outcome is unknown.
    Lost,
}

#[derive(Default)]
struct SlotState {
    backend: Option<Arc<PluginBackend>>,
    generation: u64,
    starting: bool,
    consecutive: u32,
    crashes: VecDeque<Instant>,
    retry_at: Option<Instant>,
    crash_loop: bool,
    crashed: bool,
    node_missing: bool,
    restarts: u32,
    log: VecDeque<LogEntry>,
}

#[derive(Default)]
struct Slot {
    start: tokio::sync::Mutex<()>,
    state: Mutex<SlotState>,
}

type Notify = Arc<dyn Fn() + Send + Sync>;

pub(crate) struct Supervisor {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    shutting_down: AtomicBool,
    notify: Mutex<Option<Notify>>,
}

fn now_string() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn push_log(state: &mut SlotState, event: LogEvent) {
    state.log.push_back(LogEntry {
        at: now_string(),
        event,
    });
    while state.log.len() > MAX_LOG_ENTRIES {
        state.log.pop_front();
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            notify: Mutex::new(None),
        }
    }

    /// Called after every backend state change (Settings refreshes).
    pub fn set_notify(&self, notify: Notify) {
        if let Ok(mut slot) = self.notify.lock() {
            *slot = Some(notify);
        }
    }

    fn changed(&self) {
        let notify = self.notify.lock().ok().and_then(|slot| slot.clone());
        if let Some(notify) = notify {
            notify();
        }
    }

    fn slot(&self, plugin_id: &str) -> Option<Arc<Slot>> {
        let mut slots = self.slots.lock().ok()?;
        Some(Arc::clone(slots.entry(plugin_id.to_owned()).or_default()))
    }

    /// Records a registry event in the plugin's log.
    pub fn record(&self, plugin_id: &str, event: LogEvent) {
        if let Some(slot) = self.slot(plugin_id)
            && let Ok(mut state) = slot.state.lock()
        {
            push_log(&mut state, event);
        }
    }

    /// Current state, restart count and log of one plugin's backend.
    pub fn status(&self, plugin_id: &str) -> (BackendState, u32, Vec<LogEntry>) {
        let Some(slot) = self.slot(plugin_id) else {
            return (BackendState::Stopped, 0, Vec::new());
        };
        let Ok(state) = slot.state.lock() else {
            return (BackendState::Stopped, 0, Vec::new());
        };
        let current = if state.crash_loop {
            BackendState::CrashLoop
        } else if state.starting {
            BackendState::Starting
        } else if state
            .backend
            .as_ref()
            .is_some_and(|backend| backend.running())
        {
            BackendState::Running
        } else if state.node_missing {
            BackendState::Unavailable
        } else if state.crashed {
            BackendState::Crashed
        } else {
            BackendState::Stopped
        };
        (current, state.restarts, state.log.iter().cloned().collect())
    }

    /// Clears the crash history so the next use starts the backend again,
    /// and stops a running one.
    pub async fn restart(&self, plugin_id: &str) {
        self.stop(plugin_id).await;
        if let Some(slot) = self.slot(plugin_id)
            && let Ok(mut state) = slot.state.lock()
        {
            state.crash_loop = false;
            state.crashed = false;
            state.consecutive = 0;
            state.crashes.clear();
            state.retry_at = None;
            state.node_missing = false;
        }
        self.changed();
    }

    /// Stops a backend and its whole tree (disable, remove, reload, update).
    pub async fn stop(&self, plugin_id: &str) {
        let backend = self
            .slot(plugin_id)
            .and_then(|slot| slot.state.lock().ok()?.backend.take());
        if let Some(backend) = backend {
            backend.shutdown(SHUTDOWN_GRACE).await;
        }
    }

    /// Ends every backend tree at once (application exit).
    pub fn shutdown_all(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let slots = self
            .slots
            .lock()
            .map(|slots| slots.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for slot in slots {
            let backend = slot
                .state
                .lock()
                .ok()
                .and_then(|mut state| state.backend.take());
            if let Some(backend) = backend {
                backend.stop_now();
            }
        }
    }

    /// Tells a running backend that its settings changed.
    pub async fn settings_changed(&self, plugin_id: &str, settings: &Map<String, Value>) {
        let backend = self
            .slot(plugin_id)
            .and_then(|slot| slot.state.lock().ok()?.backend.clone());
        if let Some(backend) = backend {
            let _ = backend
                .notify("settings/changed", json!({ "settings": settings }))
                .await;
        }
    }

    /// Sends one request, starting the backend first when needed.
    pub async fn call(
        &self,
        spec: &BackendSpec,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Value, CallError> {
        let slot = self
            .slot(&spec.plugin_id)
            .ok_or(CallError::NotStarted(StartFailure::Failed))?;
        let backend = self.ensure(&slot, spec).await?;
        let started = Instant::now();
        let result = backend.request(method, params, timeout, cancel).await;
        eprintln!(
            "event=plugin_request plugin_id={:?} method={method} outcome={} duration_ms={}",
            spec.plugin_id,
            match &result {
                Ok(_) => "ok",
                Err(PluginBackendError::Remote { .. }) => "error",
                Err(PluginBackendError::Timeout) => "timeout",
                Err(PluginBackendError::Cancelled) => "cancelled",
                Err(_) => "lost",
            },
            started.elapsed().as_millis()
        );
        match result {
            Ok(value) => {
                if let Ok(mut state) = slot.state.lock() {
                    state.consecutive = 0;
                }
                Ok(value)
            }
            Err(PluginBackendError::Remote { message, .. }) => Err(CallError::Remote(message)),
            Err(PluginBackendError::Timeout) => Err(CallError::Timeout),
            Err(PluginBackendError::Cancelled) => Err(CallError::Cancelled),
            Err(_) => Err(CallError::Lost),
        }
    }

    async fn ensure(
        &self,
        slot: &Arc<Slot>,
        spec: &BackendSpec,
    ) -> Result<Arc<PluginBackend>, CallError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CallError::NotStarted(StartFailure::ShuttingDown));
        }
        let _start = slot.start.lock().await;
        {
            let state = slot
                .state
                .lock()
                .map_err(|_| CallError::NotStarted(StartFailure::Failed))?;
            if let Some(backend) = state.backend.as_ref().filter(|backend| backend.running()) {
                return Ok(Arc::clone(backend));
            }
            if state.crash_loop {
                return Err(CallError::NotStarted(StartFailure::CrashLoop));
            }
            if state.retry_at.is_some_and(|retry| Instant::now() < retry) {
                return Err(CallError::NotStarted(StartFailure::Backoff));
            }
        }
        let node = match resolve_plugin_node() {
            Ok(node) => node,
            Err(_) => {
                if let Ok(mut state) = slot.state.lock() {
                    state.node_missing = true;
                }
                self.changed();
                return Err(CallError::NotStarted(StartFailure::NodeMissing));
            }
        };
        if let Ok(mut state) = slot.state.lock() {
            state.starting = true;
            state.node_missing = false;
        }
        self.changed();
        let started = self.start(slot, spec, &node).await;
        if let Ok(mut state) = slot.state.lock() {
            state.starting = false;
        }
        self.changed();
        started
    }

    async fn start(
        &self,
        slot: &Arc<Slot>,
        spec: &BackendSpec,
        node: &std::path::Path,
    ) -> Result<Arc<PluginBackend>, CallError> {
        let _ = std::fs::create_dir_all(&spec.data_dir);
        let environment = std::env::vars_os().collect::<Vec<_>>();
        let spawned = PluginBackend::spawn(PluginBackendLaunch {
            node,
            entry: &spec.entry,
            working_dir: &spec.root,
            host_environment: &environment,
        })
        .await;
        let backend = match spawned {
            Ok(backend) => Arc::new(backend),
            Err(_) => {
                self.start_failed(slot, &spec.plugin_id);
                return Err(CallError::NotStarted(StartFailure::Failed));
            }
        };
        let permissions = spec
            .permissions
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>();
        let initialized = backend
            .request(
                "initialize",
                json!({
                    "protocol": 1,
                    "plugin": { "id": spec.plugin_id, "version": spec.version },
                    "host": { "name": "PiUI", "version": spec.piui_version },
                    "permissions": permissions,
                    "settings": spec.settings,
                    "dataDir": piui_runtime::script_runner::process_directory(&spec.data_dir).to_string_lossy(),
                }),
                INITIALIZE_TIMEOUT,
                None,
            )
            .await;
        let accepted = initialized
            .as_ref()
            .is_ok_and(|result| result.get("protocol") == Some(&json!(1)));
        if !accepted {
            backend.stop().await;
            self.start_failed(slot, &spec.plugin_id);
            return Err(CallError::NotStarted(StartFailure::Failed));
        }
        let generation = {
            let mut state = slot
                .state
                .lock()
                .map_err(|_| CallError::NotStarted(StartFailure::Failed))?;
            if state.crashed {
                state.restarts = state.restarts.saturating_add(1);
            }
            state.crashed = false;
            state.generation = state.generation.wrapping_add(1);
            state.backend = Some(Arc::clone(&backend));
            push_log(&mut state, LogEvent::BackendStarted);
            state.generation
        };
        eprintln!(
            "event=plugin_backend_started plugin_id={:?}",
            spec.plugin_id
        );
        self.watch(
            Arc::clone(slot),
            spec.plugin_id.clone(),
            generation,
            backend.exit(),
        );
        Ok(backend)
    }

    fn start_failed(&self, slot: &Arc<Slot>, plugin_id: &str) {
        if let Ok(mut state) = slot.state.lock() {
            push_log(&mut state, LogEvent::BackendStartFailed);
            crash(&mut state);
        }
        eprintln!("event=plugin_backend_start_failed plugin_id={plugin_id:?}");
    }

    fn watch(
        &self,
        slot: Arc<Slot>,
        plugin_id: String,
        generation: u64,
        mut exit: watch::Receiver<Option<BackendExit>>,
    ) {
        let notify = self.notify.lock().ok().and_then(|slot| slot.clone());
        tokio::spawn(async move {
            let reason = match exit.wait_for(Option::is_some).await {
                Ok(reason) => reason.unwrap_or(BackendExit::Stopped),
                Err(_) => BackendExit::Stopped,
            };
            if let Ok(mut state) = slot.state.lock()
                && state.generation == generation
            {
                if state
                    .backend
                    .as_ref()
                    .is_some_and(|backend| !backend.running())
                {
                    state.backend = None;
                }
                match reason {
                    BackendExit::Crashed => {
                        push_log(&mut state, LogEvent::BackendCrashed);
                        crash(&mut state);
                    }
                    BackendExit::Protocol => {
                        push_log(&mut state, LogEvent::BackendProtocol);
                        crash(&mut state);
                    }
                    BackendExit::TimedOut => push_log(&mut state, LogEvent::BackendTimeout),
                    BackendExit::Stopped | BackendExit::Cancelled => {
                        push_log(&mut state, LogEvent::BackendStopped);
                    }
                }
            }
            eprintln!("event=plugin_backend_exited plugin_id={plugin_id:?} reason={reason:?}");
            if let Some(notify) = notify {
                notify();
            }
        });
    }
}

/// Crash accounting: backoff for the next start, or a crash loop.
fn crash(state: &mut SlotState) {
    let now = Instant::now();
    state.crashed = true;
    state.consecutive = state.consecutive.saturating_add(1);
    state.crashes.push_back(now);
    while state
        .crashes
        .front()
        .is_some_and(|at| now.duration_since(*at) > CRASH_WINDOW)
    {
        state.crashes.pop_front();
    }
    if state.crashes.len() >= CRASH_LOOP_LIMIT {
        state.crash_loop = true;
        push_log(state, LogEvent::CrashLoop);
        return;
    }
    let exponent = state.consecutive.saturating_sub(1).min(6);
    let seconds = (1_u64 << exponent).min(MAX_BACKOFF_SECONDS);
    state.retry_at = Some(now + Duration::from_secs(seconds));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crashes_back_off_and_five_in_ten_minutes_are_a_loop() {
        let mut state = SlotState::default();
        crash(&mut state);
        let first = state.retry_at.expect("backoff");
        assert!(first.duration_since(Instant::now()) <= Duration::from_secs(1));
        crash(&mut state);
        crash(&mut state);
        let third = state.retry_at.expect("backoff");
        assert!(third.duration_since(Instant::now()) > Duration::from_secs(3));
        assert!(!state.crash_loop);
        crash(&mut state);
        crash(&mut state);
        assert!(state.crash_loop);
        assert_eq!(
            state.log.back().map(|entry| entry.event),
            Some(LogEvent::CrashLoop)
        );
    }
}
