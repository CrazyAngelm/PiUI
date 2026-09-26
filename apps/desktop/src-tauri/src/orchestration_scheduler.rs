//! Host-owned scheduler for durable orchestration runs.
//!
//! This module coordinates the durable domain journal with native workspace
//! sessions. It does not implement a model loop, provider, or tool executor.

use crate::api::verified_project_directory;
#[cfg(test)]
use crate::harness_configuration::PI_NATIVE_TOOL_NAMES;
use crate::harness_configuration::{LaunchPolicy, launch_policy, one_shot_launch_policy};
use crate::orchestration_api::{
    AgentRequestAdmission, AgentToolOperation, AgentToolRequest, ManagedAgentContext,
    ORCHESTRATION_EVENT_V4, OrchestrationApiState, OrchestrationRunChangedEventV4,
    emit_run_changed, emit_schedule_changed, validate_live_workspace_scope,
};
use crate::state::HostState;
#[cfg(test)]
use crate::workspace_api::HarnessCapabilities;
use crate::workspace_api::{
    CoordinatorRequestHandler, CoordinatorRequestOrigin, HarnessKind,
    PermissionMode as WorkspacePermissionMode, PromptMode, TurnOutcome, TurnState,
    WORKSPACE_EVENT_NAME, WorkspaceEventPublisher, WorkspaceLaunchRequest, WorkspaceModel,
    WorkspaceRuntimeHandle, validate_artifact_files,
};
use piui_orchestration::{
    AgentProfile, CompletionOutcome, ControlledSpawnLease, ExecutorKind, FailureRecord, Harness,
    MessageStatus, PipelineStep, Run, SCRIPT_FAILED, SCRIPT_INPUT_UNAVAILABLE,
    SCRIPT_RUNTIME_UNAVAILABLE, SCRIPT_START_FAILED, SCRIPT_TIMEOUT, ScriptCompletion, ScriptLease,
    ScriptRuntime, StepExecutor, TaskStatus, UncertaintyIdentity,
};
#[cfg(test)]
use piui_orchestration::{PolicyEnforcement, ToolDecision};
use piui_runtime::script_runner::{
    ResolvedInterpreter, ScriptInterpreter, ScriptOutcome, ScriptRequest, ScriptRun,
    ScriptRunError, resolve_interpreter, run_script,
};
#[cfg(test)]
use piui_runtime::workspace_runtime::Enforcement;
use piui_runtime::workspace_runtime::{CoordinatorOperation, CoordinatorResponse};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};

// NativeRuntime uses this bound for interrupt admission. The scheduler uses the
// same established bound when waiting for proof that the admitted turn stopped.
const INTERRUPT_PROOF_TIMEOUT: Duration = Duration::from_secs(10);

/// Task failure code of a native start that the harness refused at its login
/// check (Claude Code signed out or not on a Claude subscription). Nothing was
/// executed: the refusal comes before any task text is written.
pub(crate) const HARNESS_SIGN_IN_REQUIRED: &str = "harness-sign-in-required";

/// A failed managed launch whose refusal proves that nothing ran, with the
/// task failure code to record instead of uncertainty.
fn certain_launch_refusal(error: &crate::workspace_api::WorkspaceError) -> Option<&'static str> {
    error
        .is_sign_in_required()
        .then_some(HARNESS_SIGN_IN_REQUIRED)
}

/// Who asked for a managed launch; decides how a certain refusal is recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchOrigin {
    /// A ready step of the run: a certain refusal fails the step.
    Scheduled,
    /// A step leased by an agent's coordinator spawn: the lease is released
    /// and the calling agent receives the typed failure.
    Spawned,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OrchestrationSchedulerError {
    pub code: &'static str,
}

impl OrchestrationSchedulerError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    fn conflict() -> Self {
        Self::new("conflict")
    }

    pub(crate) fn unavailable() -> Self {
        Self::new("runtime-unavailable")
    }

    pub(crate) fn unsupported() -> Self {
        Self::new("unsupported-policy")
    }

    /// An `llm` step's harness has no read-only mode (v6.2).
    pub(crate) fn llm_read_only_unsupported() -> Self {
        Self::new("llm-read-only-unsupported")
    }

    fn uncertain() -> Self {
        Self::new("native-outcome-uncertain")
    }
}

#[derive(Clone)]
struct ActiveExecution {
    handle: WorkspaceRuntimeHandle,
    cancelling: Arc<AtomicBool>,
}

/// How a host-executed script ended, as proof for cancellation (v6.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScriptEnd {
    /// It ended on its own; the script watcher records the outcome.
    Completed { succeeded: bool },
    /// A cancellation terminated its whole process tree.
    Stopped,
    /// Its outcome or its tree cleanup could not be observed.
    Unobserved,
}

/// A running script step. `cancel` terminates its process tree; `ended`
/// reports how it ended.
#[derive(Clone)]
struct ActiveScript {
    cancel: Arc<watch::Sender<bool>>,
    ended: watch::Receiver<Option<ScriptEnd>>,
}

/// How often a running script re-checks that its project is still trusted
/// and live; a failed check terminates its tree like a cancellation.
const SCRIPT_TRUST_POLL: Duration = Duration::from_millis(500);
/// Bound on the proof that a cancelled script's tree ended: the runner's
/// own reap and pipe-drain bounds plus margin.
const SCRIPT_STOP_PROOF_TIMEOUT: Duration = Duration::from_secs(20);

/// A task admitted by one scheduling pass.
enum Admission {
    Native {
        lease: Box<ControlledSpawnLease>,
        policy: LaunchPolicy,
        reserved_session_id: String,
    },
    Script {
        lease: Box<ScriptLease>,
        interpreter: ResolvedInterpreter,
    },
}

/// A started script step handed to its watcher.
struct ScriptLaunch {
    workspace_id: String,
    execution_id: String,
    lease: ScriptLease,
    interpreter: ResolvedInterpreter,
    stdin: Vec<u8>,
    project_dir: std::path::PathBuf,
    work_dir: std::path::PathBuf,
    /// The step's declared result fields from the frozen snapshot.
    result_fields: Vec<piui_orchestration::ResultField>,
}

/// A script admission decided under the operation gate.
enum ScriptAdmission {
    Leased {
        lease: Box<ScriptLease>,
        interpreter: ResolvedInterpreter,
        run: Box<Run>,
    },
    /// A certain failure before anything ran; `run` is the recorded state.
    Rejected {
        run: Option<Box<Run>>,
        error: OrchestrationSchedulerError,
    },
    /// Nothing is ready any more.
    Idle,
}

/// What the host records for a script that ended.
pub(crate) enum ScriptResolution {
    Record(ScriptCompletion),
    /// A cancellation terminated the tree; the cancelling path records it.
    Stopped,
    /// The script may have run but its outcome is unknown.
    Unobserved,
}

type RunKey = (String, String);
type RunGate = Arc<AsyncMutex<()>>;
type RunGateMap = HashMap<RunKey, RunGate>;

#[derive(Default)]
struct SchedulerInner {
    shutting_down: AtomicBool,
    timed_worker_started: AtomicBool,
    timed_wake: Notify,
    active: Mutex<HashMap<String, ActiveExecution>>,
    /// Running script steps by opaque host execution id (v6.2).
    scripts: Mutex<HashMap<String, ActiveScript>>,
    #[cfg(feature = "native-prime-scheduler-test")]
    completed: Mutex<HashMap<String, WorkspaceRuntimeHandle>>,
    run_gates: Mutex<RunGateMap>,
    cancelling_runs: Mutex<HashSet<RunKey>>,
}

/// Managed Tauri state. Clones share active native execution handles and the
/// per-run dispatch gates that prevent two ready-step scans from double launch.
#[derive(Clone, Default)]
pub(crate) struct OrchestrationScheduler {
    inner: Arc<SchedulerInner>,
}

struct CancellationAdmission {
    inner: Arc<SchedulerInner>,
    key: RunKey,
}

impl Drop for CancellationAdmission {
    fn drop(&mut self) {
        if let Ok(mut cancelling) = self.inner.cancelling_runs.lock() {
            cancelling.remove(&self.key);
        }
    }
}

