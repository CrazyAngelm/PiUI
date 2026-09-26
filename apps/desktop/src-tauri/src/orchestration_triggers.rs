//! Event automations (host v7.2): "when a pipeline finishes" and "when files
//! change".
//!
//! The host observes committed orchestration generations and project folder
//! changes, decides which enabled event rules fire, and claims each firing
//! through `OrchestrationApiState::claim_event_occurrence`, which records the
//! outcome and creates the run in one durable generation. Native execution
//! then goes through the ordinary scheduler. Nothing here runs a model or a
//! tool, and safe mode never starts this engine.
//!
//! Loop protection has three layers: a run started by a rule never re-fires
//! that rule through its own file changes (changes are ignored while it runs
//! and briefly after); every event run records its chain depth and a firing
//! beyond `MAX_TRIGGER_CHAIN_DEPTH` is recorded as skipped; and one rule
//! starts at most one run per `EVENT_COOLDOWN_SECONDS`.

use crate::api::verified_project_directory;
use crate::automation_paths::{PathPattern, parse_patterns, platform_folds_case};
use crate::orchestration_api::{
    OrchestrationApiState, emit_run_changed, emit_schedule_changed, validate_live_workspace_scope,
};
use crate::orchestration_schedule::{EventTrigger, FinishedOutcome};
use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::orchestration_store::StoreSnapshot;
use crate::state::HostState;
use chrono::{DateTime, Utc};
use piui_orchestration::{Run, RunStatus};
use piui_platform::{ChangeBatch, ProjectWatch, watch_project};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Notify;

/// One automation starts at most one run in this many seconds.
pub(crate) const EVENT_COOLDOWN_SECONDS: i64 = 30;
/// Burst window of the platform watcher before batches reach the rules.
const WATCH_COALESCE: Duration = Duration::from_millis(300);
/// Changes this soon after a rule's own run ended are still its own.
const SELF_CHANGE_GRACE: Duration = Duration::from_secs(3);
/// A change this soon after any run ended counts as caused by that run.
const ATTRIBUTION_GRACE: Duration = Duration::from_secs(10);
/// Finished runs are forgotten for attribution after this long.
const RECENT_RUN_RETENTION: Duration = Duration::from_secs(3_600);

/// What an event rule reacted to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EventCause {
    RunFinished { source_run_id: String },
    FilesChanged,
}

/// One firing, claimed durably by the orchestration API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EventFiring {
    pub workspace_id: String,
    pub schedule_id: String,
    pub trigger_revision: u64,
    pub cause: EventCause,
    /// When the host observed the event (the nominal time of the record).
    pub observed_at: DateTime<Utc>,
    /// Event hops the started run would have.
    pub chain_depth: u8,
}

impl EventFiring {
    /// Stable per cause: a repeated observation of the same finished run or
    /// file burst maps to the same occurrence.
    pub(crate) fn cause_key(&self) -> String {
        match &self.cause {
            EventCause::RunFinished { source_run_id } => format!("run:{source_run_id}"),
            EventCause::FilesChanged => format!("files:{}", self.observed_at.timestamp_millis()),
        }
    }
}

type RunKey = (String, String);
type RuleKey = (String, String);

/// A run that was active while this host ran, for attribution and for
/// ignoring a rule's own file changes.
#[derive(Clone, Debug)]
struct RecentRun {
    depth: u8,
    automation: Option<String>,
    active: bool,
    finished_at: Option<Instant>,
}

#[derive(Clone, Copy, Debug)]
struct Burst {
    first: Instant,
    last: Instant,
    last_wall: DateTime<Utc>,
}

/// An enabled "files changed" rule and its pending burst.
#[derive(Clone, Debug)]
struct FileRule {
    trigger_revision: u64,
    include: Vec<PathPattern>,
    exclude: Vec<PathPattern>,
    debounce: Duration,
    /// No firing before this wall time (cooldown after the last record).
    not_before: Option<DateTime<Utc>>,
    burst: Option<Burst>,
}

impl FileRule {
    fn matches(&self, path: &str, fold_case: bool) -> bool {
        self.include
            .iter()
            .any(|pattern| pattern.matches(path, fold_case))
            && !self
                .exclude
                .iter()
                .any(|pattern| pattern.matches(path, fold_case))
    }

