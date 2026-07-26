use crate::catalog_watch::CatalogWatcher;
use piui_contracts::RuntimeId;
use piui_index::{ProjectIndex, ScanReport, TrustState};
use piui_platform::ProjectDirectory;
use piui_runtime::{FakeRuntime, FakeTransportReplay, RealPiRuntime};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const MAX_TIMELINE_CURSORS: usize = 256;
/// Weak metadata evidence cannot prove a same-stat interior rewrite forever.
/// Run a bounded full catalog reconciliation periodically while active.
const FULL_CATALOG_INTEGRITY_INTERVAL: u16 = 20;
const PERSONAL_WORKSPACE_DIRECTORY: &str = "personal-chats-workspace";
const PERSONAL_WORKSPACE_NAME: &str = "Chats";

/// Host-owned neutral Pi CWD for chats that are not attached to a user folder.
/// It is represented internally by the existing identity-bound project index,
/// but is never exposed through the user-project IPC surface or UI.
pub struct PersonalWorkspace {
    pub project_id: String,
    pub canonical_path: PathBuf,
}

/// Cloneable host-only capability required by a blocking catalog reconciliation.
/// It deliberately has no Tauri/DTO surface: cloned handles stay in trusted
/// Rust so `spawn_blocking` can move I/O off an invoke/event thread.
#[derive(Clone)]
pub struct CatalogRefreshContext {
    pub index: Arc<Mutex<ProjectIndex>>,
    refresh_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    pub session_roots: Vec<PathBuf>,
    catalog_watcher: Arc<Mutex<Option<CatalogWatcher>>>,
}

impl CatalogRefreshContext {
    pub fn refresh_gate_for(&self, project_id: &str) -> Option<Arc<Mutex<()>>> {
        refresh_gate_for_map(&self.refresh_gates, project_id)
    }

    pub fn watch_session_roots(&self, roots: &[PathBuf]) {
        watch_session_roots_with(&self.catalog_watcher, roots);
    }
}

/// Host-private pagination state. Tokens never encode filesystem paths,
/// session contents, or native identities; a restart safely invalidates them.
#[derive(Clone)]
pub struct TimelineCursorRecord {
    pub project_id: String,
    pub session_id: String,
    pub file_revision: String,
    /// Exclusive end index for the next older page.
    pub older_before: usize,
}

#[derive(Default)]
pub struct TimelineCursorStore {
    records: HashMap<String, TimelineCursorRecord>,
    insertion_order: VecDeque<String>,
}

/// Host-private freshness state for the rebuildable sidebar catalog. It is
/// deliberately separate from the Pi JSONL revision used for transcript
/// rendering and runtime mutation admission: a cached catalog can be shown
/// immediately, but can never authorize a session mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogFreshness {
    Cached,
    Refreshing,
    Current,
    Degraded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CatalogRefreshStatus {
    pub freshness: CatalogFreshness,
    /// Monotonic, host-only event/snapshot watermark. It lets the WebView
    /// discard delayed catalog events without receiving filesystem details.
    pub sequence: u64,
}

/// Internal plan issued atomically with a refresh-start transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CatalogRefreshStart {
    pub status: CatalogRefreshStatus,
    /// Forces a bounded full catalog scan rather than trusting weak unchanged
    /// evidence, repairing same-stat in-place rewrites over time.
    pub full_integrity: bool,
}

#[derive(Default)]
pub struct CatalogRefreshStore {
    next_sequence: u64,
    projects: HashMap<String, CatalogRefreshStatus>,
    successful_incremental_since_integrity: HashMap<String, u16>,
}

impl CatalogRefreshStore {
    fn advance(&mut self) -> u64 {
        self.next_sequence = self.next_sequence.wrapping_add(1).max(1);
        self.next_sequence
    }

    pub fn status(&self, project_id: &str) -> CatalogRefreshStatus {
        self.projects
            .get(project_id)
            .copied()
            .unwrap_or(CatalogRefreshStatus {
                freshness: CatalogFreshness::Cached,
                sequence: 0,
            })
    }

