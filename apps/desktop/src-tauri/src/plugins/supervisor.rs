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
//!
//! Every backend runs under Node's permission model: it reads its package,
//! reads and writes its data folder, and reaches a project folder only when
//! it asks for `project.read` / `project.write` and a request for that
//! project arrives. A backend started for other projects is restarted, when
//! idle, with the new folder added; a busy one is not interrupted and the
//! request is refused before anything is sent. Node.js without the
//! permission model (older than 22.13) does not start backends at all.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piui_plugins::Permission;
use piui_runtime::plugin_backend::{
    BackendExit, BackendGrants, NodePermissionSupport, PluginBackend, PluginBackendError,
    PluginBackendLaunch, permission_arguments, probe_node_permissions, resolve_plugin_node,
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
    /// Node.js has no permission model, so PiUI does not start the backend.
    Unsupported,
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

impl BackendSpec {
    fn has(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    /// The backend may be given project folders.
    pub fn project_access(&self) -> bool {
        self.has(Permission::ProjectRead) || self.has(Permission::ProjectWrite)
    }

    /// What Node's permission model lets this backend reach, with the
    /// project folders it was given.
    pub fn grants(&self, projects: &[PathBuf]) -> BackendGrants {
        let projects = if self.project_access() {
            projects.to_vec()
        } else {
            Vec::new()
        };
        let mut read = vec![self.root.clone(), self.data_dir.clone()];
        read.extend(projects.iter().cloned());
        let mut write = vec![self.data_dir.clone()];
        if self.has(Permission::ProjectWrite) {
            write.extend(projects);
        }
        BackendGrants {
            read,
            write,
            network: self.has(Permission::Network),
        }
    }
}

/// Why a backend could not take a request; in every case nothing was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartFailure {
    NodeMissing,
    /// Node.js is too old to limit the backend.
    NodeUnsupported,
    /// The running backend works for other projects and is busy.
    Busy,
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
    node_unsupported: bool,
    /// Project folders the running backend was started with.
    projects: Vec<PathBuf>,
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
        } else if state.node_unsupported {
            BackendState::Unsupported
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
            state.node_unsupported = false;
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

    /// Sends one request, starting the backend first when needed. `project`
    /// is the folder the request works in (only with a project permission,
    /// spelled exactly as the request parameters spell it).
    pub async fn call(
        &self,
        spec: &BackendSpec,
        project: Option<&Path>,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Value, CallError> {
        let slot = self
            .slot(&spec.plugin_id)
            .ok_or(CallError::NotStarted(StartFailure::Failed))?;
        let project = project.filter(|_| spec.project_access());
        let backend = self.ensure(&slot, spec, project).await?;
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
        project: Option<&Path>,
    ) -> Result<Arc<PluginBackend>, CallError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CallError::NotStarted(StartFailure::ShuttingDown));
        }
        let _start = slot.start.lock().await;
        let mut projects = Vec::new();
        let replaced = {
            let mut state = slot
                .state
                .lock()
                .map_err(|_| CallError::NotStarted(StartFailure::Failed))?;
            let running = state
                .backend
                .as_ref()
                .filter(|backend| backend.running())
                .cloned();
            match running {
                Some(backend)
                    if project.is_none_or(|project| {
                        state.projects.iter().any(|granted| granted == project)
                    }) =>
                {
                    return Ok(backend);
                }
                // Started for other projects and still working: never
                // interrupt it; nothing is sent.
                Some(backend) if backend.pending_requests() > 0 => {
                    return Err(CallError::NotStarted(StartFailure::Busy));
                }
                Some(_) => {
                    projects.clone_from(&state.projects);
                    state.backend.take()
                }
                None => None,
            }
        };
        if let Some(project) = project
            && !projects.iter().any(|granted| granted == project)
        {
            projects.push(project.to_path_buf());
        }
        if let Some(backend) = replaced {
            backend.shutdown(SHUTDOWN_GRACE).await;
        }
        {
            let state = slot
                .state
                .lock()
                .map_err(|_| CallError::NotStarted(StartFailure::Failed))?;
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
        let probe = node.clone();
        let support = match tauri::async_runtime::spawn_blocking(move || {
            probe_node_permissions(&probe)
        })
        .await
        {
            Ok(Ok(support)) => support,
            _ => {
                if let Ok(mut state) = slot.state.lock() {
                    state.node_missing = true;
                }
                self.changed();
                return Err(CallError::NotStarted(StartFailure::NodeMissing));
            }
        };
        if !support.permission {
            if let Ok(mut state) = slot.state.lock() {
                state.node_missing = false;
                state.node_unsupported = true;
            }
            eprintln!(
                "event=plugin_backend_unsupported_node plugin_id={:?}",
                spec.plugin_id
            );
            self.changed();
            return Err(CallError::NotStarted(StartFailure::NodeUnsupported));
        }
        if let Ok(mut state) = slot.state.lock() {
            state.starting = true;
            state.node_missing = false;
            state.node_unsupported = false;
        }
        self.changed();
        let started = self.start(slot, spec, &node, &support, projects).await;
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
        node: &Path,
        support: &NodePermissionSupport,
        projects: Vec<PathBuf>,
    ) -> Result<Arc<PluginBackend>, CallError> {
        let _ = std::fs::create_dir_all(&spec.data_dir);
        let Ok(permissions) = permission_arguments(support, &spec.grants(&projects)) else {
            self.start_failed(slot, &spec.plugin_id);
            return Err(CallError::NotStarted(StartFailure::Failed));
        };
        let environment = std::env::vars_os().collect::<Vec<_>>();
        let spawned = PluginBackend::spawn(PluginBackendLaunch {
            node,
            entry: &spec.entry,
            working_dir: &spec.root,
            host_environment: &environment,
            permissions: Some(&permissions),
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
            state.projects = projects;
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

    /// Reads `secret.txt` in the project it is given; `hang` never answers.
    const PROJECT_PLUGIN: &str = r#"
import { readFileSync } from 'node:fs';
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') { send({ jsonrpc: '2.0', id, result: { protocol: 1 } }); continue; }
    if (method === 'hang') continue;
    if (method === 'shutdown') { send({ jsonrpc: '2.0', id, result: {} }); setTimeout(() => process.exit(0), 10); continue; }
    let result;
    try { result = readFileSync(params.path + '/secret.txt', 'utf8'); } catch (error) { result = error.code; }
    send({ jsonrpc: '2.0', id, result });
  }
});
"#;

    struct Folders {
        root: PathBuf,
    }

    impl Drop for Folders {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn spec(root: &Path, permissions: Vec<Permission>) -> BackendSpec {
        BackendSpec {
            plugin_id: "example.projects".into(),
            version: "1.0.0".into(),
            root: root.join("package"),
            entry: root.join("package").join("main.mjs"),
            permissions,
            settings: Map::new(),
            data_dir: root.join("data"),
            piui_version: "0.2.2".into(),
        }
    }

    #[test]
    fn grants_follow_the_project_permissions() {
        let root = std::env::temp_dir();
        let project = root.join("project");
        let none = spec(&root, vec![Permission::Commands, Permission::Network])
            .grants(std::slice::from_ref(&project));
        assert_eq!(none.read, vec![root.join("package"), root.join("data")]);
        assert_eq!(none.write, vec![root.join("data")]);
        assert!(none.network);
        let read =
            spec(&root, vec![Permission::ProjectRead]).grants(std::slice::from_ref(&project));
        assert!(read.read.contains(&project) && !read.write.contains(&project));
        assert!(!read.network);
        let write =
            spec(&root, vec![Permission::ProjectWrite]).grants(std::slice::from_ref(&project));
        assert!(write.read.contains(&project) && write.write.contains(&project));
    }

    #[tokio::test]
    async fn a_backend_reaches_only_the_projects_it_was_given() {
        let node = resolve_plugin_node().expect("Node.js is installed for plugin tests");
        if !probe_node_permissions(&node).expect("probe").permission {
            eprintln!("skipped: this Node.js has no permission model");
            return;
        }
        let root = std::fs::canonicalize(std::env::temp_dir())
            .expect("temp")
            .join(format!("piui-plugin-projects-{}", uuid::Uuid::new_v4()));
        let folders = Folders { root: root.clone() };
        for name in ["package", "data", "first", "second"] {
            std::fs::create_dir_all(root.join(name)).expect("folder");
        }
        std::fs::write(root.join("package").join("main.mjs"), PROJECT_PLUGIN).expect("plugin");
        std::fs::write(root.join("first").join("secret.txt"), "first").expect("secret");
        std::fs::write(root.join("second").join("secret.txt"), "second").expect("secret");
        let path = |name: &str| piui_runtime::script_runner::process_directory(&root.join(name));
        let supervisor = Supervisor::new();
        let reader = spec(&root, vec![Permission::Commands, Permission::ProjectRead]);
        let read = |project: Option<PathBuf>, target: &str| {
            let params = json!({ "path": path(target).to_string_lossy() });
            let supervisor = &supervisor;
            let reader = &reader;
            async move {
                supervisor
                    .call(
                        reader,
                        project.as_deref(),
                        "read",
                        params,
                        Duration::from_secs(15),
                        None,
                    )
                    .await
            }
        };
        assert_eq!(read(Some(path("first")), "first").await, Ok(json!("first")));
        // A project it was not given in this request's start stays closed.
        assert_eq!(read(None, "second").await, Ok(json!("ERR_ACCESS_DENIED")));
        // A request for another project restarts the idle backend with it.
        assert_eq!(
            read(Some(path("second")), "second").await,
            Ok(json!("second"))
        );
        assert_eq!(read(None, "first").await, Ok(json!("first")));
        let (_, _, log) = supervisor.status("example.projects");
        assert_eq!(
            log.iter()
                .filter(|entry| entry.event == LogEvent::BackendStarted)
                .count(),
            2
        );

        // A busy backend is never interrupted for another project.
        let third = root.join("third");
        std::fs::create_dir_all(&third).expect("folder");
        let (cancel, cancelled) = watch::channel(false);
        let hanging = supervisor.call(
            &reader,
            None,
            "hang",
            json!({}),
            Duration::from_secs(30),
            Some(cancelled),
        );
        let busy = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let refused = supervisor
                .call(
                    &reader,
                    Some(&path("third")),
                    "read",
                    json!({ "path": path("third").to_string_lossy() }),
                    Duration::from_secs(15),
                    None,
                )
                .await;
            let _ = cancel.send(true);
            refused
        };
        let (hung, refused) = tokio::join!(hanging, busy);
        assert_eq!(refused, Err(CallError::NotStarted(StartFailure::Busy)));
        assert_eq!(hung, Err(CallError::Cancelled));

        // Without a project permission no project folder is ever granted.
        let blind = BackendSpec {
            plugin_id: "example.blind".into(),
            ..spec(&root, vec![Permission::Commands])
        };
        let answer = supervisor
            .call(
                &blind,
                Some(&path("first")),
                "read",
                json!({ "path": path("first").to_string_lossy() }),
                Duration::from_secs(15),
                None,
            )
            .await;
        assert_eq!(answer, Ok(json!("ERR_ACCESS_DENIED")));
        supervisor.shutdown_all();
        drop(folders);
    }

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