    /// Quiet period, bounded so a folder that never stops changing still fires.
    fn due_at(&self, burst: &Burst) -> Instant {
        let longest = (self.debounce * 10).min(self.debounce.max(Duration::from_secs(3_600)));
        (burst.last + self.debounce).min(burst.first + longest)
    }
}

fn outcome(status: RunStatus) -> Option<FinishedOutcome> {
    match status {
        RunStatus::Succeeded => Some(FinishedOutcome::Succeeded),
        RunStatus::Failed => Some(FinishedOutcome::Failed),
        RunStatus::Cancelled => Some(FinishedOutcome::Cancelled),
        RunStatus::Running | RunStatus::Uncertain => None,
    }
}

fn is_active(status: RunStatus) -> bool {
    matches!(status, RunStatus::Running | RunStatus::Uncertain)
}

/// Pure decision state of the engine. It never touches Tauri, the file
/// system or the clock, so every rule is testable with fixed instants.
pub(crate) struct TriggerCore {
    known: HashMap<RunKey, RunStatus>,
    recent: HashMap<RunKey, RecentRun>,
    rules: HashMap<RuleKey, FileRule>,
    paused: bool,
    fold_case: bool,
}

impl TriggerCore {
    /// Seeds the runs that already exist: they finished (or will finish)
    /// independently of anything this host observes from now on.
    pub(crate) fn new(snapshot: &StoreSnapshot, wall: DateTime<Utc>) -> Self {
        let mut core = Self {
            known: HashMap::new(),
            recent: HashMap::new(),
            rules: HashMap::new(),
            paused: snapshot.automations_paused(),
            fold_case: platform_folds_case(),
        };
        for workspace in snapshot.workspaces() {
            for run in &workspace.runs {
                let key = (workspace.workspace_id.clone(), run.id().to_owned());
                core.known.insert(key.clone(), run.status());
                if is_active(run.status()) {
                    core.recent.insert(key, recent_run(run, true, None));
                }
            }
        }
        core.sync_rules(snapshot, wall);
        core
    }

    #[cfg(test)]
    fn with_fold_case(mut self, fold_case: bool) -> Self {
        self.fold_case = fold_case;
        self
    }

    /// Observes a committed generation. Returns the "pipeline finished"
    /// firings for runs that became terminal since the last observation.
    pub(crate) fn observe(
        &mut self,
        snapshot: &StoreSnapshot,
        now: Instant,
        wall: DateTime<Utc>,
    ) -> Vec<EventFiring> {
        self.paused = snapshot.automations_paused();
        let mut firings = Vec::new();
        for workspace in snapshot.workspaces() {
            for run in &workspace.runs {
                let key = (workspace.workspace_id.clone(), run.id().to_owned());
                let status = run.status();
                let previous = self.known.insert(key.clone(), status);
                if is_active(status) {
                    self.recent
                        .entry(key)
                        .and_modify(|recent| {
                            recent.active = true;
                            recent.finished_at = None;
                        })
                        .or_insert_with(|| recent_run(run, true, None));
                    continue;
                }
                // A run created and finished between two observations is
                // new too; one already terminal before stays quiet.
                let newly_finished = previous.is_none_or(is_active);
                if !newly_finished {
                    continue;
                }
                self.recent.insert(key, recent_run(run, false, Some(now)));
                if let Some(outcome) = outcome(status) {
                    firings.extend(finished_firings(workspace, run, outcome, wall));
                }
            }
        }
        self.recent.retain(|_, recent| {
            recent.active
                || recent.finished_at.is_some_and(|finished| {
                    now.saturating_duration_since(finished) < RECENT_RUN_RETENTION
                })
        });
        self.sync_rules(snapshot, wall);
        firings
    }