    /// Starts one refresh per project. A concurrent caller receives the
    /// current watermark and must use its cached snapshot instead of queuing
    /// another full filesystem walk.
    pub fn begin(&mut self, project_id: &str) -> Option<CatalogRefreshStart> {
        if self.status(project_id).freshness == CatalogFreshness::Refreshing {
            return None;
        }
        let full_integrity = self
            .successful_incremental_since_integrity
            .get(project_id)
            .copied()
            .unwrap_or_default()
            >= FULL_CATALOG_INTEGRITY_INTERVAL;
        let status = CatalogRefreshStatus {
            freshness: CatalogFreshness::Refreshing,
            sequence: self.advance(),
        };
        self.projects.insert(project_id.to_owned(), status);
        Some(CatalogRefreshStart {
            status,
            full_integrity,
        })
    }

    pub fn complete(&mut self, project_id: &str, full_integrity: bool) -> CatalogRefreshStatus {
        if full_integrity {
            self.successful_incremental_since_integrity
                .remove(project_id);
        } else {
            let count = self
                .successful_incremental_since_integrity
                .entry(project_id.to_owned())
                .or_default();
            *count = count.saturating_add(1);
        }
        let status = CatalogRefreshStatus {
            freshness: CatalogFreshness::Current,
            sequence: self.advance(),
        };
        self.projects.insert(project_id.to_owned(), status);
        status
    }

    pub fn fail(&mut self, project_id: &str) -> CatalogRefreshStatus {
        let status = CatalogRefreshStatus {
            freshness: CatalogFreshness::Degraded,
            sequence: self.advance(),
        };
        self.projects.insert(project_id.to_owned(), status);
        status
    }
}

/// One bounded semantic report backs cursor paging for the active transcript.
/// Cursor pages are immutable revision snapshots; a fresh latest-page request
/// re-observes Pi JSONL and replaces this cache.
pub struct TimelineProjectionCache {
    pub project_id: String,
    pub session_id: String,
    pub file_revision: String,
    /// Exact byte length hashed by `report`, not metadata sampled afterward.
    pub source_len: u64,
    /// Metadata from the same identity-checked scan, verified stable before return.
    pub source_modified: Option<SystemTime>,
    pub report: Arc<ScanReport>,
}

impl TimelineCursorStore {
    pub fn insert(&mut self, record: TimelineCursorRecord) -> String {
        while self.records.len() >= MAX_TIMELINE_CURSORS {
            if let Some(oldest) = self.insertion_order.pop_front() {
                self.records.remove(&oldest);
            } else {
                self.records.clear();
                break;
            }
        }
        let token = Uuid::new_v4().to_string();
        self.insertion_order.push_back(token.clone());
        self.records.insert(token.clone(), record);
        token
    }

    #[must_use]
    pub fn get(&self, token: &str) -> Option<TimelineCursorRecord> {
        self.records.get(token).cloned()
    }
}

/// Host-private baseline captured after a bounded, project-owned session
/// observation. It is detection-only: a future runtime must re-observe it
/// before every mutating RPC action and fail with a conflict on any change;
/// it is not a file lock or a merge permit.
#[derive(Clone, Eq, PartialEq)]
pub struct SessionRevisionAdmission {
    pub project_id: String,
    /// PiUI's opaque indexed session identity, not Pi's native session id.
    pub session_id: String,
    /// Host-private source path captured with the observed revision. It never
    /// crosses a DTO/event boundary or participates in Debug output.
    pub session_file: PathBuf,
    /// Pi's native id from the verified session header, when available. This
    /// lets the post-launch handshake reject a mismatched opened session.
    pub pi_session_id: Option<String>,
    pub file_revision: String,
}

impl std::fmt::Debug for SessionRevisionAdmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SessionRevisionAdmission(<redacted>)")
    }
}

pub struct FakeRuntimeSlot {
    pub runtime: FakeRuntime,
    /// Keeps the same LF decoder state across the fake runtime's lifetime so
    /// `stop_runtime` must complete the stream with a real codec EOF check.
    pub transport: FakeTransportReplay,
    /// The current fake adapter has no mutating Pi command, but retaining the
    /// admission makes the same conflict boundary explicit for its successor.
    pub admission: SessionRevisionAdmission,
    pub project_id: String,
    pub session_id: String,
}

/// Host-only callback that schedules a versioned catalog reconciliation after
/// a live runtime exits. Its implementation stays in the Tauri API layer.
pub type CatalogReconcileTrigger = Arc<dyn Fn(String) + Send + Sync>;

