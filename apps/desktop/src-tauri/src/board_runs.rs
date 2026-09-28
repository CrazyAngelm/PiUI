//! Board-driven runs (ADR-041 phase 3, docs/BOARD.md "Statuses and
//! automation").
//!
//! [`OrchestrationRunStarter`] is the board's [`BoardRunStarter`]: it
//! resolves the teammate's launch command, creates an ordinary orchestration
//! run with `RunTrigger::Board` and the card text in the resolved input, and
//! hands it to the scheduler, exactly like `orchestration_start_run_v6`.
//!
//! [`BoardRunEngine`] observes committed orchestration generations (never
//! polling a model or a folder). When a board run ends it records the end on
//! its card once (result or failure comment, `runFinished`, claim release,
//! `inReview`/`blocked`) and starts queued work whose slot freed. A periodic
//! sweep releases expired claims and claims whose run is gone. The board's
//! own record makes every step idempotent across restarts. Safe mode never
//! starts the engine.

use crate::api::verified_project_directory;
use crate::board::BoardService;
use crate::board::model::{BoardError, Card, CardLink};
use crate::board::ops::{
    BoardRunRequest, BoardRunStarter, RunEnd, TeammateRef, run_end_recorded, truncate_bytes,
};
use crate::orchestration_api::{
    OrchestrationApiState, StartRunRequest, emit_run_changed, validate_live_workspace_scope,
};
use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::orchestration_store::{StoreSnapshot, WorkspaceOrchestration};
use crate::state::HostState;
use crate::teammates_api::{resolve_card_input, teammate_refs_for};
use piui_orchestration::{Run, RunStatus, RunTrigger, TaskStatus};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Notify;

/// How often expired claims are swept and queues retried.
pub(crate) const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// Longest failure detail copied into a card comment, in bytes.
const MAX_FAILURE_DETAIL_BYTES: usize = 500;

fn run_active(status: RunStatus) -> bool {
    matches!(status, RunStatus::Running | RunStatus::Uncertain)
}

/// Whether one more board run for `teammate_id` fits: fewer active board
/// runs of that teammate than `teammate_limit` and fewer active board runs
/// of the project than `board_limit`. `active` lists the teammate id of
/// every active board run of the project.
pub(crate) fn capacity_available(
    active: &[&str],
    teammate_id: &str,
    teammate_limit: u8,
    board_limit: u8,
) -> bool {
    let teammate_runs = active.iter().filter(|id| **id == teammate_id).count();
    active.len() < usize::from(board_limit) && teammate_runs < usize::from(teammate_limit)
}

/// Teammate ids of the active board runs of a project.
fn active_board_runs(workspace: &WorkspaceOrchestration) -> Vec<&str> {
    workspace
        .runs
        .iter()
        .filter(|run| run_active(run.status()))
        .filter_map(|run| run.trigger().and_then(RunTrigger::board_teammate_id))
        .collect()
}

/// The orchestration start of a board run: the teammate's launch command
/// with the card text in its resolved card input.
pub(crate) fn board_start_request(
    workspace: Option<&WorkspaceOrchestration>,
    request: &BoardRunRequest,
) -> Result<(StartRunRequest, RunTrigger), BoardError> {
    const GONE: BoardError =
        BoardError::NotAssignable("This teammate's pipeline no longer exists.");
    let workspace = workspace.ok_or(GONE)?;
    let teammate = workspace
        .teammates
        .iter()
        .find(|teammate| teammate.id == request.teammate_id)
        .ok_or(BoardError::NotFound("That teammate no longer exists."))?;
    if !teammate.enabled {
        return Err(BoardError::NotAssignable("This teammate is turned off."));
    }
    let command = workspace
        .launch_commands
        .iter()
        .find(|command| command.value.id == teammate.launch_command_id)
        .map(|command| &command.value)
        .ok_or(GONE)?;
    let pipeline = workspace
        .pipelines
        .iter()
        .find(|pipeline| pipeline.value.id == command.pipeline_id)
        .map(|pipeline| &pipeline.value)
        .ok_or(GONE)?;
    let input = resolve_card_input(pipeline, &teammate.card_input).map_err(|_| {
        BoardError::NotAssignable("This teammate's pipeline has no input for the card.")
    })?;
    let mut inputs = BTreeMap::new();
    inputs.insert(input, serde_json::Value::String(request.card_text.clone()));
    Ok((
        StartRunRequest {
            workspace_id: request.workspace_id.clone(),
            run_id: request.run_id.clone(),
            team_id: command.team_id.clone(),
            pipeline_id: command.pipeline_id.clone(),
            launch_command_id: Some(command.id.clone()),
            inputs,
            use_pinned_data: false,
        },
        RunTrigger::Board {
            card_id: request.card_id.clone(),
            teammate_id: request.teammate_id.clone(),
            cause: request.cause,
            chain_depth: request.chain_depth,
        },
    ))
}