impl OrchestrationScheduler {
    /// Stops all new scheduler admissions before native workspace cleanup
    /// starts, and terminates every running script's process tree. Their
    /// tasks stay running in the journal and become uncertain on restart.
    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
        self.inner.timed_wake.notify_waiters();
        if let Ok(scripts) = self.inner.scripts.lock() {
            for script in scripts.values() {
                script.cancel.send_replace(true);
            }
        }
    }

    pub(crate) fn wake_timed_schedules(&self) {
        self.inner.timed_wake.notify_one();
    }

    pub(crate) fn start_timed_schedule_worker<R: Runtime>(&self, app: AppHandle<R>) {
        if self
            .inner
            .timed_worker_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let scheduler = self.clone();
        let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move {
                scheduler.timed_schedule_loop(app, chrono::Utc::now()).await;
            });
        std::mem::drop(tauri::async_runtime::spawn(future));
    }

    async fn timed_schedule_loop<R: Runtime>(
        &self,
        app: AppHandle<R>,
        host_started_at: chrono::DateTime<chrono::Utc>,
    ) {
        // Resume manually started and scheduled runs alike. Only work that
        // never crossed the native boundary is resumed; uncertain work waits
        // for explicit reconciliation.
        if let Ok(runs) = app.state::<OrchestrationApiState>().recoverable_runs() {
            for (workspace_id, run_id) in runs {
                if !self.admits_work() {
                    return;
                }
                let _ = self.schedule_run(&app, &workspace_id, &run_id).await;
            }
        }
        while self.admits_work() {
            let next_due = app
                .state::<OrchestrationApiState>()
                .next_schedule_due()
                .ok()
                .flatten();
            let now = chrono::Utc::now();
            match next_due {
                Some(due) if due <= now => {
                    if !self.process_due_schedules(&app, now, host_started_at).await {
                        // A durable claim that cannot commit must not become a
                        // hot retry loop. Schedule mutations retain a Notify
                        // permit and explicitly wake the worker after recovery.
                        self.inner.timed_wake.notified().await;
                    }
                }
                Some(due) => {
                    let wait = (due - now).to_std().unwrap_or(Duration::ZERO);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {},
                        _ = self.inner.timed_wake.notified() => {},
                    }
                }
                None => self.inner.timed_wake.notified().await,
            }
        }
    }

    async fn process_due_schedules<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        now: chrono::DateTime<chrono::Utc>,
        host_started_at: chrono::DateTime<chrono::Utc>,
    ) -> bool {
        let due = match app.state::<OrchestrationApiState>().due_schedule_keys(now) {
            Ok(due) => due,
            Err(error) => {
                eprintln!(
                    "event=orchestration_schedule_worker_paused code={}",
                    error.code
                );
                return false;
            }
        };
        let mut progressed = false;
        let mut stalled_code = None;
        for (workspace_id, schedule_id, revision) in due {
            if !self.admits_work() {
                return progressed;
            }
            let claim = {
                let host = app.state::<HostState>();
                let _operation = host.live_runtime_operation_gate.lock().await;
                let admission_failure = validate_live_workspace_scope(&host, &workspace_id)
                    .err()
                    .map(|error| error.code);
                app.state::<OrchestrationApiState>().claim_due_schedule(
                    &workspace_id,
                    &schedule_id,
                    revision,
                    now,
                    host_started_at,
                    admission_failure,
                )
            };
            let claim = match claim {
                Ok(claim) => claim,
                Err(error) => {
                    stalled_code = Some(error.code);
                    continue;
                }
            };
            progressed = true;
            emit_schedule_changed(app, &workspace_id, &schedule_id, claim.schedule.revision);
            if let Some(run) = claim.run {
                let run_id = run.id().to_owned();
                emit_run_changed(app, &workspace_id, &run);
                let _ = self.schedule_run(app, &workspace_id, &run_id).await;
            }
        }
        if !progressed && let Some(code) = stalled_code {
            eprintln!("event=orchestration_schedule_worker_paused code={code}");
        }
        progressed
    }

    fn admits_work(&self) -> bool {
        !self.inner.shutting_down.load(Ordering::Acquire)
    }

    /// Starts every currently ready predefined step. Native turns run in
    /// parallel; each completion schedules newly unblocked dependencies.
    pub(crate) async fn schedule_run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<(), OrchestrationSchedulerError> {
        if !self.admits_work() || self.is_run_cancelling(workspace_id, run_id) {
            return Err(OrchestrationSchedulerError::unavailable());
        }
        let run_gate = self.run_gate(workspace_id, run_id)?;
        let _dispatch = run_gate.lock().await;
        if self.is_run_cancelling(workspace_id, run_id) {
            return Err(OrchestrationSchedulerError::unavailable());
        }

        loop {
            if self.is_run_cancelling(workspace_id, run_id) {
                return Ok(());
            }
            // Selection, capability validation, and durable leasing share the
            // same operation gate. A reverse-tool spawn cannot change which
            // lexical ready task those capabilities describe between steps.
            let admission = 'admission: {
                let host = app.state::<HostState>();
                let _operation = host.live_runtime_operation_gate.lock().await;
                authorize_live_workspace(&host, workspace_id)?;
                let api = app.state::<OrchestrationApiState>();
                let advanced = api
                    .advance_automatic_steps(workspace_id, run_id)
                    .map_err(|_| OrchestrationSchedulerError::conflict())?;
                self.emit_run_invalidation(app, workspace_id, &advanced);
                let run = api
                    .get_run(workspace_id, run_id)
                    .map_err(|_| OrchestrationSchedulerError::conflict())?
                    .ok_or_else(OrchestrationSchedulerError::conflict)?;
                let Some(step) = next_ready_step(&run) else {
                    return Ok(());
                };
                let step_id = step.id.clone();
                let task_revision = run
                    .tasks()
                    .iter()
                    .find(|task| task.step_id() == step_id)
                    .map(piui_orchestration::TaskRecord::revision)
                    .ok_or_else(OrchestrationSchedulerError::conflict)?;
                if step.is_script() {
                    let lease_id = host.workspace.allocate_orchestration_session_id();
                    match admit_script(&api, workspace_id, &run, &step, task_revision, lease_id) {
                        ScriptAdmission::Leased {
                            lease,
                            interpreter,
                            run,
                        } => {
                            self.emit_run_invalidation(app, workspace_id, &run);
                            break 'admission Admission::Script { lease, interpreter };
                        }
                        ScriptAdmission::Rejected { run, error } => {
                            if let Some(run) = run {
                                self.emit_run_invalidation(app, workspace_id, &run);
                            }
                            return Err(error);
                        }
                        ScriptAdmission::Idle => return Ok(()),
                    }
                }
                let Some(profile) = profile_for_step(&run, &step) else {
                    return Ok(());
                };
                let offline = host
                    .workspace
                    .orchestration_capabilities(harness_kind(profile.harness));
                // An llm step is one native turn with the least authority
                // the adapter enforces; harness differences live there.
                let policy = if step.executor_kind() == ExecutorKind::Llm {
                    one_shot_launch_policy(&profile, &offline)
                } else {
                    launch_policy(&profile, &offline)
                };
                let (capabilities, launch_policy) = match policy {
                    Ok(policy) => policy,
                    Err(error) => {
                        if let Ok(rejected) = api.reject_ready_task(
                            workspace_id,
                            run_id,
                            &step_id,
                            task_revision,
                            error.code.to_owned(),
                        ) {
                            self.emit_run_invalidation(app, workspace_id, &rejected);
                        }
                        return Err(error);
                    }
                };
                let reserved_session_id = host.workspace.allocate_orchestration_session_id();
                let lease = api
                    .lease_next_scheduled_task(
                        workspace_id,
                        run_id,
                        run.revision(),
                        reserved_session_id.clone(),
                        &capabilities,
                    )
                    .map_err(|_| OrchestrationSchedulerError::conflict())?;
                let Some(lease) = lease else {
                    return Ok(());
                };
                // Defense in depth: the atomic gate should make this exact.
                if lease.profile != profile {
                    return Err(OrchestrationSchedulerError::conflict());
                }
                if let Ok(Some(updated)) = api.get_run(workspace_id, run_id) {
                    self.emit_run_invalidation(app, workspace_id, &updated);
                }
                Admission::Native {
                    lease: Box::new(lease),
                    policy: launch_policy,
                    reserved_session_id,
                }
            };
            match admission {
                Admission::Native {
                    lease,
                    policy,
                    reserved_session_id,
                } => {
                    self.launch_lease(
                        app,
                        workspace_id,
                        *lease,
                        policy,
                        Some(reserved_session_id),
                        LaunchOrigin::Scheduled,
                    )
                    .await?;
                }
                Admission::Script { lease, interpreter } => {
                    self.launch_script(app, workspace_id, *lease, interpreter)
                        .await?;
                }
            }
        }
    }

    /// Interrupts every running execution and commits cancelled only after all
    /// of them emit an explicit interrupted terminal outcome. Any missing or
    /// contradictory terminal evidence becomes uncertain and is never replayed.
    pub(crate) async fn cancel_run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
    ) -> Result<Run, OrchestrationSchedulerError> {
        self.cancel_scope(app, workspace_id, run_id, expected_run_revision, None)
            .await
    }

    pub(crate) async fn cancel_task<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
        step_id: &str,
    ) -> Result<Run, OrchestrationSchedulerError> {
        self.cancel_scope(
            app,
            workspace_id,
            run_id,
            expected_run_revision,
            Some(step_id),
        )
        .await
    }

    pub(crate) async fn cancel_scope<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
        expected_run_revision: u64,
        step_id: Option<&str>,
    ) -> Result<Run, OrchestrationSchedulerError> {
        if !self.admits_work() {
            return Err(OrchestrationSchedulerError::unavailable());
        }
        let _cancellation = self.begin_cancellation(workspace_id, run_id)?;
        let run_gate = self.run_gate(workspace_id, run_id)?;
        let _dispatch = run_gate.lock().await;
        let cancels = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            authorize_live_workspace(&host, workspace_id)?;
            app.state::<OrchestrationApiState>()
                .plan_cancel(workspace_id, run_id, expected_run_revision)
                .map_err(|_| OrchestrationSchedulerError::conflict())?
        };
        let cancels = cancels
            .into_iter()
            .filter(|cancel| step_id.is_none_or(|id| cancel.step_id == id))
            .collect::<Vec<_>>();
        if cancels.is_empty() {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            authorize_live_workspace(&host, workspace_id)?;
            let api = app.state::<OrchestrationApiState>();
            let current = api
                .get_run(workspace_id, run_id)
                .map_err(|_| OrchestrationSchedulerError::conflict())?
                .ok_or_else(OrchestrationSchedulerError::conflict)?;
            let run = api
                .commit_cancel_after_native_stop(workspace_id, run_id, current.revision(), step_id)
                .map_err(|_| OrchestrationSchedulerError::conflict())?;
            self.emit_run_invalidation(app, workspace_id, &run);
            return Ok(run);
        }

        let mut evidence = Vec::with_capacity(cancels.len());
        for cancel in &cancels {
            // A script has no native turn: proof is its terminated tree.
            if let Some(script) = self.active_script(&cancel.execution.id) {
                evidence.push((cancel, None, stop_script(&script).await));
                continue;
            }
            let active = match self.active(&cancel.execution.id) {
                Ok(active) => active,
                Err(_) => {
                    evidence.push((cancel, None, None));
                    continue;
                }
            };
            let mut turns = match active.handle.subscribe_turns() {
                Ok(turns) => turns,
                Err(_) => {
                    evidence.push((cancel, Some(active), None));
                    continue;
                }
            };
            let baseline = turns.borrow().generation;
            active.cancelling.store(true, Ordering::Release);
            let interrupt_result = {
                let host = app.state::<HostState>();
                let _operation = host.live_runtime_operation_gate.lock().await;
                if authorize_live_workspace(&host, workspace_id).is_err() {
                    evidence.push((cancel, Some(active), None));
                    continue;
                }
                active.handle.interrupt().await
            };
            let outcome = if interrupt_result.is_ok() {
                tokio::time::timeout(
                    INTERRUPT_PROOF_TIMEOUT,
                    wait_for_terminal_outcome(&mut turns, baseline),
                )
                .await
                .ok()
                .and_then(Result::ok)
            } else {
                None
            };
            evidence.push((cancel, Some(active), outcome));
        }

        if evidence
            .iter()
            .all(|(_, _, outcome)| *outcome == Some(TurnOutcome::Interrupted))
        {
            let result = {
                let host = app.state::<HostState>();
                let _operation = host.live_runtime_operation_gate.lock().await;
                authorize_live_workspace(&host, workspace_id)?;
                let api = app.state::<OrchestrationApiState>();
                let current = api
                    .get_run(workspace_id, run_id)
                    .map_err(|_| OrchestrationSchedulerError::conflict())?
                    .ok_or_else(OrchestrationSchedulerError::conflict)?;
                api.commit_cancel_after_native_stop(
                    workspace_id,
                    run_id,
                    current.revision(),
                    step_id,
                )
                .map_err(|_| OrchestrationSchedulerError::conflict())
            };
            if let Ok(run) = result {
                self.emit_run_invalidation(app, workspace_id, &run);
                for (cancel, _, _) in &evidence {
                    self.remove_active(&cancel.execution.id);
                }
                return Ok(run);
            }
            // A failed cancellation commit cannot leave interrupted native
            // executions recorded as Running. Fall through to uncertainty.
        }

        // A partially stopped set cannot be called cancelled. Move every still
        // CAS-matching execution to uncertain so recovery never replays it.
        let mut latest = None;
        for (cancel, _, outcome) in evidence {
            // A concurrently completed success/failure belongs to the terminal
            // watcher. Never overwrite that real outcome with cancellation
            // uncertainty merely because it raced this request.
            if matches!(outcome, Some(TurnOutcome::Succeeded | TurnOutcome::Failed)) {
                continue;
            }
            let run = match self.current_run(app, workspace_id, run_id).await {
                Ok(run) => run,
                Err(_) => continue,
            };
            let Some(task) = run.tasks().iter().find(|task| {
                task.step_id() == cancel.step_id
                    && task
                        .execution()
                        .is_some_and(|value| value.id == cancel.execution.id)
            }) else {
                continue;
            };
            let marked = {
                let host = app.state::<HostState>();
                let _operation = host.live_runtime_operation_gate.lock().await;
                authorize_live_workspace(&host, workspace_id)?;
                app.state::<OrchestrationApiState>().mark_task_uncertain(
                    workspace_id,
                    run_id,
                    run.revision(),
                    task.step_id(),
                    task.revision(),
                    UncertaintyIdentity::Execution(cancel.execution.id.clone()),
                )
            };
            if let Ok(run) = marked {
                self.emit_run_invalidation(app, workspace_id, &run);
                latest = Some(run);
                self.remove_active(&cancel.execution.id);
            }
        }
        latest.ok_or_else(OrchestrationSchedulerError::uncertain)
    }

    async fn launch_lease<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        lease: ControlledSpawnLease,
        policy: LaunchPolicy,
        reserved_session_id: Option<String>,
        origin: LaunchOrigin,
    ) -> Result<String, OrchestrationSchedulerError> {
        if !self.admits_work() {
            return Err(OrchestrationSchedulerError::unavailable());
        }
        let host = app.state::<HostState>();
        let operation = host.live_runtime_operation_gate.lock().await;
        let directory = authorize_live_workspace(&host, workspace_id)?;
        if self.is_run_cancelling(workspace_id, &lease.run_id) {
            let api = app.state::<OrchestrationApiState>();
            if api
                .release_spawn_lease(
                    &ManagedAgentContext {
                        workspace_id: workspace_id.to_owned(),
                        run_id: lease.run_id.clone(),
                        workspace_session_id: String::new(),
                    },
                    &lease,
                )
                .is_ok()
                && let Ok(Some(updated)) = api.get_run(workspace_id, &lease.run_id)
            {
                self.emit_run_invalidation(app, workspace_id, &updated);
            }
            return Err(OrchestrationSchedulerError::conflict());
        }
        let session_id = reserved_session_id
            .unwrap_or_else(|| host.workspace.allocate_orchestration_session_id());
        let coordinator = policy.coordinator.then(|| {
            coordinator_handler(
                self.clone(),
                app.clone(),
                workspace_id.to_owned(),
                lease.run_id.clone(),
            )
        });
        let request =
            workspace_launch_request(workspace_id, &session_id, &lease, policy, coordinator);
        let publisher = workspace_event_publisher(app.clone());
        let handle = match host
            .workspace
            .launch_for_orchestration(&directory, request, publisher)
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                // A refusal at the harness login check proves that no task
                // text was written: record it as a typed failure (or return
                // the spawned step to its caller) instead of uncertainty.
                // The step can run again once the user has signed in.
                if let Some(code) = certain_launch_refusal(&error) {
                    let api = app.state::<OrchestrationApiState>();
                    if let Some(run) =
                        record_launch_refusal(&api, workspace_id, &lease, origin, code)
                    {
                        drop(operation);
                        self.emit_run_invalidation(app, workspace_id, &run);
                        return Err(OrchestrationSchedulerError::new(code));
                    }
                }
                drop(operation);
                self.mark_lease_uncertain(app, workspace_id, &lease).await;
                return Err(OrchestrationSchedulerError::uncertain());
            }
        };
        let mut turns = match handle.subscribe_turns() {
            Ok(turns) => turns,
            Err(_) => {
                drop(operation);
                self.mark_lease_uncertain(app, workspace_id, &lease).await;
                return Err(OrchestrationSchedulerError::uncertain());
            }
        };
        let baseline_generation = turns.borrow().generation;
        let launch = match app.state::<OrchestrationApiState>().commit_launch_lease(
            workspace_id,
            &lease.run_id,
            &lease,
            session_id.clone(),
        ) {
            Ok(launch) => launch,
            Err(_) => {
                let _ = handle.close().await;
                drop(operation);
                self.mark_lease_uncertain(app, workspace_id, &lease).await;
                return Err(OrchestrationSchedulerError::uncertain());
            }
        };
        if let Ok(Some(updated)) = app
            .state::<OrchestrationApiState>()
            .get_run(workspace_id, &lease.run_id)
        {
            self.emit_run_invalidation(app, workspace_id, &updated);
        }
        let cancelling = Arc::new(AtomicBool::new(false));
        if let Err(error) = self.insert_active(
            session_id.clone(),
            ActiveExecution {
                handle: handle.clone(),
                cancelling: Arc::clone(&cancelling),
            },
        ) {
            let _ = handle.close().await;
            drop(operation);
            self.mark_execution_uncertain(app, workspace_id, &launch)
                .await;
            return Err(error);
        }

        if handle
            .prompt(launch.task_instructions.clone(), PromptMode::Prompt)
            .await
            .is_err()
        {
            self.remove_active(&session_id);
            drop(operation);
            self.mark_execution_uncertain(app, workspace_id, &launch)
                .await;
            return Err(OrchestrationSchedulerError::uncertain());
        }
        // The task prompt is admitted first. Accepted team messages may then
        // use the adapter's native queued-delivery route without racing the
        // initial task turn.
        self.flush_accepted_messages_locked(
            app,
            workspace_id,
            &lease.run_id,
            &lease.member_id,
            &session_id,
            &operation,
        )
        .await;
        drop(operation);

        let scheduler = self.clone();
        let app = app.clone();
        let workspace_id = workspace_id.to_owned();
        tokio::spawn(async move {
            scheduler
                .watch_execution(
                    app,
                    workspace_id,
                    launch,
                    handle,
                    cancelling,
                    &mut turns,
                    baseline_generation,
                )
                .await;
        });
        Ok(session_id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn watch_execution<R: Runtime>(
        &self,
        app: AppHandle<R>,
        workspace_id: String,
        launch: piui_orchestration::LaunchRequest,
        handle: WorkspaceRuntimeHandle,
        cancelling: Arc<AtomicBool>,
        turns: &mut watch::Receiver<TurnState>,
        baseline_generation: u64,
    ) {
        let outcome = wait_for_terminal_outcome(turns, baseline_generation).await;
        if outcome == Ok(TurnOutcome::Interrupted) && cancelling.load(Ordering::Acquire) {
            return;
        }
        let native_result = if outcome == Ok(TurnOutcome::Succeeded) {
            handle.final_result().await.ok()
        } else {
            None
        };
        let native_result_text = native_result.as_ref().and_then(|(_, text)| text.clone());
        let fields = app
            .state::<OrchestrationApiState>()
            .get_run(&workspace_id, &launch.run_id)
            .ok()
            .flatten()
            .and_then(|run| {
                run.definition()
                    .pipeline
                    .steps
                    .iter()
                    .find(|step| step.id == launch.step_id)
                    .map(|step| step.result_fields.clone())
            });
        let artifacts_valid = match fields {
            Some(fields) => handle
                .validate_result_artifacts(&fields, native_result_text.as_deref().unwrap_or(""))
                .await
                .is_ok(),
            None => false,
        };
        let completion = match outcome {
            Ok(TurnOutcome::Succeeded) if !artifacts_valid => CompletionOutcome::Failed {
                failure: FailureRecord::new("result-artifact-unavailable"),
            },
            Ok(TurnOutcome::Succeeded) => match native_result {
                Some((reference, _)) => CompletionOutcome::Succeeded {
                    result_reference: Some(reference),
                },
                None => {
                    self.mark_execution_uncertain(&app, &workspace_id, &launch)
                        .await;
                    self.remove_active(&launch.execution.id);
                    return;
                }
            },
            Ok(TurnOutcome::Failed) => CompletionOutcome::Failed {
                failure: FailureRecord::new("native-turn-failed"),
            },
            Ok(TurnOutcome::Interrupted) => CompletionOutcome::Failed {
                failure: FailureRecord::new("native-turn-interrupted"),
            },
            Err(()) => {
                self.mark_execution_uncertain(&app, &workspace_id, &launch)
                    .await;
                self.remove_active(&launch.execution.id);
                return;
            }
        };
        let recorded = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            if authorize_live_workspace(&host, &workspace_id).is_err() {
                return;
            }
            let api = app.state::<OrchestrationApiState>();
            let current = match api.get_run(&workspace_id, &launch.run_id) {
                Ok(Some(run)) => run,
                _ => return,
            };
            let task = match current.tasks().iter().find(|task| {
                task.step_id() == launch.step_id
                    && task
                        .execution()
                        .is_some_and(|execution| execution.id == launch.execution.id)
            }) {
                Some(task) => task,
                None => return,
            };
            api.record_terminal_event(
                &workspace_id,
                &launch.run_id,
                current.revision(),
                &launch.step_id,
                task.revision(),
                &launch.execution.id,
                completion,
                native_result_text.as_deref(),
            )
        };
        self.remove_active(&launch.execution.id);
        if let Ok(run) = recorded {
            self.emit_run_invalidation(&app, &workspace_id, &run);
            self.spawn_reschedule(app, workspace_id, launch.run_id.clone());
        }
    }

    /// Starts one leased script step on the host (v6.2). The task becomes
    /// running only immediately before the process starts, so a restart can
    /// never replay a script that may have run: it becomes uncertain.
    async fn launch_script<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        lease: ScriptLease,
        interpreter: ResolvedInterpreter,
    ) -> Result<(), OrchestrationSchedulerError> {
        let host = app.state::<HostState>();
        let operation = host.live_runtime_operation_gate.lock().await;
        let api = app.state::<OrchestrationApiState>();
        let authorized = authorize_live_workspace(&host, workspace_id);
        let directory = match authorized {
            Ok(directory)
                if self.admits_work() && !self.is_run_cancelling(workspace_id, &lease.run_id) =>
            {
                directory
            }
            other => {
                // Nothing ran: the step returns to ready.
                if let Ok(run) = api.release_script_lease(workspace_id, &lease) {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(other
                    .err()
                    .unwrap_or_else(OrchestrationSchedulerError::conflict));
            }
        };
        let execution_id = host.workspace.allocate_orchestration_session_id();
        let prepared = prepare_script(
            &host,
            &api,
            workspace_id,
            &directory,
            lease,
            interpreter,
            execution_id,
        )
        .await;
        let launch = match prepared {
            Ok((launch, run)) => {
                self.emit_run_invalidation(app, workspace_id, &run);
                launch
            }
            Err((run, error)) => {
                if let Some(run) = run {
                    self.emit_run_invalidation(app, workspace_id, &run);
                }
                return Err(error);
            }
        };
        let (cancel, cancel_receiver) = watch::channel(false);
        let (ended, ended_receiver) = watch::channel(None);
        let script = ActiveScript {
            cancel: Arc::new(cancel),
            ended: ended_receiver,
        };
        if self
            .insert_script(launch.execution_id.clone(), script.clone())
            .is_err()
        {
            // No process exists under this id: a certain start failure.
            if let Ok(run) = api.record_script_outcome(
                workspace_id,
                &launch.lease.run_id,
                &launch.lease.step_id,
                &launch.execution_id,
                ScriptCompletion::Failed {
                    failure: FailureRecord::new(SCRIPT_START_FAILED),
                },
            ) {
                self.emit_run_invalidation(app, workspace_id, &run);
            }
            return Err(OrchestrationSchedulerError::conflict());
        }
        drop(operation);
        let scheduler = self.clone();
        let app = app.clone();
        tokio::spawn(async move {
            scheduler
                .watch_script(app, launch, script.cancel, cancel_receiver, ended)
                .await;
        });
        Ok(())
    }

    /// Runs a started script to its end and records the host-observed
    /// outcome. A cancellation (from a person, shutdown or a project that is
    /// no longer trusted) terminates the tree; the cancelling path owns that
    /// transition, and anything unrecorded becomes uncertain on restart.
    async fn watch_script<R: Runtime>(
        &self,
        app: AppHandle<R>,
        launch: ScriptLaunch,
        cancel: Arc<watch::Sender<bool>>,
        cancel_receiver: watch::Receiver<bool>,
        ended: watch::Sender<Option<ScriptEnd>>,
    ) {
        let guard = {
            let scheduler = self.clone();
            let app = app.clone();
            let workspace_id = launch.workspace_id.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(SCRIPT_TRUST_POLL).await;
                    if !scheduler.admits_work()
                        || authorize_live_workspace(&app.state::<HostState>(), &workspace_id)
                            .is_err()
                    {
                        cancel.send_replace(true);
                        return;
                    }
                }
            })
        };
        let resolution = execute_script(&launch, cancel_receiver).await;
        guard.abort();
        let completion = match resolution {
            ScriptResolution::Stopped => {
                ended.send_replace(Some(ScriptEnd::Stopped));
                self.remove_script(&launch.execution_id);
                return;
            }
            ScriptResolution::Unobserved => {
                ended.send_replace(Some(ScriptEnd::Unobserved));
                self.mark_script_uncertain(&app, &launch).await;
                self.remove_script(&launch.execution_id);
                return;
            }
            ScriptResolution::Record(completion) => completion,
        };
        ended.send_replace(Some(ScriptEnd::Completed {
            succeeded: matches!(completion, ScriptCompletion::Exited { .. }),
        }));
        let recorded = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            if authorize_live_workspace(&host, &launch.workspace_id).is_err() {
                self.remove_script(&launch.execution_id);
                return;
            }
            app.state::<OrchestrationApiState>().record_script_outcome(
                &launch.workspace_id,
                &launch.lease.run_id,
                &launch.lease.step_id,
                &launch.execution_id,
                completion,
            )
        };
        self.remove_script(&launch.execution_id);
        if let Ok(run) = recorded {
            self.emit_run_invalidation(&app, &launch.workspace_id, &run);
            self.spawn_reschedule(app, launch.workspace_id, launch.lease.run_id);
        }
    }

    async fn mark_script_uncertain<R: Runtime>(&self, app: &AppHandle<R>, launch: &ScriptLaunch) {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, &launch.workspace_id).is_err() {
            return;
        }
        let api = app.state::<OrchestrationApiState>();
        let Ok(Some(current)) = api.get_run(&launch.workspace_id, &launch.lease.run_id) else {
            return;
        };
        let Some(task) = current.tasks().iter().find(|task| {
            task.step_id() == launch.lease.step_id
                && task
                    .execution()
                    .is_some_and(|execution| execution.id == launch.execution_id)
        }) else {
            return;
        };
        if let Ok(run) = api.mark_task_uncertain(
            &launch.workspace_id,
            &launch.lease.run_id,
            current.revision(),
            &launch.lease.step_id,
            task.revision(),
            UncertaintyIdentity::Execution(launch.execution_id.clone()),
        ) {
            self.emit_run_invalidation(app, &launch.workspace_id, &run);
        }
    }

    fn active_script(&self, execution_id: &str) -> Option<ActiveScript> {
        self.inner.scripts.lock().ok()?.get(execution_id).cloned()
    }

    fn insert_script(
        &self,
        execution_id: String,
        script: ActiveScript,
    ) -> Result<(), OrchestrationSchedulerError> {
        let mut scripts = self
            .inner
            .scripts
            .lock()
            .map_err(|_| OrchestrationSchedulerError::unavailable())?;
        if scripts.contains_key(&execution_id) {
            return Err(OrchestrationSchedulerError::conflict());
        }
        scripts.insert(execution_id, script);
        Ok(())
    }

    fn remove_script(&self, execution_id: &str) {
        if let Ok(mut scripts) = self.inner.scripts.lock() {
            scripts.remove(execution_id);
        }
    }

    async fn handle_coordinator_request<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        expected_run_id: &str,
        origin: CoordinatorRequestOrigin,
        operation: CoordinatorOperation,
    ) -> CoordinatorResponse {
        if !self.admits_work() {
            return coordinator_failure("coordinator-shutting-down");
        }
        if self.is_run_cancelling(workspace_id, expected_run_id) {
            return coordinator_failure("run-cancelling");
        }
        let origin_active = match self.active(&origin.session_id) {
            Ok(active) => active,
            Err(_) => return coordinator_failure("coordinator-origin-invalid"),
        };
        if origin.run_id != expected_run_id
            || origin_active.handle.session_id() != origin.session_id
            || origin_active.handle.task_id() != origin.task_id
        {
            return coordinator_failure("coordinator-origin-invalid");
        }
        let context = ManagedAgentContext {
            workspace_id: workspace_id.to_owned(),
            run_id: origin.run_id.clone(),
            workspace_session_id: origin.session_id.clone(),
        };
        let wait_for_result = matches!(operation, CoordinatorOperation::Wait { .. });
        let request = AgentToolRequest {
            request_id: format!("{}-{}", origin.session_id, origin.request_id),
            operation: match operation {
                CoordinatorOperation::Roster => AgentToolOperation::Roster,
                CoordinatorOperation::Send {
                    recipient_member_id,
                    body,
                } => AgentToolOperation::Send {
                    recipient_member_id,
                    body,
                },
                CoordinatorOperation::Observe { target_member_id }
                | CoordinatorOperation::Wait { target_member_id } => {
                    AgentToolOperation::Observe { target_member_id }
                }
                CoordinatorOperation::Spawn { step_id } => AgentToolOperation::Spawn { step_id },
                CoordinatorOperation::SpawnAgent {
                    profile_id,
                    name,
                    instructions,
                } => AgentToolOperation::SpawnAgent {
                    profile_id,
                    name,
                    instructions,
                },
            },
        };

        let admission = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            if authorize_live_workspace(&host, workspace_id).is_err() {
                return coordinator_failure("workspace-unavailable");
            }
            let harness = match self.active(&context.workspace_session_id) {
                Ok(active) => match active.handle.snapshot().await {
                    Ok(snapshot) => snapshot.session.harness,
                    Err(_) => return coordinator_failure("runtime-unavailable"),
                },
                Err(_) => return coordinator_failure("coordinator-origin-invalid"),
            };
            let run = match app
                .state::<OrchestrationApiState>()
                .get_run(workspace_id, &context.run_id)
            {
                Ok(Some(run)) => run,
                _ => return coordinator_failure("run-unavailable"),
            };
            if member_for_execution(&run, &context.workspace_session_id)
                != Some(origin.member_id.as_str())
            {
                return coordinator_failure("coordinator-origin-invalid");
            }
            let profile = match profile_for_execution(&run, &context.workspace_session_id) {
                Some(profile) => profile,
                None => return coordinator_failure("coordinator-origin-invalid"),
            };
            let offline = host.workspace.orchestration_capabilities(harness);
            let (capabilities, _) = match launch_policy(&profile, &offline) {
                Ok(value) => value,
                Err(_) => return coordinator_failure("unsupported-policy"),
            };
            let api = app.state::<OrchestrationApiState>();
            let admission = api.handle_agent_request(context.clone(), request, &capabilities);
            if admission.is_ok()
                && let Ok(Some(updated)) = api.get_run(workspace_id, &context.run_id)
            {
                self.emit_run_invalidation(app, workspace_id, &updated);
            }
            admission
        };
        let admission = match admission {
            Ok(admission) => admission,
            Err(_) => return coordinator_failure("coordinator-request-denied"),
        };

        match admission {
            AgentRequestAdmission::Roster {
                members,
                spawn_profiles,
            } => CoordinatorResponse::Success(json!({
                "spawnProfiles": spawn_profiles.into_iter().map(|p| json!({"profileId": p.id, "name": p.name, "harness": harness_name(p.harness), "whenToCall": p.when_to_call, "input": p.input_instructions, "expectedResult": p.expected_result})).collect::<Vec<_>>(),
                "members": members.into_iter().map(|member| json!({
                    "memberId": member.member_id,
                    "profileId": member.profile_id,
                    "harness": harness_name(member.harness),
                    "canSend": member.can_send,
                    "canObserve": member.can_observe,
                })).collect::<Vec<_>>()
            })),
            AgentRequestAdmission::Observe {
                member_id,
                history_references,
            } => {
                if wait_for_result {
                    self.wait_for_member(app, &context, &origin.member_id, &member_id)
                        .await
                } else {
                    CoordinatorResponse::Success(json!({
                        "memberId": member_id,
                        "historyReferences": history_references,
                    }))
                }
            }
            AgentRequestAdmission::Send {
                message_id,
                recipient_member_id,
                body,
                already_delivered,
            } => {
                let delivered = if already_delivered {
                    true
                } else {
                    self.deliver_accepted_message(
                        app,
                        &context,
                        &message_id,
                        &recipient_member_id,
                        body,
                    )
                    .await
                };
                CoordinatorResponse::Success(json!({
                    "messageId": message_id,
                    "status": if delivered { "delivered" } else { "accepted" },
                }))
            }
            AgentRequestAdmission::SpawnCommitted {
                step_id,
                member_id,
                workspace_session_id,
            } => CoordinatorResponse::Success(json!({
                "stepId": step_id,
                "memberId": member_id,
                "sessionId": workspace_session_id,
                "deduplicated": true,
            })),
            AgentRequestAdmission::Spawn { lease } => {
                let offline = {
                    let host = app.state::<HostState>();
                    host.workspace
                        .orchestration_capabilities(harness_kind(lease.profile.harness))
                };
                let (_, policy) = match launch_policy(&lease.profile, &offline) {
                    Ok(value) => value,
                    Err(_) => {
                        let host = app.state::<HostState>();
                        let _operation = host.live_runtime_operation_gate.lock().await;
                        if authorize_live_workspace(&host, workspace_id).is_ok() {
                            let api = app.state::<OrchestrationApiState>();
                            if api.release_spawn_lease(&context, &lease).is_ok()
                                && let Ok(Some(updated)) =
                                    api.get_run(workspace_id, &context.run_id)
                            {
                                self.emit_run_invalidation(app, workspace_id, &updated);
                            }
                        }
                        return coordinator_failure("unsupported-policy");
                    }
                };
                let member_id = lease.member_id.clone();
                let step_id = lease.step_id.clone();
                match self
                    .launch_lease(
                        app,
                        workspace_id,
                        lease,
                        policy,
                        None,
                        LaunchOrigin::Spawned,
                    )
                    .await
                {
                    Ok(session_id) => CoordinatorResponse::Success(json!({
                        "memberId": member_id,
                        "stepId": step_id,
                        "sessionId": session_id,
                    })),
                    // Certain: the step did not start and is ready to be spawned again.
                    Err(error) if error.code == HARNESS_SIGN_IN_REQUIRED => {
                        coordinator_failure(HARNESS_SIGN_IN_REQUIRED)
                    }
                    Err(_) => coordinator_failure("managed-spawn-uncertain"),
                }
            }
        }
    }

    /// Observation has already been authorized by the durable API. Waiting is
    /// event-driven and keeps the caller's native tool call open, not a new loop.
    async fn wait_for_member<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        context: &ManagedAgentContext,
        actor_member_id: &str,
        member_id: &str,
    ) -> CoordinatorResponse {
        if actor_member_id == member_id {
            return coordinator_failure("cannot-wait-for-self");
        }
        let run = match self
            .current_run(app, &context.workspace_id, &context.run_id)
            .await
        {
            Ok(run) => run,
            Err(_) => return coordinator_failure("run-unavailable"),
        };
        let task = run.tasks().iter().rev().find(|task| {
            run.definition()
                .pipeline
                .steps
                .iter()
                .any(|step| step.id == task.step_id() && step.assigned_member_id == member_id)
        });
        let Some(execution) = task.and_then(|task| task.execution()) else {
            return coordinator_failure("member-not-started");
        };
        if let Ok(active) = self.active(&execution.id) {
            let Ok(mut target) = active.handle.subscribe_turns() else {
                return coordinator_failure("runtime-unavailable");
            };
            let Ok(caller) = self.active(&context.workspace_session_id) else {
                return coordinator_failure("coordinator-origin-invalid");
            };
            let Ok(mut caller_turns) = caller.handle.subscribe_turns() else {
                return coordinator_failure("runtime-unavailable");
            };
            if wait_for_observed_turn(&mut target, &mut caller_turns)
                .await
                .is_err()
            {
                return coordinator_failure("wait-cancelled");
            }
        }
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, &context.workspace_id).is_err()
            || self.is_run_cancelling(&context.workspace_id, &context.run_id)
        {
            return coordinator_failure("wait-cancelled");
        }
        match host.workspace.snapshot(&execution.id).await {
            Ok(snapshot) => CoordinatorResponse::Success(json!({
                "memberId": member_id,
                "status": snapshot.session.status,
                "result": snapshot.blocks.iter().rev().find(|block| {
                    block.kind == piui_runtime::workspace_runtime::BlockKind::Assistant
                }).and_then(|block| block.text.as_deref()),
            })),
            Err(_) => coordinator_failure("result-unavailable"),
        }
    }

    async fn deliver_accepted_message<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        context: &ManagedAgentContext,
        message_id: &str,
        recipient_member_id: &str,
        body: String,
    ) -> bool {
        let run = match self
            .current_run(app, &context.workspace_id, &context.run_id)
            .await
        {
            Ok(run) => run,
            Err(_) => return false,
        };
        let Some(recipient) = execution_for_member(&run, recipient_member_id) else {
            return false;
        };
        let accepted = {
            let host = app.state::<HostState>();
            let _operation = host.live_runtime_operation_gate.lock().await;
            if authorize_live_workspace(&host, &context.workspace_id).is_err() {
                return false;
            }
            host.workspace
                .deliver_managed_message(&recipient, body)
                .await
                .is_ok()
        };
        if !accepted {
            return false;
        }
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, &context.workspace_id).is_err() {
            return false;
        }
        match app
            .state::<OrchestrationApiState>()
            .mark_managed_message_delivered(context, message_id)
        {
            Ok(run) => {
                self.emit_run_invalidation(app, &context.workspace_id, &run);
                true
            }
            Err(_) => false,
        }
    }

    async fn flush_accepted_messages_locked<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
        member_id: &str,
        session_id: &str,
        _operation_gate: &tokio::sync::MutexGuard<'_, ()>,
    ) {
        let Ok(Some(run)) = app
            .state::<OrchestrationApiState>()
            .get_run(workspace_id, run_id)
        else {
            return;
        };
        let messages = run
            .messages()
            .iter()
            .filter(|message| {
                message.status() == MessageStatus::Accepted
                    && message.recipient_member_id() == member_id
            })
            .map(|message| (message.id().to_owned(), message.body().to_owned()))
            .collect::<Vec<_>>();
        for (message_id, body) in messages {
            if app
                .state::<HostState>()
                .workspace
                .deliver_managed_message(session_id, body)
                .await
                .is_ok()
                && let Ok(run) = app
                    .state::<OrchestrationApiState>()
                    .mark_managed_message_delivered(
                        &ManagedAgentContext {
                            workspace_id: workspace_id.to_owned(),
                            run_id: run_id.to_owned(),
                            workspace_session_id: session_id.to_owned(),
                        },
                        &message_id,
                    )
            {
                self.emit_run_invalidation(app, workspace_id, &run);
            }
        }
    }

    async fn mark_lease_uncertain<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        lease: &ControlledSpawnLease,
    ) {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, workspace_id).is_err() {
            return;
        }
        let api = app.state::<OrchestrationApiState>();
        let Ok(Some(current)) = api.get_run(workspace_id, &lease.run_id) else {
            return;
        };
        let Some(task) = current.tasks().iter().find(|task| {
            task.step_id() == lease.step_id && task.lease_id() == Some(lease.lease_id.as_str())
        }) else {
            return;
        };
        if let Ok(run) = api.mark_task_uncertain(
            workspace_id,
            &lease.run_id,
            current.revision(),
            &lease.step_id,
            task.revision(),
            UncertaintyIdentity::Lease(lease.lease_id.clone()),
        ) {
            self.emit_run_invalidation(app, workspace_id, &run);
        }
    }

    async fn mark_execution_uncertain<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        launch: &piui_orchestration::LaunchRequest,
    ) {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        if authorize_live_workspace(&host, workspace_id).is_err() {
            return;
        }
        let api = app.state::<OrchestrationApiState>();
        let Ok(Some(current)) = api.get_run(workspace_id, &launch.run_id) else {
            return;
        };
        let Some(task) = current.tasks().iter().find(|task| {
            task.step_id() == launch.step_id
                && task
                    .execution()
                    .is_some_and(|execution| execution.id == launch.execution.id)
        }) else {
            return;
        };
        if let Ok(run) = api.mark_task_uncertain(
            workspace_id,
            &launch.run_id,
            current.revision(),
            &launch.step_id,
            task.revision(),
            UncertaintyIdentity::Execution(launch.execution.id.clone()),
        ) {
            self.emit_run_invalidation(app, workspace_id, &run);
        }
    }

    fn spawn_reschedule<R: Runtime>(
        &self,
        app: AppHandle<R>,
        workspace_id: String,
        run_id: String,
    ) {
        let scheduler = self.clone();
        let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move {
                let _ = scheduler.schedule_run(&app, &workspace_id, &run_id).await;
            });
        tokio::spawn(future);
    }

    fn emit_run_invalidation<R: Runtime>(&self, app: &AppHandle<R>, workspace_id: &str, run: &Run) {
        let _ = app.emit(
            ORCHESTRATION_EVENT_V4,
            OrchestrationRunChangedEventV4 {
                protocol: 6,
                event_type: "runChanged",
                workspace_id: workspace_id.to_owned(),
                run_id: run.id().to_owned(),
                revision: run.revision(),
            },
        );
    }

    async fn current_run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Run, OrchestrationSchedulerError> {
        let host = app.state::<HostState>();
        let _operation = host.live_runtime_operation_gate.lock().await;
        authorize_live_workspace(&host, workspace_id)?;
        app.state::<OrchestrationApiState>()
            .get_run(workspace_id, run_id)
            .map_err(|_| OrchestrationSchedulerError::conflict())?
            .ok_or_else(OrchestrationSchedulerError::conflict)
    }

    fn begin_cancellation(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<CancellationAdmission, OrchestrationSchedulerError> {
        let key = (workspace_id.to_owned(), run_id.to_owned());
        let mut cancelling = self
            .inner
            .cancelling_runs
            .lock()
            .map_err(|_| OrchestrationSchedulerError::unavailable())?;
        if !cancelling.insert(key.clone()) {
            return Err(OrchestrationSchedulerError::conflict());
        }
        Ok(CancellationAdmission {
            inner: Arc::clone(&self.inner),
            key,
        })
    }

    fn is_run_cancelling(&self, workspace_id: &str, run_id: &str) -> bool {
        self.inner.cancelling_runs.lock().is_ok_and(|cancelling| {
            cancelling.contains(&(workspace_id.to_owned(), run_id.to_owned()))
        })
    }

    fn run_gate(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<RunGate, OrchestrationSchedulerError> {
        let mut gates = self
            .inner
            .run_gates
            .lock()
            .map_err(|_| OrchestrationSchedulerError::unavailable())?;
        Ok(Arc::clone(
            gates
                .entry((workspace_id.to_owned(), run_id.to_owned()))
                .or_default(),
        ))
    }

    fn active(&self, execution_id: &str) -> Result<ActiveExecution, OrchestrationSchedulerError> {
        self.inner
            .active
            .lock()
            .map_err(|_| OrchestrationSchedulerError::unavailable())?
            .get(execution_id)
            .cloned()
            .ok_or_else(OrchestrationSchedulerError::uncertain)
    }

    fn insert_active(
        &self,
        execution_id: String,
        active: ActiveExecution,
    ) -> Result<(), OrchestrationSchedulerError> {
        let replaced = self
            .inner
            .active
            .lock()
            .map_err(|_| OrchestrationSchedulerError::unavailable())?
            .insert(execution_id, active);
        if replaced.is_some() {
            return Err(OrchestrationSchedulerError::conflict());
        }
        Ok(())
    }

    fn remove_active(&self, execution_id: &str) {
        if let Ok(mut active) = self.inner.active.lock() {
            #[cfg(not(feature = "native-prime-scheduler-test"))]
            active.remove(execution_id);
            #[cfg(feature = "native-prime-scheduler-test")]
            if let Some(removed) = active.remove(execution_id) {
                if let Ok(mut completed) = self.inner.completed.lock() {
                    completed.insert(execution_id.to_owned(), removed.handle);
                }
            }
        }
    }

    #[cfg(feature = "native-prime-scheduler-test")]
    fn completed_handle(&self, execution_id: &str) -> Option<WorkspaceRuntimeHandle> {
        self.inner
            .completed
            .lock()
            .ok()
            .and_then(|completed| completed.get(execution_id).cloned())
    }
}

/// Records a certain launch refusal (see `certain_launch_refusal`): a
/// scheduled step fails with `code`, a step spawned by an agent returns to
/// ready for its caller. `None` when the journal could not be updated; the
/// caller then keeps the conservative uncertain path.
fn record_launch_refusal(
    api: &OrchestrationApiState,
    workspace_id: &str,
    lease: &ControlledSpawnLease,
    origin: LaunchOrigin,
    code: &str,
) -> Option<Run> {
    match origin {
        LaunchOrigin::Scheduled => api.reject_leased_task(workspace_id, lease, code).ok(),
        LaunchOrigin::Spawned => {
            let context = ManagedAgentContext {
                workspace_id: workspace_id.to_owned(),
                run_id: lease.run_id.clone(),
                workspace_session_id: String::new(),
            };
            api.release_spawn_lease(&context, lease).ok()?;
            api.get_run(workspace_id, &lease.run_id).ok().flatten()
        }
    }
}

fn workspace_launch_request(
    workspace_id: &str,
    session_id: &str,
    lease: &ControlledSpawnLease,
    policy: LaunchPolicy,
    coordinator: Option<CoordinatorRequestHandler>,
) -> WorkspaceLaunchRequest {
    WorkspaceLaunchRequest {
        session_id: Some(session_id.to_owned()),
        workspace_id: workspace_id.to_owned(),
        harness: harness_kind(lease.profile.harness),
        title: Some(format!("{} - {}", lease.profile.name, lease.step_id)),
        profile_id: Some(lease.profile.id.clone()),
        run_id: Some(lease.run_id.clone()),
        member_id: Some(lease.member_id.clone()),
        task_id: Some(lease.step_id.clone()),
        model: Some(WorkspaceModel {
            id: lease.profile.model.clone(),
            provider: lease.profile.model_provider.clone(),
            name: lease.profile.model.clone(),
            thinking_levels: None,
        }),
        thinking_level: lease.profile.reasoning.clone(),
        base_instructions: lease.profile.base_instructions.clone(),
        service_tier: lease.profile.service_tier.clone(),
        resource_rules: serde_json::to_value(&lease.profile.resource_rules).ok(),
        network_access: lease.profile.network_access,
        instructions: (!lease.profile.instructions.trim().is_empty())
            .then(|| lease.profile.instructions.clone()),
        permission_mode: workspace_permission(lease.profile.permission_mode),
        allowed_tools: policy.allowed_tools,
        // Normal native subagents stay inherited unless the adapter's launch
        // policy fixes them. allowedSpawnProfileIds only governs the
        // authenticated workspace tool's predefined spawn route.
        native_subagents: policy.native_subagents,
        dependency_history_references: lease.dependency_result_references.clone(),
        dependency_outputs: lease.dependency_outputs.clone(),
        coordinator,
    }
}

fn coordinator_handler<R: Runtime>(
    scheduler: OrchestrationScheduler,
    app: AppHandle<R>,
    workspace_id: String,
    run_id: String,
) -> CoordinatorRequestHandler {
    Arc::new(move |origin, operation| {
        let scheduler = scheduler.clone();
        let app = app.clone();
        let workspace_id = workspace_id.clone();
        let run_id = run_id.clone();
        Box::pin(async move {
            scheduler
                .handle_coordinator_request(&app, &workspace_id, &run_id, origin, operation)
                .await
        })
    })
}

fn workspace_event_publisher<R: Runtime>(app: AppHandle<R>) -> WorkspaceEventPublisher {
    Arc::new(move |event| {
        let _ = app.emit(WORKSPACE_EVENT_NAME, event);
    })
}

fn authorize_live_workspace(
    state: &HostState,
    workspace_id: &str,
) -> Result<piui_platform::ProjectDirectory, OrchestrationSchedulerError> {
    if state.is_shutting_down() || state.safe_mode {
        return Err(OrchestrationSchedulerError::unavailable());
    }
    verified_project_directory(state, workspace_id, true)
        .map_err(|_| OrchestrationSchedulerError::unavailable())
}

/// The deterministic next ready step, whatever its executor.
fn next_ready_step(run: &Run) -> Option<PipelineStep> {
    let step_id = piui_orchestration::Coordinator::ready_task_ids(run)
        .first()?
        .to_string();
    run.definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)
        .cloned()
}