/// Owns one live Pi RPC process plus its event-forwarding task.
pub struct LiveRuntimeSlot {
    /// Wrapped in `Arc` so command handlers can call `&self` methods without
    /// holding the host mutex across an await boundary.
    pub runtime: Arc<RealPiRuntime>,
    pub runtime_id: RuntimeId,
    pub project_id: String,
    /// Host-only callback used to publish a sequenced catalog reconciliation
    /// after this runtime exits. It is never exposed to the WebView.
    pub catalog_reconcile: CatalogReconcileTrigger,
    /// A continued session keeps its observed baseline until PiUI's first
    /// mutation-capable command. That command revalidates it and consumes the
    /// baseline; afterward Pi itself may legitimately have appended JSONL.
    pub admission: Option<SessionRevisionAdmission>,
    pub forwarding: JoinHandle<()>,
}

/// RAII guard that serializes live-runtime start/stop transitions without
/// holding a blocking mutex across async process I/O.
pub struct LiveRuntimeTransition<'a> {
    active: &'a AtomicBool,
}

impl Drop for LiveRuntimeTransition<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

pub struct HostState {
    pub index: Arc<Mutex<ProjectIndex>>,
    pub fake_runtime: Mutex<Option<FakeRuntimeSlot>>,
    /// The single live Pi runtime; independent of the deterministic fake slot.
    pub live_runtime: Mutex<Option<LiveRuntimeSlot>>,
    /// Held for the whole async start/stop transition so two requests cannot
    /// spawn/replace overlapping Pi processes.
    live_runtime_transition_active: AtomicBool,
    /// Serializes a live command's trust/identity authorization with its RPC
    /// write. Trust revocation takes this gate before becoming observable, so
    /// an already-authorized command finishes while trusted or a later one
    /// fails before Pi receives it.
    pub live_runtime_operation_gate: AsyncMutex<()>,
    /// One bounded discovery gate per opaque project id. Different projects
    /// can reconcile independently; repeated requests for the same project
    /// cannot let an older generation sweep a newer observation.
    pub refresh_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Cache freshness/event watermarks for project and personal session
    /// catalogs. This is UI metadata only; JSONL remains authoritative.
    pub catalog_refreshes: Mutex<CatalogRefreshStore>,
    /// Host-only watcher command handle. It publishes opaque root-change hints
    /// and never gives the WebView filesystem access.
    catalog_watcher: Arc<Mutex<Option<CatalogWatcher>>>,
    pub timeline_cursors: Mutex<TimelineCursorStore>,
    pub timeline_projection_cache: Mutex<Option<TimelineProjectionCache>>,
    pub session_roots: Vec<PathBuf>,
    pub personal_workspace: PersonalWorkspace,
    /// Safe mode is selected before the WebView loads and prevents runtime use.
    pub safe_mode: bool,
}

impl HostState {
    pub fn open(app_data_dir: &Path, safe_mode: bool) -> Result<Self, std::io::Error> {
        fs::create_dir_all(app_data_dir)?;
        let database_path = app_data_dir.join("piui-foundation.sqlite");
        let mut index = ProjectIndex::open(database_path)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let personal_workspace_path = app_data_dir.join(PERSONAL_WORKSPACE_DIRECTORY);
        fs::create_dir_all(&personal_workspace_path)?;
        let personal_directory = ProjectDirectory::resolve(&personal_workspace_path)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        // This is PiUI-owned storage, not an implicitly trusted user project.
        // A replaced native directory fails closed through the existing index
        // identity/trust rules and personal runtime start will then be refused.
        let personal_workspace = index
            .register_project_directory(
                &personal_directory,
                Some(PERSONAL_WORKSPACE_NAME),
                TrustState::Trusted,
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(Self {
            index: Arc::new(Mutex::new(index)),
            fake_runtime: Mutex::new(None),
            live_runtime: Mutex::new(None),
            live_runtime_transition_active: AtomicBool::new(false),
            live_runtime_operation_gate: AsyncMutex::new(()),
            refresh_gates: Arc::new(Mutex::new(HashMap::new())),
            catalog_refreshes: Mutex::new(CatalogRefreshStore::default()),
            catalog_watcher: Arc::new(Mutex::new(None)),
            timeline_cursors: Mutex::new(TimelineCursorStore::default()),
            timeline_projection_cache: Mutex::new(None),
            session_roots: resolved_session_roots(),
            personal_workspace: PersonalWorkspace {
                project_id: personal_workspace.id,
                canonical_path: personal_directory.canonical_path().to_path_buf(),
            },
            safe_mode,
        })
    }

    /// Acquires the exclusive live-runtime transition token. The returned RAII
    /// guard resets the token on every error/early-return path.
    #[must_use]
    pub fn is_personal_workspace(&self, project_id: &str) -> bool {
        self.personal_workspace.project_id == project_id
    }

    #[must_use]
    pub fn is_personal_workspace_path(&self, directory: &ProjectDirectory) -> bool {
        directory.canonical_path() == self.personal_workspace.canonical_path
    }

    pub fn try_begin_live_runtime_transition(&self) -> Option<LiveRuntimeTransition<'_>> {
        self.live_runtime_transition_active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| LiveRuntimeTransition {
                active: &self.live_runtime_transition_active,
            })
    }

    pub fn catalog_refresh_context(&self) -> CatalogRefreshContext {
        CatalogRefreshContext {
            index: Arc::clone(&self.index),
            refresh_gates: Arc::clone(&self.refresh_gates),
            session_roots: self.session_roots.clone(),
            catalog_watcher: Arc::clone(&self.catalog_watcher),
        }
    }

    pub fn remove_refresh_gate(&self, project_id: &str) {
        if let Ok(mut gates) = self.refresh_gates.lock() {
            gates.remove(project_id);
        }
    }

    pub fn set_catalog_watcher(&self, watcher: CatalogWatcher) {
        if let Ok(mut slot) = self.catalog_watcher.lock() {
            *slot = Some(watcher);
        }
    }
}