/// Creates board runs through the ordinary orchestration run path.
pub(crate) struct OrchestrationRunStarter<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> OrchestrationRunStarter<R> {
    pub(crate) fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> BoardRunStarter for OrchestrationRunStarter<R> {
    fn available(&self) -> bool {
        let Some(host) = self.app.try_state::<HostState>() else {
            return false;
        };
        !host.safe_mode
            && !host.is_shutting_down()
            && self
                .app
                .try_state::<OrchestrationScheduler>()
                .is_some_and(|scheduler| scheduler.accepts_work())
    }

    fn has_capacity(&self, workspace_id: &str, teammate_id: &str, board_limit: u8) -> bool {
        let Some(api) = self.app.try_state::<OrchestrationApiState>() else {
            return false;
        };
        let Ok(snapshot) = api.snapshot() else {
            return false;
        };
        let Some(workspace) = snapshot.workspace(workspace_id) else {
            return true;
        };
        let teammate_limit = workspace
            .teammates
            .iter()
            .find(|teammate| teammate.id == teammate_id)
            .map_or(1, |teammate| teammate.max_concurrent_runs);
        capacity_available(
            &active_board_runs(workspace),
            teammate_id,
            teammate_limit,
            board_limit,
        )
    }

    fn start(&self, request: &BoardRunRequest) -> Result<(), BoardError> {
        const UNAVAILABLE: BoardError =
            BoardError::Invalid("This project cannot run agents right now.");
        let host = self.app.try_state::<HostState>().ok_or(UNAVAILABLE)?;
        let api = self
            .app
            .try_state::<OrchestrationApiState>()
            .ok_or(UNAVAILABLE)?;
        let scheduler = self
            .app
            .try_state::<OrchestrationScheduler>()
            .ok_or(UNAVAILABLE)?;
        // The scheduler authorizes again under the operation gate before
        // any native step starts.
        validate_live_workspace_scope(&host, &request.workspace_id).map_err(|_| UNAVAILABLE)?;
        let snapshot = api.snapshot().map_err(|_| BoardError::Io)?;
        let (start, trigger) =
            board_start_request(snapshot.workspace(&request.workspace_id), request)?;
        // A plugin node whose plugin is missing refuses the start, as for a
        // person's start.
        if let Some(plugins) = self.app.try_state::<crate::plugins::PluginsState>() {
            let nodes = api
                .pipeline_plugin_nodes(&request.workspace_id, &start.pipeline_id)
                .map_err(|_| BoardError::Io)?;
            if nodes
                .iter()
                .any(|(plugin_id, node_type)| plugins.node_spec(plugin_id, node_type).is_none())
            {
                return Err(BoardError::Invalid(
                    "A plugin step of this teammate's pipeline is unavailable.",
                ));
            }
        }
        let run = api
            .create_board_run(start, trigger)
            .map_err(|_| BoardError::Invalid("PiUI could not create the run."))?;
        emit_run_changed(&self.app, &request.workspace_id, &run);
        let scheduler = scheduler.inner().clone();
        let app = self.app.clone();
        let workspace_id = request.workspace_id.clone();
        let run_id = request.run_id.clone();
        std::mem::drop(tauri::async_runtime::spawn(async move {
            // A failed dispatch fails the run; its end reaches the card.
            let _ = scheduler.schedule_run(&app, &workspace_id, &run_id).await;
        }));
        Ok(())
    }
}

/// A board run that ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FinishedBoardRun {
    pub workspace_id: String,
    pub run_id: String,
    pub card_id: String,
    pub teammate_id: String,
    pub status: RunStatus,
}

/// Pure observation state of the engine.
#[derive(Default)]
pub(crate) struct BoardRunCore {
    known: HashMap<(String, String), RunStatus>,
}