/// The snapshotted profile of a native (agent or llm) step.
fn profile_for_step(run: &Run, step: &PipelineStep) -> Option<AgentProfile> {
    let member = run
        .definition()
        .team
        .members
        .iter()
        .find(|member| member.id == step.assigned_member_id)?;
    run.definition()
        .profiles
        .iter()
        .find(|profile| profile.id == member.profile_id)
        .cloned()
}

fn member_for_execution<'a>(run: &'a Run, session_id: &str) -> Option<&'a str> {
    let task = run.tasks().iter().find(|task| {
        task.status() == TaskStatus::Running
            && task
                .execution()
                .is_some_and(|execution| execution.id == session_id)
    })?;
    run.definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == task.step_id())
        .map(|step| step.assigned_member_id.as_str())
}

fn profile_for_execution(run: &Run, session_id: &str) -> Option<AgentProfile> {
    let task = run.tasks().iter().find(|task| {
        task.status() == TaskStatus::Running
            && task
                .execution()
                .is_some_and(|execution| execution.id == session_id)
    })?;
    let step = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == task.step_id())?;
    let member = run
        .definition()
        .team
        .members
        .iter()
        .find(|member| member.id == step.assigned_member_id)?;
    run.definition()
        .profiles
        .iter()
        .find(|profile| profile.id == member.profile_id)
        .cloned()
}