fn refresh_gate_for_map(
    refresh_gates: &Mutex<HashMap<String, Arc<Mutex<()>>>>,
    project_id: &str,
) -> Option<Arc<Mutex<()>>> {
    let mut gates = refresh_gates.lock().ok()?;
    Some(
        gates
            .entry(project_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone(),
    )
}

fn watch_session_roots_with(catalog_watcher: &Mutex<Option<CatalogWatcher>>, roots: &[PathBuf]) {
    let watcher = catalog_watcher.lock().ok().and_then(|slot| slot.clone());
    if let Some(watcher) = watcher {
        for root in roots {
            watcher.add_root(root.clone());
        }
    }
}

/// Resolves only a session-root hint. It neither parses Pi config nor reads
/// auth files; the scanner later considers only bounded `.jsonl` candidates.
///
/// Pi gives `PI_CODING_AGENT_SESSION_DIR` precedence over its default
/// `PI_CODING_AGENT_DIR/sessions` tree, so mirror that documented environment
/// override here. Project/global `settings.json` overrides remain deliberately
/// out of scope until Pi offers a safe discovery contract for them.
fn resolved_session_roots() -> Vec<PathBuf> {
    session_roots_from(
        std::env::var_os("PI_CODING_AGENT_SESSION_DIR").map(PathBuf::from),
        std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from),
        home_directory(),
    )
}