    /// Keeps one entry per enabled "files changed" rule; an edited rule
    /// (new trigger revision) starts over without its pending burst.
    fn sync_rules(&mut self, snapshot: &StoreSnapshot, wall: DateTime<Utc>) {
        let mut present = HashSet::new();
        for workspace in snapshot.workspaces() {
            for schedule in &workspace.schedules {
                let Some(EventTrigger::FilesChanged {
                    include,
                    exclude,
                    debounce_seconds,
                }) = schedule.value.trigger.event()
                else {
                    continue;
                };
                if !schedule.enabled {
                    continue;
                }
                let key = (workspace.workspace_id.clone(), schedule.value.id.clone());
                // Every record, including a skip or failure, delays the next
                // firing: a folder that keeps changing coalesces instead.
                let not_before = schedule.occurrences.last().map(|last| {
                    last.recorded_at + chrono::Duration::seconds(EVENT_COOLDOWN_SECONDS)
                });
                if let Some(rule) = self.rules.get_mut(&key)
                    && rule.trigger_revision == schedule.trigger_revision
                {
                    rule.not_before = rule.not_before.max(not_before);
                    present.insert(key);
                    continue;
                }
                let (Ok(include), Ok(exclude)) = (parse_patterns(include), parse_patterns(exclude))
                else {
                    continue;
                };
                self.rules.insert(
                    key.clone(),
                    FileRule {
                        trigger_revision: schedule.trigger_revision,
                        include,
                        exclude,
                        debounce: Duration::from_secs(u64::from(*debounce_seconds)),
                        not_before: not_before.filter(|until| *until > wall),
                        burst: None,
                    },
                );
                present.insert(key);
            }
        }
        self.rules.retain(|key, _| present.contains(key));
    }

    /// Workspaces whose folders need watching now. Paused automations watch
    /// nothing.
    pub(crate) fn watched_workspaces(&self) -> BTreeSet<String> {
        if self.paused {
            return BTreeSet::new();
        }
        self.rules
            .keys()
            .map(|(workspace, _)| workspace.clone())
            .collect()
    }

    fn own_run_recent(&self, workspace_id: &str, schedule_id: &str, now: Instant) -> bool {
        self.recent.iter().any(|((workspace, _), recent)| {
            workspace == workspace_id
                && recent.automation.as_deref() == Some(schedule_id)
                && (recent.active
                    || recent.finished_at.is_some_and(|finished| {
                        now.saturating_duration_since(finished) < SELF_CHANGE_GRACE
                    }))
        })
    }

    /// Records a batch of changed paths from one project folder. Batches
    /// that only report lost events carry no paths and are never guessed at.
    pub(crate) fn file_changes(
        &mut self,
        workspace_id: &str,
        batch: &ChangeBatch,
        now: Instant,
        wall: DateTime<Utc>,
    ) {
        if self.paused || batch.paths.is_empty() {
            return;
        }
        let keys: Vec<RuleKey> = self
            .rules
            .keys()
            .filter(|(workspace, _)| workspace == workspace_id)
            .cloned()
            .collect();
        for key in keys {
            // A rule's own run changing files must not start it again.
            if self.own_run_recent(&key.0, &key.1, now) {
                continue;
            }
            let fold_case = self.fold_case;
            let Some(rule) = self.rules.get_mut(&key) else {
                continue;
            };
            if !batch.paths.iter().any(|path| rule.matches(path, fold_case)) {
                continue;
            }
            let burst = rule.burst.get_or_insert(Burst {
                first: now,
                last: now,
                last_wall: wall,
            });
            burst.last = now;
            burst.last_wall = wall;
        }
    }

    /// The chain depth of a file firing: one hop more than the deepest run
    /// that was active during the burst or ended shortly before it.
    fn attributed_depth(&self, workspace_id: &str, burst: &Burst) -> u8 {
        self.recent
            .iter()
            .filter(|((workspace, _), recent)| {
                workspace == workspace_id
                    && (recent.active
                        || recent
                            .finished_at
                            .is_some_and(|finished| finished + ATTRIBUTION_GRACE >= burst.first))
            })
            .map(|(_, recent)| recent.depth)
            .max()
            .map_or(1, |depth| depth.saturating_add(1))
    }