/// Resolves the interpreter of the next ready script step, then leases it.
/// A missing interpreter is a certain failure: nothing ran. Runs under the
/// operation gate with the scheduling pass's run snapshot.
fn admit_script(
    api: &OrchestrationApiState,
    workspace_id: &str,
    run: &Run,
    step: &PipelineStep,
    task_revision: u64,
    lease_id: String,
) -> ScriptAdmission {
    let conflict = || ScriptAdmission::Rejected {
        run: None,
        error: OrchestrationSchedulerError::conflict(),
    };
    let Some(runtime) = script_runtime(step) else {
        return conflict();
    };
    let interpreter = match resolve_interpreter(script_interpreter(runtime)) {
        Ok(interpreter) => interpreter,
        Err(_) => {
            return ScriptAdmission::Rejected {
                run: api
                    .reject_ready_task(
                        workspace_id,
                        run.id(),
                        &step.id,
                        task_revision,
                        SCRIPT_RUNTIME_UNAVAILABLE.to_owned(),
                    )
                    .ok()
                    .map(Box::new),
                error: OrchestrationSchedulerError::new(SCRIPT_RUNTIME_UNAVAILABLE),
            };
        }
    };
    let lease = match api.lease_next_script(workspace_id, run.id(), run.revision(), lease_id) {
        Ok(Some(lease)) => lease,
        Ok(None) => return ScriptAdmission::Idle,
        Err(_) => return conflict(),
    };
    // Defense in depth: the revision check should make this exact.
    if lease.step_id != step.id {
        return conflict();
    }
    match api.get_run(workspace_id, run.id()) {
        Ok(Some(run)) => ScriptAdmission::Leased {
            lease: Box::new(lease),
            interpreter,
            run: Box::new(run),
        },
        _ => conflict(),
    }
}