fn session_roots_from(
    session_dir: Option<PathBuf>,
    agent_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    if let Some(session_dir) = session_dir {
        return vec![session_dir];
    }

    agent_dir
        .or_else(|| home_dir.map(|home| home.join(".pi").join("agent")))
        .map(|directory| vec![directory.join("sessions")])
        .unwrap_or_default()
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::{
        CatalogFreshness, CatalogRefreshStore, FULL_CATALOG_INTEGRITY_INTERVAL, HostState,
        PERSONAL_WORKSPACE_DIRECTORY, session_roots_from,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn catalog_refresh_status_coalesces_and_monotonically_advances() {
        let mut store = CatalogRefreshStore::default();
        assert_eq!(store.status("project").freshness, CatalogFreshness::Cached);
        let started = store.begin("project").expect("starts first refresh");
        assert_eq!(started.status.freshness, CatalogFreshness::Refreshing);
        assert!(!started.full_integrity);
        assert!(store.begin("project").is_none());
        let complete = store.complete("project", started.full_integrity);
        assert_eq!(complete.freshness, CatalogFreshness::Current);
        assert!(complete.sequence > started.status.sequence);
        let failed = store.fail("project");
        assert_eq!(failed.freshness, CatalogFreshness::Degraded);
        assert!(failed.sequence > complete.sequence);
    }

    #[test]
    fn incomplete_catalog_passes_do_not_count_toward_integrity_interval() {
        let mut store = CatalogRefreshStore::default();
        for _ in 0..=FULL_CATALOG_INTEGRITY_INTERVAL {
            let started = store.begin("project").expect("starts refresh");
            assert!(!started.full_integrity);
            store.fail("project");
        }
    }

    #[test]
    fn periodic_catalog_integrity_scan_is_forced_after_incremental_refreshes() {
        let mut store = CatalogRefreshStore::default();
        for _ in 0..FULL_CATALOG_INTEGRITY_INTERVAL {
            let started = store.begin("project").expect("starts refresh");
            assert!(!started.full_integrity);
            store.complete("project", false);
        }
        let integrity = store.begin("project").expect("starts integrity refresh");
        assert!(integrity.full_integrity);
        store.complete("project", true);
        assert!(
            !store
                .begin("project")
                .expect("resets counter")
                .full_integrity
        );
    }

    #[test]
    fn project_refresh_gates_are_isolated_and_removable() {
        let root = std::env::temp_dir().join(format!("piui-refresh-gates-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = HostState::open(&root, false).expect("opens isolated state");
        let refresh_context = state.catalog_refresh_context();
        let first = refresh_context
            .refresh_gate_for("first")
            .expect("creates first gate");
        let first_again = refresh_context
            .refresh_gate_for("first")
            .expect("reuses first gate");
        let second = refresh_context
            .refresh_gate_for("second")
            .expect("creates second gate");
        assert!(std::sync::Arc::ptr_eq(&first, &first_again));
        assert!(!std::sync::Arc::ptr_eq(&first, &second));
        state.remove_refresh_gate("first");
        let replacement = refresh_context
            .refresh_gate_for("first")
            .expect("recreates removed gate");
        assert!(!std::sync::Arc::ptr_eq(&first, &replacement));
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_pi_session_directory_takes_precedence_over_agent_directory() {
        let session_dir = PathBuf::from("C:/pi/custom-sessions");
        let roots = session_roots_from(
            Some(session_dir.clone()),
            Some(PathBuf::from("C:/pi/agent")),
            Some(PathBuf::from("C:/fixture/home")),
        );

        assert_eq!(roots, vec![session_dir]);
    }

    #[test]
    fn default_session_directory_uses_the_pi_agent_sessions_tree() {
        let roots = session_roots_from(
            None,
            Some(PathBuf::from("C:/pi/agent")),
            Some(PathBuf::from("C:/fixture/home")),
        );

        assert_eq!(roots, vec![PathBuf::from("C:/pi/agent/sessions")]);
    }

    #[test]
    fn safe_mode_is_selected_before_host_state_is_exposed() {
        let root = std::env::temp_dir().join(format!("piui-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = HostState::open(&root, true).expect("opens isolated state");
        assert!(state.safe_mode);
        assert!(
            state
                .fake_runtime
                .lock()
                .expect("locks fake slot")
                .is_none()
        );
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn personal_workspace_is_host_owned_and_stable_across_reopen() {
        let root =
            std::env::temp_dir().join(format!("piui-personal-workspace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = HostState::open(&root, false).expect("opens isolated state");
        let first_id = first.personal_workspace.project_id.clone();
        assert!(root.join(PERSONAL_WORKSPACE_DIRECTORY).is_dir());
        assert!(first.is_personal_workspace(&first_id));
        assert!(
            first
                .index
                .lock()
                .expect("locks index")
                .list_projects()
                .expect("lists projects")
                .iter()
                .any(|project| project.id == first_id && project.name == "Chats")
        );
        drop(first);

        let second = HostState::open(&root, false).expect("reopens isolated state");
        assert_eq!(second.personal_workspace.project_id, first_id);
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn live_runtime_operation_gate_is_exclusive() {
        let root =
            std::env::temp_dir().join(format!("piui-state-operation-gate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = HostState::open(&root, false).expect("opens isolated state");
        let guard = state.live_runtime_operation_gate.lock().await;
        assert!(state.live_runtime_operation_gate.try_lock().is_err());
        drop(guard);
        assert!(state.live_runtime_operation_gate.try_lock().is_ok());
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn live_runtime_transition_is_exclusive_and_released_by_drop() {
        let root =
            std::env::temp_dir().join(format!("piui-state-transition-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = HostState::open(&root, false).expect("opens isolated state");
        let transition = state
            .try_begin_live_runtime_transition()
            .expect("acquires first transition");
        assert!(state.try_begin_live_runtime_transition().is_none());
        drop(transition);
        assert!(state.try_begin_live_runtime_transition().is_some());
        drop(state);
        let _ = fs::remove_dir_all(root);
    }
}