    /// Firings whose quiet period (and cooldown) has passed.
    pub(crate) fn due(&mut self, now: Instant, wall: DateTime<Utc>) -> Vec<EventFiring> {
        if self.paused {
            for rule in self.rules.values_mut() {
                rule.burst = None;
            }
            return Vec::new();
        }
        let mut firings = Vec::new();
        let keys: Vec<RuleKey> = self.rules.keys().cloned().collect();
        for key in keys {
            let Some(rule) = self.rules.get(&key) else {
                continue;
            };
            let Some(burst) = rule.burst else {
                continue;
            };
            if now < rule.due_at(&burst) || rule.not_before.is_some_and(|until| wall < until) {
                continue;
            }
            let own = self.own_run_recent(&key.0, &key.1, now);
            let depth = self.attributed_depth(&key.0, &burst);
            let trigger_revision = rule.trigger_revision;
            if let Some(rule) = self.rules.get_mut(&key) {
                rule.burst = None;
                rule.not_before = Some(wall + chrono::Duration::seconds(EVENT_COOLDOWN_SECONDS));
            }
            if own {
                continue;
            }
            firings.push(EventFiring {
                workspace_id: key.0.clone(),
                schedule_id: key.1.clone(),
                trigger_revision,
                cause: EventCause::FilesChanged,
                observed_at: burst.last_wall,
                chain_depth: depth,
            });
        }
        firings
    }

    /// When `due` should run next, if any burst is pending.
    pub(crate) fn next_deadline(&self, now: Instant, wall: DateTime<Utc>) -> Option<Instant> {
        if self.paused {
            return None;
        }
        self.rules
            .values()
            .filter_map(|rule| {
                let burst = rule.burst?;
                let cooldown = rule
                    .not_before
                    .and_then(|until| (until - wall).to_std().ok())
                    .map_or(now, |remaining| now + remaining);
                Some(rule.due_at(&burst).max(cooldown))
            })
            .min()
    }
}

fn recent_run(run: &Run, active: bool, finished_at: Option<Instant>) -> RecentRun {
    RecentRun {
        depth: run.chain_depth(),
        automation: run
            .trigger()
            .and_then(|trigger| trigger.schedule_id())
            .map(str::to_owned),
        active,
        finished_at,
    }
}

/// "Pipeline finished" rules in the run's workspace that watch its launch
/// command and the outcome it ended with.
fn finished_firings(
    workspace: &crate::orchestration_store::WorkspaceOrchestration,
    run: &Run,
    outcome: FinishedOutcome,
    wall: DateTime<Utc>,
) -> Vec<EventFiring> {
    let Some(source) = run.definition().launch_command.as_ref() else {
        return Vec::new();
    };
    workspace
        .schedules
        .iter()
        .filter(|schedule| schedule.enabled)
        .filter_map(|schedule| match schedule.value.trigger.event() {
            Some(EventTrigger::RunFinished {
                launch_command_id,
                outcomes,
            }) if *launch_command_id == source.id && outcomes.contains(&outcome) => {
                Some(EventFiring {
                    workspace_id: workspace.workspace_id.clone(),
                    schedule_id: schedule.value.id.clone(),
                    trigger_revision: schedule.trigger_revision,
                    cause: EventCause::RunFinished {
                        source_run_id: run.id().to_owned(),
                    },
                    observed_at: wall,
                    chain_depth: run.chain_depth().saturating_add(1),
                })
            }
            _ => None,
        })
        .collect()
}

#[derive(Default)]
struct EngineInner {
    started: AtomicBool,
    stopping: AtomicBool,
    stop: Notify,
}

/// Managed Tauri state that drives `TriggerCore` from committed generations,
/// project watchers and its own timer.
#[derive(Clone, Default)]
pub(crate) struct TriggerEngine {
    inner: Arc<EngineInner>,
}