/// Resolves native dependency results (hash-verified, never copied into
/// the run) into the leased script's stdin and marks the task running under
/// `execution_id`. Every failure here is certain because nothing ran: the
/// task is rejected or its lease released.
async fn prepare_script(
    host: &HostState,
    api: &OrchestrationApiState,
    workspace_id: &str,
    directory: &piui_platform::ProjectDirectory,
    mut lease: ScriptLease,
    interpreter: ResolvedInterpreter,
    execution_id: String,
) -> Result<(ScriptLaunch, Run), (Option<Run>, OrchestrationSchedulerError)> {
    let mut texts = Vec::with_capacity(lease.dependencies.len());
    for dependency in &lease.dependencies {
        let text = match &dependency.reference {
            Some(reference) => match host
                .workspace
                .dependency_text(reference, workspace_id, directory.canonical_path())
                .await
            {
                Ok(text) => Some(text),
                Err(_) => {
                    let run = api
                        .reject_leased_script(workspace_id, &lease, SCRIPT_INPUT_UNAVAILABLE)
                        .ok();
                    return Err((
                        run,
                        OrchestrationSchedulerError::new(SCRIPT_INPUT_UNAVAILABLE),
                    ));
                }
            },
            None => dependency.text.clone(),
        };
        texts.push(text);
    }
    for (dependency, text) in lease.dependencies.iter_mut().zip(texts) {
        dependency.text = text;
    }
    let Ok(stdin) = serde_json::to_vec(&lease.stdin_document()) else {
        let run = api
            .reject_leased_script(workspace_id, &lease, SCRIPT_START_FAILED)
            .ok();
        return Err((run, OrchestrationSchedulerError::new(SCRIPT_START_FAILED)));
    };
    let run = match api.commit_script_lease(workspace_id, &lease, execution_id.clone()) {
        Ok(run) => run,
        Err(_) => {
            let run = api.release_script_lease(workspace_id, &lease).ok();
            return Err((run, OrchestrationSchedulerError::conflict()));
        }
    };
    let result_fields = run
        .definition()
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == lease.step_id)
        .map(|step| step.result_fields.clone())
        .unwrap_or_default();
    Ok((
        ScriptLaunch {
            workspace_id: workspace_id.to_owned(),
            work_dir: api.script_work_root().join(&execution_id),
            project_dir: directory.canonical_path().to_path_buf(),
            execution_id,
            lease,
            interpreter,
            stdin,
            result_fields,
        },
        run,
    ))
}

/// Runs a prepared script and maps what the host observed to what it
/// records. Declared artifact fields are checked like native results.
async fn execute_script(launch: &ScriptLaunch, cancel: watch::Receiver<bool>) -> ScriptResolution {
    let environment = std::env::vars_os().collect::<Vec<_>>();
    let result = run_script(
        ScriptRequest {
            interpreter: &launch.interpreter,
            source: &launch.lease.source,
            stdin: &launch.stdin,
            project_dir: &launch.project_dir,
            work_dir: &launch.work_dir,
            timeout: Duration::from_secs(u64::from(launch.lease.timeout_seconds)),
            host_environment: &environment,
        },
        cancel,
    )
    .await;
    log_script_end(&launch.lease, &result);
    script_resolution(
        &launch.project_dir,
        &launch.result_fields,
        result.map(|run| run.outcome),
    )
    .await
}

/// Maps what the runner observed to what a run records. Declared artifact
/// fields are checked like native results. The editor's script test applies
/// this same mapping, so a test reports exactly what a run would record.
pub(crate) async fn script_resolution(
    project_dir: &std::path::Path,
    result_fields: &[piui_orchestration::ResultField],
    result: Result<ScriptOutcome, ScriptRunError>,
) -> ScriptResolution {
    let failed = |failure| ScriptResolution::Record(ScriptCompletion::Failed { failure });
    match result {
        Ok(ScriptOutcome::Exited {
            code: Some(0),
            stdout,
            ..
        }) => {
            if validate_artifact_files(project_dir, result_fields, &stdout.text)
                .await
                .is_err()
            {
                failed(FailureRecord::new("result-artifact-unavailable"))
            } else {
                ScriptResolution::Record(ScriptCompletion::Exited {
                    stdout: stdout.text,
                    truncated: stdout.truncated,
                })
            }
        }
        Ok(ScriptOutcome::Exited { stdout, stderr, .. }) => {
            failed(script_failure(SCRIPT_FAILED, &stdout.text, &stderr.text))
        }
        Ok(ScriptOutcome::TimedOut { stderr, .. }) => {
            failed(FailureRecord::with_detail(SCRIPT_TIMEOUT, &stderr.text))
        }
        Ok(ScriptOutcome::Cancelled) => ScriptResolution::Stopped,
        Err(ScriptRunError::RuntimeUnavailable) => {
            failed(FailureRecord::new(SCRIPT_RUNTIME_UNAVAILABLE))
        }
        Err(ScriptRunError::NotStarted) => failed(FailureRecord::new(SCRIPT_START_FAILED)),
        Err(ScriptRunError::Unobserved) => ScriptResolution::Unobserved,
    }
}

fn script_runtime(step: &PipelineStep) -> Option<ScriptRuntime> {
    match &step.executor {
        Some(StepExecutor::Script { runtime, .. }) => Some(*runtime),
        _ => None,
    }
}

pub(crate) fn script_interpreter(runtime: ScriptRuntime) -> ScriptInterpreter {
    match runtime {
        ScriptRuntime::Node => ScriptInterpreter::Node,
        ScriptRuntime::Python => ScriptInterpreter::Python,
        ScriptRuntime::PowerShell => ScriptInterpreter::PowerShell,
    }
}