impl BoardRunCore {
    /// Board runs that ended since the last observation. The first
    /// observation reports every ended board run, so a restart catches up
    /// on ends it missed; the card's own record keeps that idempotent.
    pub(crate) fn observe(&mut self, snapshot: &StoreSnapshot) -> Vec<FinishedBoardRun> {
        let mut finished = Vec::new();
        for workspace in snapshot.workspaces() {
            for run in &workspace.runs {
                let Some(RunTrigger::Board {
                    card_id,
                    teammate_id,
                    ..
                }) = run.trigger()
                else {
                    continue;
                };
                let key = (workspace.workspace_id.clone(), run.id().to_owned());
                let status = run.status();
                let previous = self.known.insert(key, status);
                if run_active(status) || previous.is_some_and(|previous| !run_active(previous)) {
                    continue;
                }
                finished.push(FinishedBoardRun {
                    workspace_id: workspace.workspace_id.clone(),
                    run_id: run.id().to_owned(),
                    card_id: card_id.clone(),
                    teammate_id: teammate_id.clone(),
                    status,
                });
            }
        }
        finished
    }
}

/// Whether the end of `run_id` still has to be recorded on this card: the
/// run still holds the card, or the card links the run and has no record
/// of its end.
pub(crate) fn needs_run_end(card: &Card, run_id: &str) -> bool {
    let holds = card
        .claim
        .as_ref()
        .is_some_and(|claim| claim.run_id.as_deref() == Some(run_id));
    let linked = card
        .links
        .iter()
        .any(|link| matches!(link, CardLink::Run { run_id: linked, .. } if linked == run_id));
    holds || (linked && !run_end_recorded(card, run_id))
}

/// A short failure description of a failed run: its first failed step's
/// code and bounded detail.
pub(crate) fn failure_reason(run: &Run) -> String {
    let failure = run
        .tasks()
        .iter()
        .filter(|task| task.status() == TaskStatus::Failed)
        .find_map(|task| task.failure().map(|failure| (task.step_id(), failure)));
    match failure {
        Some((step, failure)) => {
            let mut reason = format!("step \"{step}\" failed ({})", failure.code);
            if let Some(detail) = failure
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
            {
                reason.push_str(": ");
                reason.push_str(&truncate_bytes(detail.to_owned(), MAX_FAILURE_DETAIL_BYTES));
            }
            reason
        }
        None => "the run failed.".to_owned(),
    }
}

/// The final text of a succeeded run: the last succeeded step's recorded
/// output, or its verified native final answer.
async fn final_result_text<R: Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    run: &Run,
) -> Option<String> {
    let task = run
        .tasks()
        .iter()
        .rev()
        .find(|task| task.status() == TaskStatus::Succeeded)?;
    if let Some(output) = task.output() {
        return Some(output.text.clone());
    }
    let reference = task.result_reference()?;
    let host = app.try_state::<HostState>()?;
    let directory = verified_project_directory(&host, workspace_id, false).ok()?;
    let mut whole = reference.clone();
    whole.fields.clear();
    host.workspace
        .dependency_text(&whole, workspace_id, directory.canonical_path())
        .await
        .ok()
}

#[derive(Default)]
struct EngineInner {
    started: AtomicBool,
    stopping: AtomicBool,
    stop: Notify,
}

/// Managed state driving [`BoardRunCore`] from committed generations and a
/// sweep timer.
#[derive(Clone, Default)]
pub(crate) struct BoardRunEngine {
    inner: Arc<EngineInner>,
}