impl TriggerEngine {
    pub(crate) fn start<R: Runtime>(&self, app: AppHandle<R>) {
        if self
            .inner
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let engine = self.clone();
        let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move { engine.run(app).await });
        std::mem::drop(tauri::async_runtime::spawn(future));
    }

    /// Stops observing; watchers end with the loop.
    pub(crate) fn begin_shutdown(&self) {
        self.inner.stopping.store(true, Ordering::Release);
        self.inner.stop.notify_one();
    }

    fn stopping(&self) -> bool {
        self.inner.stopping.load(Ordering::Acquire)
    }

    async fn run<R: Runtime>(&self, app: AppHandle<R>) {
        let Some(api) = app.try_state::<OrchestrationApiState>() else {
            return;
        };
        let Ok(snapshot) = api.snapshot() else {
            eprintln!("event=automation_events_unavailable");
            return;
        };
        let mut commits = api.subscribe_commits();
        let mut core = TriggerCore::new(&snapshot, Utc::now());
        let (sender, mut receiver) =
            tokio::sync::mpsc::unbounded_channel::<(String, ChangeBatch)>();
        let mut watches = Watches::new(&app);
        watches.reconcile(&app, &core, &sender);
        loop {
            if self.stopping() {
                break;
            }
            let deadline = core
                .next_deadline(Instant::now(), Utc::now())
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(3_600));
            let firings = tokio::select! {
                changed = commits.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    match api.snapshot() {
                        Ok(snapshot) => {
                            let firings = core.observe(&snapshot, Instant::now(), Utc::now());
                            watches.reconcile(&app, &core, &sender);
                            firings
                        }
                        Err(_) => Vec::new(),
                    }
                }
                Some((workspace, batch)) = receiver.recv() => {
                    core.file_changes(&workspace, &batch, Instant::now(), Utc::now());
                    Vec::new()
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    core.due(Instant::now(), Utc::now())
                }
                _ = self.inner.stop.notified() => break,
            };
            for firing in firings {
                if self.stopping() {
                    break;
                }
                fire(&app, &firing).await;
            }
        }
    }
}

/// Claims one firing under the live-runtime gate, then hands a started run
/// to the ordinary scheduler.
async fn fire<R: Runtime>(app: &AppHandle<R>, firing: &EventFiring) {
    let claim = {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        let admission_failure = validate_live_workspace_scope(&host, &firing.workspace_id)
            .err()
            .map(|error| error.code);
        app.state::<OrchestrationApiState>().claim_event_occurrence(
            firing,
            Utc::now(),
            admission_failure,
        )
    };
    let claim = match claim {
        Ok(Some(claim)) => claim,
        Ok(None) => return,
        Err(error) => {
            eprintln!("event=automation_event_claim_failed code={}", error.code);
            return;
        }
    };
    emit_schedule_changed(
        app,
        &firing.workspace_id,
        &firing.schedule_id,
        claim.schedule.revision,
    );
    if let Some(run) = claim.run {
        emit_run_changed(app, &firing.workspace_id, &run);
        let scheduler = app.state::<OrchestrationScheduler>();
        if scheduler.accepts_work() {
            scheduler.spawn_reschedule(
                app.clone(),
                firing.workspace_id.clone(),
                run.id().to_owned(),
            );
        }
    }
}

/// Live project watches, one per workspace with an enabled file rule.
struct Watches {
    active: HashMap<String, ProjectWatch>,
    unavailable: HashSet<String>,
    ignored: Vec<PathBuf>,
}

impl Watches {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        // A project that contains PiUI's own data must not watch it.
        let ignored = app
            .path()
            .app_data_dir()
            .ok()
            .and_then(|path| std::fs::canonicalize(path).ok())
            .into_iter()
            .collect();
        Self {
            active: HashMap::new(),
            unavailable: HashSet::new(),
            ignored,
        }
    }

    fn reconcile<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        core: &TriggerCore,
        sender: &tokio::sync::mpsc::UnboundedSender<(String, ChangeBatch)>,
    ) {
        let wanted = core.watched_workspaces();
        self.active
            .retain(|workspace, _| wanted.contains(workspace));
        self.unavailable
            .retain(|workspace| wanted.contains(workspace));
        for workspace in wanted {
            if self.active.contains_key(&workspace) {
                continue;
            }
            let host = app.state::<HostState>();
            // Only trusted, present folders are watched.
            let Ok(directory) = verified_project_directory(&host, &workspace, true) else {
                if self.unavailable.insert(workspace) {
                    eprintln!("event=automation_watch_skipped reason=project-unavailable");
                }
                continue;
            };
            let sink = sender.clone();
            let key = workspace.clone();
            match watch_project(
                directory.canonical_path(),
                self.ignored.clone(),
                WATCH_COALESCE,
                move |batch| {
                    let _ = sink.send((key.clone(), batch));
                },
            ) {
                Ok(watch) => {
                    self.unavailable.remove(&workspace);
                    self.active.insert(workspace, watch);
                }
                Err(error) => {
                    if self.unavailable.insert(workspace) {
                        eprintln!("event=automation_watch_unavailable reason={error}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "orchestration_trigger_tests.rs"]
mod tests;