/// Terminates a running script's process tree and returns how it ended, in
/// the terms cancellation uses for native turns.
async fn stop_script(script: &ActiveScript) -> Option<TurnOutcome> {
    script.cancel.send_replace(true);
    let mut ended = script.ended.clone();
    let end = tokio::time::timeout(SCRIPT_STOP_PROOF_TIMEOUT, ended.wait_for(Option::is_some))
        .await
        .ok()?
        .ok()
        .and_then(|end| *end)?;
    match end {
        ScriptEnd::Stopped => Some(TurnOutcome::Interrupted),
        ScriptEnd::Completed { succeeded: true } => Some(TurnOutcome::Succeeded),
        ScriptEnd::Completed { succeeded: false } => Some(TurnOutcome::Failed),
        ScriptEnd::Unobserved => None,
    }
}

/// The failure text a person sees for a script that exited non-zero: its
/// stderr tail, or stdout's when stderr is empty. Bounded by the coordinator.
fn script_failure(code: &str, stdout: &str, stderr: &str) -> FailureRecord {
    let detail = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    FailureRecord::with_detail(code, detail)
}

/// Structured metadata only: never source, stdin or output.
fn log_script_end(lease: &ScriptLease, result: &Result<ScriptRun, ScriptRunError>) {
    let (outcome, exit_code, elapsed) = match result {
        Ok(run) => {
            let (outcome, code) = match &run.outcome {
                ScriptOutcome::Exited { code, .. } => ("exited", *code),
                ScriptOutcome::TimedOut { .. } => ("timed-out", None),
                ScriptOutcome::Cancelled => ("cancelled", None),
            };
            (outcome, code, run.elapsed.as_millis())
        }
        Err(ScriptRunError::RuntimeUnavailable) => ("runtime-unavailable", None, 0),
        Err(ScriptRunError::NotStarted) => ("not-started", None, 0),
        Err(ScriptRunError::Unobserved) => ("unobserved", None, 0),
    };
    let exit_code = exit_code.map_or_else(|| "none".to_owned(), |code| code.to_string());
    eprintln!(
        "event=orchestration_script_ended step_id={:?} runtime={} outcome={outcome} exit_code={exit_code} duration_ms={elapsed}",
        lease.step_id,
        lease.runtime.as_str()
    );
}

fn execution_for_member(run: &Run, member_id: &str) -> Option<String> {
    let mut tasks = run
        .tasks()
        .iter()
        .filter(|task| task.status() == TaskStatus::Running)
        .filter_map(|task| {
            let step = run
                .definition()
                .pipeline
                .steps
                .iter()
                .find(|step| step.id == task.step_id())?;
            if step.assigned_member_id != member_id {
                return None;
            }
            let execution = task.execution()?;
            Some((task.step_id(), execution.id.clone()))
        })
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| left.0.cmp(right.0));
    tasks.first().map(|(_, execution)| execution.clone())
}

async fn wait_for_terminal_outcome(
    turns: &mut watch::Receiver<TurnState>,
    baseline_generation: u64,
) -> Result<TurnOutcome, ()> {
    loop {
        let state = *turns.borrow();
        if state.generation > baseline_generation {
            return state.outcome.ok_or(());
        }
        turns.changed().await.map_err(|_| ())?;
    }
}

async fn wait_for_observed_turn(
    target: &mut watch::Receiver<TurnState>,
    caller: &mut watch::Receiver<TurnState>,
) -> Result<(), ()> {
    let caller_generation = caller.borrow().generation;
    loop {
        if target.borrow().generation > 0 {
            return target.borrow().outcome.map(|_| ()).ok_or(());
        }
        tokio::select! {
            changed = target.changed() => changed.map_err(|_| ())?,
            changed = caller.changed() => {
                changed.map_err(|_| ())?;
                if caller.borrow().generation != caller_generation { return Err(()); }
            }
        }
    }
}

fn coordinator_failure(code: &str) -> CoordinatorResponse {
    CoordinatorResponse::Failure {
        code: code.to_owned(),
        message: "The workspace coordinator could not complete the request.".into(),
    }
}

fn harness_kind(harness: Harness) -> HarnessKind {
    match harness {
        Harness::Pi => HarnessKind::Pi,
        Harness::PrimeAgent => HarnessKind::PrimeAgent,
        Harness::Codex => HarnessKind::Codex,
        Harness::Hermes => HarnessKind::Hermes,
        Harness::ClaudeCode => HarnessKind::ClaudeCode,
    }
}

fn harness_name(harness: Harness) -> &'static str {
    match harness {
        Harness::Pi => "pi",
        Harness::PrimeAgent => "prime-agent",
        Harness::Codex => "codex",
        Harness::Hermes => "hermes",
        Harness::ClaudeCode => "claude-code",
    }
}

fn workspace_permission(mode: piui_orchestration::PermissionMode) -> WorkspacePermissionMode {
    match mode {
        piui_orchestration::PermissionMode::Native => WorkspacePermissionMode::Native,
        piui_orchestration::PermissionMode::ReadOnly => WorkspacePermissionMode::ReadOnly,
        piui_orchestration::PermissionMode::WorkspaceWrite => {
            WorkspacePermissionMode::WorkspaceWrite
        }
        piui_orchestration::PermissionMode::FullAccess => WorkspacePermissionMode::FullAccess,
    }
}