impl BoardRunEngine {
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
        // Subscribe first: a commit between the two is observed again.
        let mut commits = api.subscribe_commits();
        let mut core = BoardRunCore::default();
        let mut sweep = tokio::time::interval(SWEEP_INTERVAL);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        self.observe(&app, &mut core).await;
        self.restore_queues(&app).await;
        loop {
            if self.stopping() {
                break;
            }
            tokio::select! {
                changed = commits.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    self.observe(&app, &mut core).await;
                }
                _ = sweep.tick() => self.sweep(&app).await,
                () = self.inner.stop.notified() => break,
            }
        }
    }

    /// Records the ends of board runs and starts queued work of their
    /// projects.
    async fn observe<R: Runtime>(&self, app: &AppHandle<R>, core: &mut BoardRunCore) {
        let Some(api) = app.try_state::<OrchestrationApiState>() else {
            return;
        };
        let Ok(snapshot) = api.snapshot() else {
            return;
        };
        let mut freed = BTreeSet::new();
        for finished in core.observe(&snapshot) {
            if self.stopping() {
                return;
            }
            freed.insert(finished.workspace_id.clone());
            finish(app, &snapshot, &finished).await;
        }
        for workspace_id in freed {
            drain(app, workspace_id).await;
        }
    }

    /// At startup: loads the boards of projects with teammates, so starts
    /// queued before a restart (stored in the board document) run again.
    async fn restore_queues<R: Runtime>(&self, app: &AppHandle<R>) {
        let (Some(api), Some(service)) = (
            app.try_state::<OrchestrationApiState>(),
            app.try_state::<BoardService>(),
        ) else {
            return;
        };
        let Ok(snapshot) = api.snapshot() else {
            return;
        };
        let workspaces: Vec<String> = snapshot
            .workspaces()
            .iter()
            .filter(|workspace| !workspace.teammates.is_empty())
            .map(|workspace| workspace.workspace_id.clone())
            .collect();
        for workspace_id in workspaces {
            if self.stopping() {
                return;
            }
            let service = service.inner().clone();
            let loaded = workspace_id.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || service.get(&loaded)).await;
            drain(app, workspace_id).await;
        }
    }

    /// Releases stale claims and retries queued starts.
    async fn sweep<R: Runtime>(&self, app: &AppHandle<R>) {
        let (Some(api), Some(service)) = (
            app.try_state::<OrchestrationApiState>(),
            app.try_state::<BoardService>(),
        ) else {
            return;
        };
        let Ok(snapshot) = api.snapshot() else {
            return;
        };
        let mut workspaces: BTreeSet<String> = service.loaded_workspaces().into_iter().collect();
        workspaces.extend(service.queued_workspaces());
        for workspace_id in workspaces {
            if self.stopping() {
                return;
            }
            let active: HashSet<String> = snapshot
                .workspace(&workspace_id)
                .map(|workspace| {
                    workspace
                        .runs
                        .iter()
                        .filter(|run| run_active(run.status()))
                        .map(|run| run.id().to_owned())
                        .collect()
                })
                .unwrap_or_default();
            let service = service.inner().clone();
            let swept_workspace = workspace_id.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                service.sweep_claims(&swept_workspace, &|run_id| active.contains(run_id))
            })
            .await;
            drain(app, workspace_id).await;
        }
    }
}

/// Records one run end on its card when the card still needs it.
async fn finish<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &StoreSnapshot,
    finished: &FinishedBoardRun,
) {
    let Some(service) = app.try_state::<BoardService>() else {
        return;
    };
    let service = service.inner().clone();
    let workspace_id = finished.workspace_id.clone();
    let card_id = finished.card_id.clone();
    let run_id = finished.run_id.clone();
    let needed = tauri::async_runtime::spawn_blocking({
        let service = service.clone();
        move || {
            service.get(&workspace_id).is_ok_and(|board| {
                board
                    .card(&card_id)
                    .is_some_and(|card| needs_run_end(card, &run_id))
            })
        }
    })
    .await
    .unwrap_or(false);
    if !needed {
        return;
    }
    let workspace = snapshot.workspace(&finished.workspace_id);
    let Some(run) = workspace.and_then(|workspace| {
        workspace
            .runs
            .iter()
            .find(|run| run.id() == finished.run_id)
    }) else {
        return;
    };
    let end = match finished.status {
        RunStatus::Succeeded => RunEnd::Succeeded {
            result: final_result_text(app, &finished.workspace_id, run).await,
        },
        RunStatus::Failed => RunEnd::Failed {
            reason: failure_reason(run),
        },
        RunStatus::Cancelled => RunEnd::Cancelled,
        RunStatus::Running | RunStatus::Uncertain => return,
    };
    let handle = workspace.and_then(|workspace| {
        workspace
            .teammates
            .iter()
            .find(|teammate| teammate.id == finished.teammate_id)
            .map(|teammate| teammate.handle.clone())
    });
    let finished = finished.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.finish_run(
            &finished.workspace_id,
            &finished.card_id,
            &finished.run_id,
            handle.as_deref(),
            &end,
        )
    })
    .await;
    if let Ok(Err(error)) = result {
        eprintln!("event=board_run_end_failed code={}", error.code());
    }
}

/// Starts queued runs of a project while slots are free.
async fn drain<R: Runtime>(app: &AppHandle<R>, workspace_id: String) {
    let (Some(api), Some(service)) = (
        app.try_state::<OrchestrationApiState>(),
        app.try_state::<BoardService>(),
    ) else {
        return;
    };
    let service = service.inner().clone();
    if service.queued_starts(&workspace_id).is_empty() {
        return;
    }
    let teammates: Vec<TeammateRef> = teammate_refs_for(api.inner(), &service, &workspace_id);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        service.drain_queue(&workspace_id, &teammates)
    })
    .await;
}

#[cfg(test)]
#[path = "board_runs_tests.rs"]
mod tests;