/// Real opt-in proof. This uses the installed Prime Agent adapter, its
/// configured default provider, the real WorkspaceHost process supervisor,
/// durable orchestration store, and the scheduler. Tauri's MockRuntime is
/// used only as an in-memory application state/event container; it does not
/// replace the native agent runtime or provider.
#[cfg(feature = "native-prime-scheduler-test")]
pub async fn run_native_prime_scheduler_two_step_dependency_dag() {
    use crate::orchestration_api::{OrchestrationApiState, StartRunRequest};
    use crate::state::HostState;
    use crate::workspace_api::{
        HarnessKind, PermissionMode as WorkspacePermissionMode, WorkspaceLaunchRequest,
    };
    use piui_index::TrustState;
    use piui_orchestration::{
        AgentProfile, DeclaredToolPolicy, DirectedEdge, Harness, PipelineDefinition, PipelineStep,
        RunStatus, TeamDefinition, TeamMember,
    };
    use piui_platform::ProjectDirectory;
    use piui_runtime::workspace_runtime::BlockKind;
    use std::fs;

    const STEP_ONE_PREFIX: &str = "PIUI_PRIME_SCHEDULER_STEP_ONE";
    const STEP_TWO_PREFIX: &str = "PIUI_PRIME_SCHEDULER_STEP_TWO";
    // Two sequential native operations use the existing 33-second live
    // Prime operation bound from real_rpc, hence this derived total.
    const TWO_STEP_LIVE_BOUND: Duration = Duration::from_secs(66);

    let test_root = std::env::temp_dir().join(format!(
        "piui-native-prime-scheduler-{}",
        uuid::Uuid::new_v4()
    ));
    let step_one_marker = format!("{STEP_ONE_PREFIX}-{}", uuid::Uuid::new_v4());
    let app_data = test_root.join("app-data");
    let project_path = test_root.join("project");
    fs::create_dir_all(&project_path).unwrap();
    let directory = ProjectDirectory::resolve(&project_path).unwrap();
    let host = HostState::open(&app_data, false).unwrap();
    let workspace_id = host
        .index
        .lock()
        .unwrap()
        .register_project_directory(
            &directory,
            Some("Native Prime scheduler test"),
            TrustState::Trusted,
        )
        .unwrap()
        .id;

    // Resolve the configured native default from a real managed snapshot.
    // No auth/settings file or credential value is read or copied.
    let preflight_result = {
        let _operation = host.live_runtime_operation_gate.lock().await;
        let verified = verified_project_directory(&host, &workspace_id, true).unwrap();
        host.workspace
            .launch_session(
                &verified,
                WorkspaceLaunchRequest {
                    session_id: None,
                    workspace_id: workspace_id.clone(),
                    harness: HarnessKind::PrimeAgent,
                    title: Some("Prime scheduler native preflight".into()),
                    profile_id: None,
                    run_id: None,
                    member_id: None,
                    task_id: None,
                    model: None,
                    thinking_level: None,
                    base_instructions: None,
                    service_tier: None,
                    resource_rules: None,
                    network_access: false,
                    instructions: None,
                    permission_mode: WorkspacePermissionMode::Native,
                    allowed_tools: Some(vec![]),
                    native_subagents: Some(false),
                    dependency_history_references: vec![],
                    dependency_outputs: vec![],
                    coordinator: None,
                },
                Arc::new(|_| {}),
            )
            .await
    };
    host.workspace.shutdown_all().await;
    let preflight = preflight_result.expect("Prime native preflight failed");
    let default_model = preflight
        .session
        .model
        .clone()
        .or_else(|| preflight.models.first().cloned());
    let default_model = default_model.expect("Prime default model was not reported");

    let profile = AgentProfile {
        when_to_call: None,
        input_instructions: None,
        expected_result: None,
        id: "prime-profile".into(),
        name: "Prime marker worker".into(),
        harness: Harness::PrimeAgent,
        model_provider: default_model.provider.clone(),
        model: default_model.id.clone(),
        permission_mode: piui_orchestration::PermissionMode::Native,
        network_access: false,
        base_instructions: None,
        service_tier: None,
        resource_rules: None,
        instructions: "Do not call tools. Reply with exactly the marker requested by the task."
            .into(),
        tool_policy: DeclaredToolPolicy {
            rules: ["ipython", "workspace"]
                .into_iter()
                .map(|tool| piui_orchestration::ToolRule {
                    tool: tool.into(),
                    decision: ToolDecision::Deny,
                    enforcement: PolicyEnforcement::Native,
                    mandatory: true,
                })
                .collect(),
        },
        allowed_spawn_profile_ids: vec![],
    };
    let team = TeamDefinition {
        spawned_agents_join_team: false,
        id: "prime-team".into(),
        name: "Prime native team".into(),
        members: vec![TeamMember {
            id: "prime-member".into(),
            profile_id: profile.id.clone(),
        }],
        send_edges: Vec::<DirectedEdge>::new(),
        observe_edges: Vec::<DirectedEdge>::new(),
        orchestrator_member_id: "prime-member".into(),
    };
    let pipeline = PipelineDefinition {
        id: "prime-pipeline".into(),
        name: "Prime native marker DAG".into(),
        steps: vec![
            PipelineStep {
                input_bindings: Vec::new(),
                condition: None,
                route_gates: Vec::new(),
                router: None,
                review: None,
                require_approval: false,
                result_fields: Vec::new(),
                execution_mode: None,
                executor: None,
                input_instructions: None,
                id: "step-one".into(),
                name: "First marker".into(),
                assigned_member_id: "prime-member".into(),
                instructions: format!("Reply with exactly: {step_one_marker}"),
                dependency_step_ids: vec![],
            },
            PipelineStep {
                input_bindings: Vec::new(),
                condition: None,
                route_gates: Vec::new(),
                router: None,
                review: None,
                require_approval: false,
                result_fields: Vec::new(),
                execution_mode: None,
                executor: None,
                input_instructions: None,
                id: "step-two".into(),
                name: "Second marker".into(),
                assigned_member_id: "prime-member".into(),
                instructions: format!(
                    "The dependency contains a marker beginning {STEP_ONE_PREFIX}. Copy that full marker from the dependency and reply exactly: {STEP_TWO_PREFIX}:<copied dependency marker>"
                ),
                dependency_step_ids: vec!["step-one".into()],
            },
        ],
        inputs: Vec::new(),
    };
    let store_directory = app_data.join("orchestration-v6");
    fs::create_dir_all(&store_directory).unwrap();
    let document = serde_json::json!({
        "version": 1,
        "generation": 1,
        "workspaces": [{
            "workspaceId": workspace_id,
            "profiles": [{"revision": 0, "value": profile}],
            "teams": [{"revision": 0, "value": team}],
            "pipelines": [{"revision": 0, "value": pipeline}],
            "launchCommands": [],
            "runs": []
        }]
    });
    fs::write(
        store_directory.join("orchestration-00000000000000000001.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let api = OrchestrationApiState::open(&app_data).unwrap();
    let scheduler = OrchestrationScheduler::default();
    let app = tauri::Builder::<tauri::test::MockRuntime>::new()
        .manage(host)
        .manage(api)
        .manage(scheduler.clone())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let app_handle = app.handle().clone();
    let run = app_handle
        .state::<OrchestrationApiState>()
        .create_run(StartRunRequest {
            workspace_id: workspace_id.clone(),
            run_id: "prime-native-run".into(),
            team_id: "prime-team".into(),
            pipeline_id: "prime-pipeline".into(),
            launch_command_id: None,
            inputs: Default::default(),
        })
        .unwrap();
    assert_eq!(run.status(), RunStatus::Running);
    let schedule_result = scheduler
        .schedule_run(&app_handle, &workspace_id, run.id())
        .await;

    let terminal = if schedule_result.is_ok() {
        Some(
            tokio::time::timeout(TWO_STEP_LIVE_BOUND, async {
                loop {
                    let run = app_handle
                        .state::<OrchestrationApiState>()
                        .get_run(&workspace_id, "prime-native-run")
                        .ok()
                        .flatten();
                    if let Some(run) = run {
                        if run.status() != RunStatus::Running {
                            return run;
                        }
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await,
        )
    } else {
        None
    };

    // Collect proof without asserting. Provider/runtime failure must still
    // reach the explicit shutdown below before the test reports failure.
    let terminal_run = terminal.as_ref().and_then(|result| result.as_ref().ok());
    let first_task =
        terminal_run.and_then(|run| run.tasks().iter().find(|task| task.step_id() == "step-one"));
    let second_task =
        terminal_run.and_then(|run| run.tasks().iter().find(|task| task.step_id() == "step-two"));
    let predecessor_hash = first_task
        .and_then(piui_orchestration::TaskRecord::result_reference)
        .and_then(|reference| reference.content_hash.clone());
    let first_handle = first_task
        .and_then(piui_orchestration::TaskRecord::execution)
        .and_then(|execution| scheduler.completed_handle(&execution.id));
    let second_handle = second_task
        .and_then(piui_orchestration::TaskRecord::execution)
        .and_then(|execution| scheduler.completed_handle(&execution.id));
    let first_snapshot = match first_handle {
        Some(handle) => handle.snapshot().await.ok(),
        None => None,
    };
    let second_snapshot = match second_handle {
        Some(handle) => handle.snapshot().await.ok(),
        None => None,
    };

    app_handle
        .state::<HostState>()
        .workspace
        .shutdown_all()
        .await;
    drop(app_handle);
    drop(app);
    drop(scheduler);
    fs::remove_dir_all(&test_root).expect("native test artifacts stayed open after cleanup");

    schedule_result.expect("native Prime scheduler admission failed");
    let run = terminal
        .expect("native Prime scheduler did not start terminal wait")
        .expect("native Prime two-step scheduler run timed out");
    assert_eq!(run.status(), RunStatus::Succeeded);
    assert!(
        predecessor_hash.is_some(),
        "predecessor result was not bound by content hash"
    );
    let first_snapshot = first_snapshot.expect("first native snapshot was unavailable");
    let second_snapshot = second_snapshot.expect("second native snapshot was unavailable");
    assert!(
        first_snapshot
            .blocks
            .iter()
            .chain(second_snapshot.blocks.iter())
            .all(|block| block.kind != BlockKind::Tool),
        "no-tool native policy admitted a tool block"
    );
    assert!(first_snapshot.blocks.iter().any(|block| {
        block.kind == BlockKind::Assistant
            && block
                .text
                .as_deref()
                .is_some_and(|text| text.contains(&step_one_marker))
    }));
    assert!(second_snapshot.blocks.iter().any(|block| {
        block.kind == BlockKind::User
            && block
                .text
                .as_deref()
                .is_some_and(|text| text.contains(&step_one_marker))
    }));
    assert!(second_snapshot.blocks.iter().any(|block| {
        block.kind == BlockKind::Assistant
            && block.text.as_deref().is_some_and(|text| {
                text.contains(STEP_TWO_PREFIX) && text.contains(&step_one_marker)
            })
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(
        supported: bool,
        enforcement: Enforcement,
    ) -> piui_runtime::workspace_runtime::Capability {
        piui_runtime::workspace_runtime::Capability {
            supported,
            enforcement,
            reason: None,
        }
    }

    fn native_capabilities() -> HarnessCapabilities {
        HarnessCapabilities {
            prompt: capability(true, Enforcement::Native),
            resume: capability(true, Enforcement::Native),
            models: capability(true, Enforcement::Native),
            approvals: capability(true, Enforcement::Native),
            instructions: capability(true, Enforcement::Native),
            tool_policy: capability(true, Enforcement::Native),
            native_subagents: capability(true, Enforcement::Native),
        }
    }

    fn profile(harness: Harness) -> AgentProfile {
        AgentProfile {
            when_to_call: None,
            input_instructions: None,
            expected_result: None,
            id: "profile".into(),
            name: "Worker".into(),
            harness,
            model_provider: Some("provider".into()),
            model: "model".into(),
            permission_mode: piui_orchestration::PermissionMode::Native,
            network_access: false,
            base_instructions: None,
            service_tier: None,
            resource_rules: vec![],
            reasoning: None,
            instructions: "Be exact".into(),
            tool_policy: piui_orchestration::DeclaredToolPolicy { rules: vec![] },
            allowed_spawn_profile_ids: vec![],
        }
    }

    #[tokio::test]
    async fn explicit_failed_and_interrupted_outcomes_never_become_success() {
        for outcome in [TurnOutcome::Failed, TurnOutcome::Interrupted] {
            let (sender, mut receiver) = watch::channel(TurnState {
                generation: 0,
                status: crate::workspace_api::SessionStatus::Idle,
                outcome: None,
            });
            sender.send_replace(TurnState {
                generation: 1,
                status: crate::workspace_api::SessionStatus::Idle,
                outcome: Some(outcome),
            });
            assert_eq!(
                wait_for_terminal_outcome(&mut receiver, 0).await,
                Ok(outcome)
            );
        }
    }

    #[tokio::test]
    async fn idle_without_explicit_completion_is_not_terminal_evidence() {
        let (sender, mut receiver) = watch::channel(TurnState {
            generation: 0,
            status: crate::workspace_api::SessionStatus::Idle,
            outcome: None,
        });
        sender.send_replace(TurnState {
            generation: 0,
            status: crate::workspace_api::SessionStatus::Idle,
            outcome: None,
        });
        drop(sender);
        assert_eq!(wait_for_terminal_outcome(&mut receiver, 0).await, Err(()));
    }

    #[test]
    fn policy_binds_snapshot_and_keeps_prime_native_subagents_inherited() {
        let profile = profile(Harness::PrimeAgent);
        let (_, policy) = launch_policy(&profile, &native_capabilities()).unwrap();
        let lease = ControlledSpawnLease {
            run_id: "run".into(),
            run_revision: 1,
            task_revision: 1,
            lease_id: "lease".into(),
            step_id: "step".into(),
            member_id: "member".into(),
            profile: profile.clone(),
            task_instructions: "Do the work".into(),
            dependency_result_references: vec![],
            dependency_outputs: vec![],
        };
        let request = workspace_launch_request("workspace", "session", &lease, policy, None);
        assert_eq!(request.profile_id.as_deref(), Some("profile"));
        assert_eq!(request.instructions.as_deref(), Some("Be exact"));
        assert_eq!(
            request.model.as_ref().map(|model| model.id.as_str()),
            Some("model")
        );
        assert_eq!(request.native_subagents, None);
        assert_eq!(request.task_id.as_deref(), Some("step"));
    }

    fn native_rule(tool: &str, decision: ToolDecision) -> piui_orchestration::ToolRule {
        piui_orchestration::ToolRule {
            tool: tool.into(),
            decision,
            enforcement: PolicyEnforcement::Native,
            mandatory: true,
        }
    }

    #[test]
    fn claude_code_launch_policy_is_explicit_and_refuses_unsupported_settings() {
        use piui_orchestration::PermissionMode as Mode;
        let native = native_capabilities();
        let mut claude = profile(Harness::ClaudeCode);
        claude.model_provider = Some("anthropic".into());
        claude.reasoning = Some("xhigh".into());
        let (capabilities, policy) = launch_policy(&claude, &native).expect("Claude Code policy");
        assert_eq!(
            capabilities.permission_modes,
            [
                Mode::Native,
                Mode::ReadOnly,
                Mode::WorkspaceWrite,
                Mode::FullAccess
            ]
        );
        assert!(policy.coordinator, "managed runs use the PiUI coordinator");
        assert_eq!(policy.native_subagents, Some(false));
        assert_eq!(policy.allowed_tools, None, "no rules keep the native tools");
        let lease = ControlledSpawnLease {
            run_id: "run".into(),
            run_revision: 1,
            task_revision: 1,
            lease_id: "lease".into(),
            step_id: "step".into(),
            member_id: "member".into(),
            profile: claude.clone(),
            task_instructions: "Review the change".into(),
            dependency_result_references: vec![],
            dependency_outputs: vec![],
        };
        let request = workspace_launch_request("workspace", "session", &lease, policy, None);
        assert_eq!(request.harness, HarnessKind::ClaudeCode);
        assert_eq!(request.native_subagents, Some(false));
        assert_eq!(request.thinking_level.as_deref(), Some("xhigh"));
        assert_eq!(request.service_tier, None);
        assert_eq!(harness_name(Harness::ClaudeCode), "claude-code");

        // Speed, unknown effort, overrides and network are refused before launch.
        for tier in ["fast", "standard"] {
            let mut fast = claude.clone();
            fast.service_tier = Some(tier.into());
            assert!(launch_policy(&fast, &native).is_err(), "{tier}");
        }
        let mut effort = claude.clone();
        effort.reasoning = Some("minimal".into());
        assert!(launch_policy(&effort, &native).is_err());
        let mut provider = claude.clone();
        provider.model_provider = Some("openai".into());
        assert!(launch_policy(&provider, &native).is_err());
        let mut unnamed = claude.clone();
        unnamed.model_provider = None;
        assert!(launch_policy(&unnamed, &native).is_ok());
        let mut resources = claude.clone();
        resources.resource_rules = vec![piui_orchestration::ResourceRule {
            kind: piui_orchestration::ResourceKind::Mcp,
            id: "docs".into(),
            enabled: false,
        }];
        assert!(launch_policy(&resources, &native).is_err());
        let mut network = claude.clone();
        network.permission_mode = Mode::WorkspaceWrite;
        network.network_access = true;
        assert!(launch_policy(&network, &native).is_err());
        let mut base = claude.clone();
        base.base_instructions = Some(String::new());
        assert!(launch_policy(&base, &native).is_err());

        // Native tool rules are an exact built-in allowlist.
        let mut tools = claude.clone();
        tools.tool_policy.rules = vec![
            native_rule("Read", ToolDecision::Allow),
            native_rule("Grep", ToolDecision::Allow),
            native_rule("Bash", ToolDecision::Deny),
        ];
        tools.permission_mode = Mode::ReadOnly;
        let (capabilities, policy) = launch_policy(&tools, &native).expect("read-only allowlist");
        assert_eq!(
            policy.allowed_tools,
            Some(vec!["Grep".into(), "Read".into(), "workspace".into()])
        );
        assert!(
            capabilities
                .native_enforced_tools
                .contains(&"Read".to_owned())
        );
        assert!(
            !capabilities
                .native_enforced_tools
                .contains(&"Agent".to_owned())
        );
        for (mode, tool) in [
            (Mode::ReadOnly, "Bash"),
            (Mode::WorkspaceWrite, "Bash"),
            (Mode::WorkspaceWrite, "PowerShell"),
            (Mode::ReadOnly, "Write"),
            (Mode::FullAccess, "Agent"),
            (Mode::FullAccess, "Task"),
            (Mode::FullAccess, "Bash(git *)"),
            (Mode::FullAccess, "mcp__docs__search"),
        ] {
            let mut unsatisfiable = claude.clone();
            unsatisfiable.permission_mode = mode;
            unsatisfiable.tool_policy.rules = vec![native_rule(tool, ToolDecision::Allow)];
            assert!(
                launch_policy(&unsatisfiable, &native).is_err(),
                "{mode:?} {tool}"
            );
        }
        for (mode, tool) in [(Mode::FullAccess, "Bash"), (Mode::WorkspaceWrite, "Edit")] {
            let mut allowed = claude.clone();
            allowed.permission_mode = mode;
            allowed.tool_policy.rules = vec![native_rule(tool, ToolDecision::Allow)];
            assert!(launch_policy(&allowed, &native).is_ok(), "{mode:?} {tool}");
        }
    }

    #[test]
    fn unsupported_mandatory_instructions_are_rejected_before_launch() {
        let mut capabilities = native_capabilities();
        capabilities.instructions = capability(false, Enforcement::Unsupported);
        assert!(launch_policy(&profile(Harness::Pi), &capabilities).is_err());
    }

    #[test]
    fn network_access_is_explicit_codex_authority_and_reaches_the_runtime() {
        let mut codex = profile(Harness::Codex);
        codex.permission_mode = piui_orchestration::PermissionMode::WorkspaceWrite;
        codex.network_access = true;
        let (_, policy) = launch_policy(&codex, &native_capabilities()).unwrap();
        let lease = ControlledSpawnLease {
            run_id: "run".into(),
            run_revision: 1,
            task_revision: 1,
            lease_id: "lease".into(),
            step_id: "step".into(),
            member_id: "member".into(),
            profile: codex,
            task_instructions: "Fetch public metadata".into(),
            dependency_result_references: vec![],
            dependency_outputs: vec![],
        };
        let request = workspace_launch_request("workspace", "session", &lease, policy, None);
        assert!(request.network_access);

        let mut pi = profile(Harness::Pi);
        pi.permission_mode = piui_orchestration::PermissionMode::ReadOnly;
        pi.network_access = true;
        assert!(launch_policy(&pi, &native_capabilities()).is_err());
    }

    struct FakeTurnAdapter {
        sender: watch::Sender<TurnState>,
        receiver: watch::Receiver<TurnState>,
        next_generation: u64,
    }

    #[tokio::test]
    async fn observed_wait_returns_on_result_and_stops_when_caller_is_cancelled() {
        let mut target = FakeTurnAdapter::new();
        let mut caller = FakeTurnAdapter::new();
        let mut target_rx = target.receiver.clone();
        let mut caller_rx = caller.receiver.clone();
        let waiter = wait_for_observed_turn(&mut target_rx, &mut caller_rx);
        let completion = async {
            target.accept_prompt_with(TurnOutcome::Succeeded);
        };
        let (result, _) = tokio::join!(waiter, completion);
        assert_eq!(result, Ok(()));

        let target = FakeTurnAdapter::new();
        let mut target_rx = target.receiver.clone();
        let waiter = wait_for_observed_turn(&mut target_rx, &mut caller_rx);
        let cancellation = async {
            caller.accept_prompt_with(TurnOutcome::Interrupted);
        };
        let (result, _) = tokio::join!(waiter, cancellation);
        assert_eq!(result, Err(()));
    }

    impl FakeTurnAdapter {
        fn new() -> Self {
            let (sender, receiver) = watch::channel(TurnState {
                generation: 0,
                status: crate::workspace_api::SessionStatus::Idle,
                outcome: None,
            });
            Self {
                sender,
                receiver,
                next_generation: 1,
            }
        }

        fn subscribe_before_prompt(&self) -> (watch::Receiver<TurnState>, u64) {
            let receiver = self.receiver.clone();
            let baseline = receiver.borrow().generation;
            (receiver, baseline)
        }

        fn accept_prompt_with(&mut self, outcome: TurnOutcome) {
            self.sender.send_replace(TurnState {
                generation: 0,
                status: crate::workspace_api::SessionStatus::Running,
                outcome: None,
            });
            self.sender.send_replace(TurnState {
                generation: self.next_generation,
                status: crate::workspace_api::SessionStatus::Idle,
                outcome: Some(outcome),
            });
            self.next_generation = self.next_generation.saturating_add(1);
        }
    }

    fn dag_snapshot() -> piui_orchestration::RunDefinitionSnapshot {
        use piui_orchestration::{
            DirectedEdge, PipelineDefinition, PipelineStep, RunDefinitionSnapshot, TeamDefinition,
            TeamMember,
        };
        RunDefinitionSnapshot {
            profiles: vec![profile(Harness::Codex)],
            team: TeamDefinition {
                spawned_agents_join_team: false,
                id: "team".into(),
                name: "Team".into(),
                members: vec![TeamMember {
                    id: "member".into(),
                    profile_id: "profile".into(),
                }],
                send_edges: Vec::<DirectedEdge>::new(),
                observe_edges: Vec::<DirectedEdge>::new(),
                orchestrator_member_id: "member".into(),
            },
            pipeline: PipelineDefinition {
                id: "pipeline".into(),
                name: "Pipeline".into(),
                steps: vec![
                    PipelineStep {
                        input_bindings: Vec::new(),
                        condition: None,
                        route_gates: Vec::new(),
                        router: None,
                        review: None,
                        require_approval: false,
                        result_fields: Vec::new(),
                        execution_mode: None,
                        executor: None,
                        input_instructions: None,
                        id: "build".into(),
                        name: "Build".into(),
                        assigned_member_id: "member".into(),
                        instructions: "build".into(),
                        dependency_step_ids: vec![],
                    },
                    PipelineStep {
                        input_bindings: Vec::new(),
                        condition: None,
                        route_gates: Vec::new(),
                        router: None,
                        review: None,
                        require_approval: false,
                        result_fields: Vec::new(),
                        execution_mode: None,
                        executor: None,
                        input_instructions: None,
                        id: "review".into(),
                        name: "Review".into(),
                        assigned_member_id: "member".into(),
                        instructions: "review".into(),
                        dependency_step_ids: vec!["build".into()],
                    },
                ],
                inputs: Vec::new(),
            },
            launch_command: None,
        }
    }

    #[tokio::test]
    async fn fake_adapter_two_step_dag_passes_exact_dependency_history_reference() {
        use piui_orchestration::{Coordinator, NativeExecutionReference, RunStatus};
        let mut definition = dag_snapshot();
        let mut prime = profile(Harness::PrimeAgent);
        prime.id = "prime-profile".into();
        definition.profiles.push(prime);
        definition
            .team
            .members
            .push(piui_orchestration::TeamMember {
                id: "prime-member".into(),
                profile_id: "prime-profile".into(),
            });
        definition.pipeline.steps[1].assigned_member_id = "prime-member".into();
        let mut run = Coordinator::new_run("run", definition).unwrap();
        let first = Coordinator::dispatch_next(
            &mut run,
            0,
            NativeExecutionReference { id: "first".into() },
        )
        .unwrap()
        .unwrap();
        let mut adapter = FakeTurnAdapter::new();
        let (mut turns, baseline) = adapter.subscribe_before_prompt();
        adapter.accept_prompt_with(TurnOutcome::Succeeded);
        assert_eq!(
            wait_for_terminal_outcome(&mut turns, baseline).await,
            Ok(TurnOutcome::Succeeded)
        );
        let reference = piui_orchestration::NativeHistoryReference {
            fields: Vec::new(),

            session_id: "first".into(),
            block_id: Some("assistant".into()),
            content_hash: Some("ab".repeat(32)),
        };
        Coordinator::complete_task(
            &mut run,
            first.run_revision,
            &first.step_id,
            first.task_revision,
            &first.execution.id,
            CompletionOutcome::Succeeded {
                result_reference: Some(reference.clone()),
            },
        )
        .unwrap();
        let revision = run.revision();
        let second = Coordinator::dispatch_next(
            &mut run,
            revision,
            NativeExecutionReference {
                id: "second".into(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.profile.harness, Harness::Codex);
        assert_eq!(second.profile.harness, Harness::PrimeAgent);
        assert_eq!(second.dependency_result_references, vec![reference]);
        Coordinator::complete_task(
            &mut run,
            second.run_revision,
            &second.step_id,
            second.task_revision,
            &second.execution.id,
            CompletionOutcome::Succeeded {
                result_reference: Some(piui_orchestration::NativeHistoryReference {
                    fields: Vec::new(),

                    session_id: "second".into(),
                    block_id: Some("assistant".into()),
                    content_hash: Some("cd".repeat(32)),
                }),
            },
        )
        .unwrap();
        assert_eq!(run.status(), RunStatus::Succeeded);
    }

    #[tokio::test]
    async fn fake_adapter_failure_blocks_dependency_and_interrupt_proves_cancel_only() {
        use piui_orchestration::{Coordinator, NativeExecutionReference, RunStatus};
        let mut failed = Coordinator::new_run("failed", dag_snapshot()).unwrap();
        let launch = Coordinator::dispatch_next(
            &mut failed,
            0,
            NativeExecutionReference {
                id: "failed-session".into(),
            },
        )
        .unwrap()
        .unwrap();
        let mut adapter = FakeTurnAdapter::new();
        let (mut turns, baseline) = adapter.subscribe_before_prompt();
        adapter.accept_prompt_with(TurnOutcome::Failed);
        assert_eq!(
            wait_for_terminal_outcome(&mut turns, baseline).await,
            Ok(TurnOutcome::Failed)
        );
        Coordinator::complete_task(
            &mut failed,
            launch.run_revision,
            &launch.step_id,
            launch.task_revision,
            &launch.execution.id,
            CompletionOutcome::Failed {
                failure: FailureRecord::new("native-turn-failed"),
            },
        )
        .unwrap();
        assert!(Coordinator::ready_task_ids(&failed).is_empty());
        assert_eq!(failed.status(), RunStatus::Failed);

        let mut cancelled = Coordinator::new_run("cancelled", dag_snapshot()).unwrap();
        Coordinator::dispatch_next(
            &mut cancelled,
            0,
            NativeExecutionReference {
                id: "cancel-session".into(),
            },
        )
        .unwrap();
        let revision = cancelled.revision();
        let requests = Coordinator::cancellation_requests(&cancelled, revision).unwrap();
        let mut adapter = FakeTurnAdapter::new();
        let (mut turns, baseline) = adapter.subscribe_before_prompt();
        adapter.accept_prompt_with(TurnOutcome::Interrupted);
        assert_eq!(
            wait_for_terminal_outcome(&mut turns, baseline).await,
            Ok(TurnOutcome::Interrupted)
        );
        assert_eq!(requests[0].execution.id, "cancel-session");
        Coordinator::cancel_run(&mut cancelled, revision).unwrap();
        assert_eq!(cancelled.status(), RunStatus::Cancelled);
    }

    #[test]
    fn lease_cas_and_recovery_never_replay_unknown_side_effect() {
        use piui_orchestration::{Coordinator, TaskStatus};
        let mut run = Coordinator::new_run("run", dag_snapshot()).unwrap();
        let lease = Coordinator::lease_next_task(&mut run, 0, "reserved-session".into())
            .unwrap()
            .unwrap();
        assert!(
            Coordinator::lease_next_task(&mut run, lease.run_revision, "duplicate-session".into())
                .unwrap()
                .is_none()
        );
        let stale = Coordinator::dispatch_leased_task(
            &mut run,
            lease.run_revision,
            &lease.step_id,
            lease.task_revision,
            "wrong-lease",
            piui_orchestration::NativeExecutionReference { id: "wrong".into() },
        );
        assert!(stale.is_err());
        let revision = run.revision();
        Coordinator::restore(&mut run, revision).unwrap();
        assert_eq!(run.tasks()[0].status(), TaskStatus::Uncertain);
        assert!(Coordinator::ready_task_ids(&run).is_empty());
    }

    #[test]
    fn cancellation_preserves_a_concurrently_succeeded_parallel_task() {
        use piui_orchestration::{Coordinator, NativeExecutionReference, TaskStatus};
        let mut snapshot = dag_snapshot();
        snapshot.pipeline.steps[1].dependency_step_ids.clear();
        let mut run = Coordinator::new_run("parallel", snapshot).unwrap();
        let first = Coordinator::dispatch_next(
            &mut run,
            0,
            NativeExecutionReference {
                id: "build-session".into(),
            },
        )
        .unwrap()
        .unwrap();
        let revision = run.revision();
        let second = Coordinator::dispatch_next(
            &mut run,
            revision,
            NativeExecutionReference {
                id: "review-session".into(),
            },
        )
        .unwrap()
        .unwrap();
        let latest = run.revision();
        Coordinator::complete_task(
            &mut run,
            latest,
            &first.step_id,
            first.task_revision,
            &first.execution.id,
            CompletionOutcome::Succeeded {
                result_reference: Some(piui_orchestration::NativeHistoryReference {
                    fields: Vec::new(),

                    session_id: "build-session".into(),
                    block_id: Some("assistant".into()),
                    content_hash: Some("ef".repeat(32)),
                }),
            },
        )
        .unwrap();
        let revision = run.revision();
        let cancels = Coordinator::cancellation_requests(&run, revision).unwrap();
        assert_eq!(cancels.len(), 1);
        assert_eq!(cancels[0].execution.id, second.execution.id);
        Coordinator::cancel_run(&mut run, revision).unwrap();
        let build = run
            .tasks()
            .iter()
            .find(|task| task.step_id() == "build")
            .unwrap();
        let review = run
            .tasks()
            .iter()
            .find(|task| task.step_id() == "review")
            .unwrap();
        assert_eq!(build.status(), TaskStatus::Succeeded);
        assert_eq!(review.status(), TaskStatus::Cancelled);
    }

    #[test]
    fn native_tool_policy_rejects_self_attested_comma_glob_and_unknown_names() {
        for tool in ["read,write", "*", "made-up-tool"] {
            let mut profile = profile(Harness::Pi);
            profile.tool_policy.rules = vec![
                piui_orchestration::ToolRule {
                    tool: "write".into(),
                    decision: ToolDecision::Deny,
                    enforcement: PolicyEnforcement::Native,
                    mandatory: true,
                },
                piui_orchestration::ToolRule {
                    tool: tool.into(),
                    decision: ToolDecision::Allow,
                    enforcement: PolicyEnforcement::Native,
                    mandatory: true,
                },
            ];
            assert!(launch_policy(&profile, &native_capabilities()).is_err());
        }

        let mut contradictory = profile(Harness::Pi);
        contradictory.tool_policy.rules = vec![
            piui_orchestration::ToolRule {
                tool: "write".into(),
                decision: ToolDecision::Allow,
                enforcement: PolicyEnforcement::Native,
                mandatory: true,
            },
            piui_orchestration::ToolRule {
                tool: "write".into(),
                decision: ToolDecision::Deny,
                enforcement: PolicyEnforcement::Native,
                mandatory: true,
            },
        ];
        assert!(launch_policy(&contradictory, &native_capabilities()).is_err());

        let mut prime = profile(Harness::PrimeAgent);
        prime.tool_policy.rules = vec![piui_orchestration::ToolRule {
            tool: "bash".into(),
            decision: ToolDecision::Allow,
            enforcement: PolicyEnforcement::Native,
            mandatory: true,
        }];
        assert!(launch_policy(&prime, &native_capabilities()).is_err());
    }

    #[test]
    fn pi_native_allowlist_applies_deny_precedence_with_literal_names_only() {
        let mut profile = profile(Harness::Pi);
        profile.tool_policy.rules = vec![
            piui_orchestration::ToolRule {
                tool: "read".into(),
                decision: ToolDecision::Allow,
                enforcement: PolicyEnforcement::Native,
                mandatory: true,
            },
            piui_orchestration::ToolRule {
                tool: "write".into(),
                decision: ToolDecision::Deny,
                enforcement: PolicyEnforcement::Native,
                mandatory: true,
            },
        ];
        let (capabilities, policy) = launch_policy(&profile, &native_capabilities()).unwrap();
        assert_eq!(policy.allowed_tools, Some(vec!["read".into()]));
        assert_eq!(
            capabilities.native_enforced_tools,
            PI_NATIVE_TOOL_NAMES
                .iter()
                .map(|tool| (*tool).to_owned())
                .collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
#[path = "orchestration_script_tests.rs"]
mod script_tests;

#[cfg(test)]
#[path = "orchestration_sign_in_tests.rs"]
mod sign_in_tests;
