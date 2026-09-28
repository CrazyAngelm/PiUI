//! Sub-pipelines in the host (orchestration v6.7, ADR-042).
//!
//! The coordinator owns the step's lease, dispatch and result checks
//! (`piui_orchestration::subpipelines`); the scheduler admits and starts the
//! child (`orchestration_subpipeline_steps.rs`). This module holds the
//! project-level rules and the observer of child ends:
//!
//! - [`plan_child_start`] re-checks, inside the start transaction, that the
//!   launch command, its team and pipeline exist in the project, the nesting
//!   depth, reference cycles (static and through the running ancestors) and
//!   the child's inputs. Every refusal is certain: nothing started.
//! - [`check_saved_pipeline`] and [`check_reference_cycles`] refuse saves
//!   with unknown references, unknown or incompatible child inputs, missing
//!   required inputs and reference cycles; [`check_parents`] refuses a
//!   child change that would break a saved parent's step; [`check_delete`]
//!   keeps a referenced launch command (and its pipeline and team) from
//!   being deleted. Refusals carry the specific `subpipeline-*` command
//!   codes (`StoreError::Refused`).
//! - [`SubpipelineEngine`] observes committed generations (like the board
//!   engine) and completes a running parent step when its child run ended:
//!   declared outputs (native text hash-verified), `subpipeline-failed` or
//!   `subpipeline-cancelled`. It is idempotent: a step that is no longer
//!   running is ignored, and the first observation after a restart catches
//!   up on ends missed while PiUI was closed. Safe mode never starts it.
//!
//! Logs carry metadata only (ids and codes), never inputs or results.

use crate::orchestration_api::{
    OrchestrationApiState, StartRunRequest, emit_run_changed, validate_live_workspace_scope,
};
use crate::orchestration_scheduler::OrchestrationScheduler;
use crate::orchestration_store::{StoreError, WorkspaceOrchestration};
use crate::state::HostState;
use piui_orchestration::{
    MAX_SUBPIPELINE_DEPTH, PipelineDefinition, PipelineInput, PipelineInputKind, PipelineStep,
    PipelineStepLease, ResultFieldKind, Run, RunStatus, RunTrigger, SUBPIPELINE_CYCLE,
    SUBPIPELINE_INPUT_INVALID, SUBPIPELINE_UNAVAILABLE, StepExecutor, SubpipelineInputSource,
    TaskStatus, UncertaintyIdentity,
};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Notify;

/// Why a leased sub-pipeline step did not start its child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChildStartError {
    /// A certain refusal with its `subpipeline-*` code: nothing started.
    Refused(&'static str),
    /// The journal changed meanwhile; the lease can be released.
    Conflict,
}

/// The pipeline launch command `id` runs in this project.
pub(crate) fn pipeline_of_command<'w>(
    workspace: &'w WorkspaceOrchestration,
    id: &str,
) -> Option<&'w PipelineDefinition> {
    let command = workspace
        .launch_commands
        .iter()
        .find(|command| command.value.id == id)?;
    workspace
        .pipelines
        .iter()
        .find(|pipeline| pipeline.value.id == command.value.pipeline_id)
        .map(|pipeline| &pipeline.value)
}

/// Whether a saved pipeline of the project has a sub-pipeline step that
/// runs launch command `id`.
pub(crate) fn launch_command_referenced(workspace: &WorkspaceOrchestration, id: &str) -> bool {
    workspace.pipelines.iter().any(|pipeline| {
        pipeline.value.steps.iter().any(|step| {
            matches!(
                &step.executor,
                Some(StepExecutor::Pipeline { launch_command_id, .. }) if launch_command_id == id
            )
        })
    })
}

/// The start of a leased sub-pipeline step's child run, checked against the
/// current definitions of the project: the launch command with its team and
/// pipeline, the nesting depth, reference cycles and the child's inputs.
/// `lease.dependencies` carry the native text the host resolved.
pub(crate) fn plan_child_start(
    workspace: &WorkspaceOrchestration,
    parent: &Run,
    lease: &PipelineStepLease,
    child_run_id: &str,
) -> Result<(StartRunRequest, RunTrigger), &'static str> {
    let command = workspace
        .launch_commands
        .iter()
        .find(|command| command.value.id == lease.launch_command_id)
        .map(|command| &command.value)
        .ok_or(SUBPIPELINE_UNAVAILABLE)?;
    if !workspace
        .teams
        .iter()
        .any(|team| team.value.id == command.team_id)
    {
        return Err(SUBPIPELINE_UNAVAILABLE);
    }
    let pipeline = pipeline_of_command(workspace, &command.id).ok_or(SUBPIPELINE_UNAVAILABLE)?;
    let trigger = lease.child_trigger()?;
    let ancestors = piui_orchestration::ancestor_launch_commands(parent, |id| {
        workspace.runs.iter().find(|run| run.id() == id)
    });
    if ancestors.contains(&command.id)
        || piui_orchestration::subpipeline_cycle(&command.id, |id| {
            pipeline_of_command(workspace, id)
        })
    {
        return Err(SUBPIPELINE_CYCLE);
    }
    let inputs = piui_orchestration::resolve_child_inputs(
        &lease.sources,
        &lease.run_inputs,
        &lease.dependencies,
    )?;
    piui_orchestration::resolve_run_inputs(&pipeline.inputs, &inputs)
        .map_err(|_| SUBPIPELINE_INPUT_INVALID)?;
    Ok((
        StartRunRequest {
            workspace_id: workspace.workspace_id.clone(),
            run_id: child_run_id.to_owned(),
            team_id: command.team_id.clone(),
            pipeline_id: command.pipeline_id.clone(),
            launch_command_id: Some(command.id.clone()),
            inputs,
            // A child never uses pinned data (ADR-042).
            use_pinned_data: false,
        },
        trigger,
    ))
}

/// Command error code (v6.7): a sub-pipeline step names a launch command
/// that is not saved in this project, or whose pipeline is gone.
pub(crate) const SUBPIPELINE_UNKNOWN_PIPELINE: &str = "subpipeline-unknown-pipeline";
/// Command error code (v6.7): a step maps an input the child does not
/// declare, a value of another kind, or leaves a required input unmapped.
pub(crate) const SUBPIPELINE_INPUT_MISMATCH: &str = "subpipeline-input-mismatch";
/// Command error code (v6.7): a launch command, or its pipeline or team, is
/// still run by a saved pipeline's sub-pipeline step.
pub(crate) const SUBPIPELINE_IN_USE: &str = "subpipeline-in-use";
/// Command error code (v6.7): the change would make a saved parent's
/// sub-pipeline step no longer fit the child it runs.
pub(crate) const SUBPIPELINE_BREAKS_PARENT: &str = "subpipeline-breaks-parent";

/// Why a save's sub-pipeline references are refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum SubpipelineReferenceError {
    #[error("step {step_id} runs a launch command that is not saved in this project")]
    UnknownLaunchCommand { step_id: String },
    #[error("step {step_id} maps input {name}, which the sub-pipeline does not declare")]
    UnknownInput { step_id: String, name: String },
    #[error("step {step_id} maps input {name} from a value of another kind")]
    IncompatibleInput { step_id: String, name: String },
    #[error("step {step_id} does not map the required input {name} of the sub-pipeline")]
    MissingRequiredInput { step_id: String, name: String },
    #[error("launch command {launch_command_id} would run itself through sub-pipelines")]
    Cycle { launch_command_id: String },
    #[error("step {step_id} of pipeline {pipeline_id} would no longer fit its sub-pipeline")]
    BreaksParent {
        pipeline_id: String,
        step_id: String,
    },
}

impl SubpipelineReferenceError {
    /// A stable, finer code for structured logs.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::UnknownLaunchCommand { .. } => "subpipeline-unknown-launch-command",
            Self::UnknownInput { .. } => "subpipeline-unknown-input",
            Self::IncompatibleInput { .. } => "subpipeline-incompatible-input",
            Self::MissingRequiredInput { .. } => "subpipeline-missing-input",
            Self::Cycle { .. } => SUBPIPELINE_CYCLE,
            Self::BreaksParent { .. } => SUBPIPELINE_BREAKS_PARENT,
        }
    }

    /// The command error code the UI receives.
    pub(crate) fn api_code(&self) -> &'static str {
        match self {
            Self::UnknownLaunchCommand { .. } => SUBPIPELINE_UNKNOWN_PIPELINE,
            Self::UnknownInput { .. }
            | Self::IncompatibleInput { .. }
            | Self::MissingRequiredInput { .. } => SUBPIPELINE_INPUT_MISMATCH,
            Self::Cycle { .. } => SUBPIPELINE_CYCLE,
            Self::BreaksParent { .. } => SUBPIPELINE_BREAKS_PARENT,
        }
    }

    /// The refusal for a store transaction, logged with metadata only.
    fn refuse(&self) -> StoreError {
        eprintln!(
            "event=subpipeline_save_refused code={} api_code={}",
            self.code(),
            self.api_code()
        );
        StoreError::Refused(self.api_code())
    }
}

/// The input mapping of sub-pipeline step `step_id` of `pipeline` against
/// the child it runs: only declared child inputs with compatible values,
/// and every required child input without a default.
fn validate_step_inputs(
    pipeline: &PipelineDefinition,
    step_id: &str,
    inputs: &BTreeMap<String, SubpipelineInputSource>,
    child: &PipelineDefinition,
) -> Result<(), SubpipelineReferenceError> {
    for (name, source) in inputs {
        let Some(input) = child.inputs.iter().find(|input| input.name == *name) else {
            return Err(SubpipelineReferenceError::UnknownInput {
                step_id: step_id.to_owned(),
                name: name.clone(),
            });
        };
        if !source_compatible(pipeline, source, input) {
            return Err(SubpipelineReferenceError::IncompatibleInput {
                step_id: step_id.to_owned(),
                name: name.clone(),
            });
        }
    }
    if let Some(missing) = child.inputs.iter().find(|input| {
        input.required && input.default_value.is_none() && !inputs.contains_key(&input.name)
    }) {
        return Err(SubpipelineReferenceError::MissingRequiredInput {
            step_id: step_id.to_owned(),
            name: missing.name.clone(),
        });
    }
    Ok(())
}

/// Whether the result fields a sub-pipeline step declares are outputs of
/// its child with the same name and kind. A child without declared outputs
/// hands on its last step's text, which is checked when the step completes.
fn result_fields_fit(step: &PipelineStep, child: &PipelineDefinition) -> bool {
    child.outputs.is_empty()
        || step.result_fields.iter().all(|field| {
            child
                .outputs
                .iter()
                .any(|output| output.name == field.name && output.kind == field.kind)
        })
}

/// Whether sub-pipeline step `step` of `parent` fits `child`: its input
/// mapping and its declared result fields.
fn step_fits(
    parent: &PipelineDefinition,
    step: &PipelineStep,
    inputs: &BTreeMap<String, SubpipelineInputSource>,
    child: &PipelineDefinition,
) -> bool {
    validate_step_inputs(parent, &step.id, inputs, child).is_ok() && result_fields_fit(step, child)
}

/// The references of `pipeline` (already in place in `workspace`): every
/// sub-pipeline step names a launch command of this project, maps only
/// declared child inputs with compatible values and every required child
/// input without a default, and no launch command reaches itself.
pub(crate) fn validate_pipeline_references(
    workspace: &WorkspaceOrchestration,
    pipeline: &PipelineDefinition,
) -> Result<(), SubpipelineReferenceError> {
    for step in &pipeline.steps {
        let Some(StepExecutor::Pipeline {
            launch_command_id,
            inputs,
        }) = &step.executor
        else {
            continue;
        };
        let unknown = || SubpipelineReferenceError::UnknownLaunchCommand {
            step_id: step.id.clone(),
        };
        let command = workspace
            .launch_commands
            .iter()
            .find(|command| command.value.id == *launch_command_id)
            .ok_or_else(unknown)?;
        let child = if command.value.pipeline_id == pipeline.id {
            pipeline
        } else {
            pipeline_of_command(workspace, launch_command_id).ok_or_else(unknown)?
        };
        validate_step_inputs(pipeline, &step.id, inputs, child)?;
    }
    match reference_cycle(workspace) {
        Some(launch_command_id) => Err(SubpipelineReferenceError::Cycle { launch_command_id }),
        None => Ok(()),
    }
}

/// A launch command of the project from which a reference cycle is reachable.
pub(crate) fn reference_cycle(workspace: &WorkspaceOrchestration) -> Option<String> {
    workspace
        .launch_commands
        .iter()
        .map(|command| &command.value.id)
        .find(|id| {
            piui_orchestration::subpipeline_cycle(id, |candidate| {
                pipeline_of_command(workspace, candidate)
            })
        })
        .cloned()
}

/// `validate_pipeline_references` for a store transaction.
pub(crate) fn check_saved_pipeline(
    workspace: &WorkspaceOrchestration,
    pipeline: &PipelineDefinition,
) -> Result<(), StoreError> {
    validate_pipeline_references(workspace, pipeline).map_err(|error| error.refuse())
}

/// Refuses a save after which a launch command reaches itself.
pub(crate) fn check_reference_cycles(workspace: &WorkspaceOrchestration) -> Result<(), StoreError> {
    match reference_cycle(workspace) {
        Some(launch_command_id) => {
            Err(SubpipelineReferenceError::Cycle { launch_command_id }.refuse())
        }
        None => Ok(()),
    }
}

/// What a save changed that saved parents' sub-pipeline steps may depend
/// on. The workspace already holds the new definitions.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ChildChange<'a> {
    /// A saved pipeline: its id and its definition before the save
    /// (`None` when it is new).
    pub pipeline: Option<(&'a str, Option<&'a PipelineDefinition>)>,
    /// A launch command that now runs another pipeline: its id and the id
    /// of the pipeline it ran before.
    pub retargeted: Option<(&'a str, &'a str)>,
}

impl<'a> ChildChange<'a> {
    /// The child launch command `id` ran before the change: `None` when the
    /// change does not affect it, `Some(None)` when it is unknown.
    fn previous_child(
        &self,
        workspace: &'a WorkspaceOrchestration,
        id: &str,
    ) -> Option<Option<&'a PipelineDefinition>> {
        let before = |pipeline_id: &str| match self.pipeline {
            Some((changed, previous)) if changed == pipeline_id => previous,
            _ => workspace
                .pipelines
                .iter()
                .find(|pipeline| pipeline.value.id == pipeline_id)
                .map(|pipeline| &pipeline.value),
        };
        if let Some((command, old_pipeline_id)) = self.retargeted
            && command == id
        {
            return Some(before(old_pipeline_id));
        }
        let (changed, previous) = self.pipeline?;
        workspace
            .launch_commands
            .iter()
            .any(|command| command.value.id == id && command.value.pipeline_id == changed)
            .then_some(previous)
    }
}

/// Every other saved pipeline whose sub-pipeline step runs a launch command
/// the change affects must still fit its child: the same input rules as a
/// save, and declared result fields among the child's outputs. A step that
/// did not fit the child before the change does not block it.
pub(crate) fn validate_parents<'a>(
    workspace: &'a WorkspaceOrchestration,
    change: ChildChange<'a>,
) -> Result<(), SubpipelineReferenceError> {
    let saved = change.pipeline.map(|(id, _)| id);
    for parent in &workspace.pipelines {
        // The saved pipeline's own steps are checked by its own save.
        if saved == Some(parent.value.id.as_str()) {
            continue;
        }
        for step in &parent.value.steps {
            let Some(StepExecutor::Pipeline {
                launch_command_id,
                inputs,
            }) = &step.executor
            else {
                continue;
            };
            let Some(before) = change.previous_child(workspace, launch_command_id) else {
                continue;
            };
            let Some(after) = pipeline_of_command(workspace, launch_command_id) else {
                continue;
            };
            if step_fits(&parent.value, step, inputs, after) {
                continue;
            }
            if before.is_none_or(|before| step_fits(&parent.value, step, inputs, before)) {
                return Err(SubpipelineReferenceError::BreaksParent {
                    pipeline_id: parent.value.id.clone(),
                    step_id: step.id.clone(),
                });
            }
        }
    }
    Ok(())
}

/// `validate_parents` for a store transaction.
pub(crate) fn check_parents<'a>(
    workspace: &'a WorkspaceOrchestration,
    change: ChildChange<'a>,
) -> Result<(), StoreError> {
    validate_parents(workspace, change).map_err(|error| error.refuse())
}

/// Refuses deleting a definition a saved sub-pipeline step still needs:
/// a launch command such a step runs (`runs_it` selects the commands the
/// deleted definition belongs to), or the pipeline or team of one.
pub(crate) fn check_delete(
    workspace: &WorkspaceOrchestration,
    runs_it: impl Fn(&piui_orchestration::LaunchCommandReference) -> bool,
) -> Result<(), StoreError> {
    let in_use = workspace
        .launch_commands
        .iter()
        .filter(|command| runs_it(&command.value))
        .any(|command| launch_command_referenced(workspace, &command.value.id));
    if in_use {
        eprintln!("event=subpipeline_delete_refused code={SUBPIPELINE_IN_USE}");
        return Err(StoreError::Refused(SUBPIPELINE_IN_USE));
    }
    Ok(())
}

/// Whether a text kind of child input can take a text value.
fn takes_text(kind: PipelineInputKind) -> bool {
    matches!(
        kind,
        PipelineInputKind::Text | PipelineInputKind::LongText | PipelineInputKind::Choice
    )
}

/// Whether `source` can satisfy child input `input`. Values and parent
/// inputs are checked exactly; dependency results are checked by declared
/// kind (a choice is checked again when the child starts).
fn source_compatible(
    pipeline: &PipelineDefinition,
    source: &SubpipelineInputSource,
    input: &PipelineInput,
) -> bool {
    match source {
        SubpipelineInputSource::Value { value } => {
            piui_orchestration::validate_input_value(input, value).is_ok()
        }
        SubpipelineInputSource::Input { name } => {
            let Some(parent) = pipeline.inputs.iter().find(|parent| parent.name == *name) else {
                return false;
            };
            match input.kind {
                PipelineInputKind::Text | PipelineInputKind::LongText => takes_text(parent.kind),
                PipelineInputKind::Number => parent.kind == PipelineInputKind::Number,
                PipelineInputKind::Boolean => parent.kind == PipelineInputKind::Boolean,
                PipelineInputKind::Choice => {
                    parent.kind == PipelineInputKind::Choice
                        && parent
                            .options
                            .iter()
                            .all(|option| input.options.contains(option))
                }
            }
        }
        SubpipelineInputSource::Step { step_id, field } => {
            let Some(field) = field else {
                return takes_text(input.kind);
            };
            let declared = pipeline
                .steps
                .iter()
                .find(|candidate| candidate.id == *step_id)
                .and_then(|source| {
                    source
                        .result_fields
                        .iter()
                        .find(|candidate| candidate.name == *field)
                });
            match declared.map(|declared| declared.kind) {
                // Undeclared data is checked when the child starts.
                None => true,
                Some(ResultFieldKind::Text | ResultFieldKind::Artifact) => takes_text(input.kind),
                Some(ResultFieldKind::Number) => input.kind == PipelineInputKind::Number,
                Some(ResultFieldKind::Boolean) => input.kind == PipelineInputKind::Boolean,
                Some(ResultFieldKind::TextList) => false,
            }
        }
    }
}

/// Child runs of `run_id`'s running sub-pipeline steps (only `step_id` when
/// given) that are still running: what a cancellation cancels first.
pub(crate) fn running_children(
    workspace: &WorkspaceOrchestration,
    run_id: &str,
    step_id: Option<&str>,
) -> Vec<String> {
    let Some(run) = workspace.runs.iter().find(|run| run.id() == run_id) else {
        return Vec::new();
    };
    let steps = pipeline_step_ids(run);
    run.tasks()
        .iter()
        .filter(|task| task.status() == TaskStatus::Running && steps.contains(task.step_id()))
        .filter(|task| step_id.is_none_or(|id| task.step_id() == id))
        .filter_map(|task| task.execution().map(|execution| execution.id.clone()))
        .filter(|child| {
            workspace
                .runs
                .iter()
                .any(|run| run.id() == child && run.status() == RunStatus::Running)
        })
        .collect()
}

/// Ids of the sub-pipeline steps of a run's frozen snapshot.
pub(crate) fn pipeline_step_ids(run: &Run) -> HashSet<String> {
    run.definition()
        .pipeline
        .steps
        .iter()
        .filter(|step| step.is_pipeline())
        .map(|step| step.id.clone())
        .collect()
}

/// Whether a running parent step still waits for `run` (its child run):
/// its record must stay until the parent records the end.
pub(crate) fn parent_waits_for(workspace: &WorkspaceOrchestration, run: &Run) -> bool {
    let Some((parent_id, step_id)) = run.trigger().and_then(RunTrigger::pipeline_parent) else {
        return false;
    };
    workspace
        .runs
        .iter()
        .find(|parent| parent.id() == parent_id)
        .is_some_and(|parent| {
            parent.tasks().iter().any(|task| {
                task.step_id() == step_id
                    && task.status() == TaskStatus::Running
                    && task
                        .execution()
                        .is_some_and(|execution| execution.id == run.id())
            })
        })
}

/// Event hops behind a run for loop protection: a sub-pipeline child has
/// none of its own and inherits those of its top-level run.
pub(crate) fn inherited_chain_depth(runs: &[Run], run: &Run) -> u8 {
    let mut current = run;
    let mut depth = run.chain_depth();
    for _ in 0..=MAX_SUBPIPELINE_DEPTH {
        let Some((parent_id, _)) = current.trigger().and_then(RunTrigger::pipeline_parent) else {
            break;
        };
        let Some(parent) = runs.iter().find(|candidate| candidate.id() == parent_id) else {
            break;
        };
        depth = depth.max(parent.chain_depth());
        current = parent;
    }
    depth
}

/// What became of the child run of a running parent step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ChildEnd {
    /// The child succeeded, failed or was cancelled.
    Ended,
    /// No run of the project has the child id (or it is not this step's
    /// child): its outcome can never be observed.
    Missing,
}

/// A running parent sub-pipeline step whose child ended.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PendingEnd {
    pub workspace_id: String,
    pub parent_run_id: String,
    pub step_id: String,
    pub child_run_id: String,
    pub task_revision: u64,
    pub child: ChildEnd,
}

fn run_ended(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
    )
}

/// Every running sub-pipeline step whose child run ended or is gone, in
/// deterministic order. A running or uncertain child is not an end.
pub(crate) fn pending_subpipeline_ends(workspaces: &[WorkspaceOrchestration]) -> Vec<PendingEnd> {
    let mut pending = Vec::new();
    for workspace in workspaces {
        for run in &workspace.runs {
            let steps = pipeline_step_ids(run);
            if steps.is_empty() {
                continue;
            }
            for task in run.tasks() {
                if task.status() != TaskStatus::Running || !steps.contains(task.step_id()) {
                    continue;
                }
                let Some(execution) = task.execution() else {
                    continue;
                };
                let child = workspace.runs.iter().find(|child| {
                    child.id() == execution.id
                        && child.trigger().and_then(RunTrigger::pipeline_parent)
                            == Some((run.id(), task.step_id()))
                });
                let ended = match child {
                    Some(child) if run_ended(child.status()) => ChildEnd::Ended,
                    Some(_) => continue,
                    None => ChildEnd::Missing,
                };
                pending.push(PendingEnd {
                    workspace_id: workspace.workspace_id.clone(),
                    parent_run_id: run.id().to_owned(),
                    step_id: task.step_id().to_owned(),
                    child_run_id: execution.id.clone(),
                    task_revision: task.revision(),
                    child: ended,
                });
            }
        }
    }
    pending
}

#[derive(Default)]
struct EngineInner {
    started: AtomicBool,
    stopping: AtomicBool,
    stop: Notify,
    wake: Notify,
}

/// Managed state completing parent sub-pipeline steps from committed
/// generations.
#[derive(Clone, Default)]
pub(crate) struct SubpipelineEngine {
    inner: Arc<EngineInner>,
}

impl SubpipelineEngine {
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

    /// Observes again without a new commit, for example after a
    /// cancellation that held parents back ended.
    pub(crate) fn wake(&self) {
        self.inner.wake.notify_one();
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
        let mut attempted = HashSet::new();
        self.observe(&app, &mut attempted).await;
        loop {
            if self.stopping() {
                break;
            }
            tokio::select! {
                changed = commits.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    self.observe(&app, &mut attempted).await;
                }
                () = self.inner.wake.notified() => self.observe(&app, &mut attempted).await,
                () = self.inner.stop.notified() => break,
            }
        }
    }

    /// Completes every parent step whose child ended. An end already tried
    /// at the same task revision is not tried again.
    async fn observe<R: Runtime>(&self, app: &AppHandle<R>, attempted: &mut HashSet<PendingEnd>) {
        let Some(api) = app.try_state::<OrchestrationApiState>() else {
            return;
        };
        let Ok(snapshot) = api.snapshot() else {
            return;
        };
        let pending = pending_subpipeline_ends(snapshot.workspaces());
        attempted.retain(|end| pending.contains(end));
        let scheduler = app.try_state::<OrchestrationScheduler>();
        for end in pending {
            if self.stopping() {
                return;
            }
            // A cancellation of the parent records the step itself.
            let cancelling = scheduler.as_ref().is_some_and(|scheduler| {
                scheduler.is_run_cancelling(&end.workspace_id, &end.parent_run_id)
            });
            if cancelling || attempted.contains(&end) {
                continue;
            }
            let child = snapshot.workspace(&end.workspace_id).and_then(|workspace| {
                workspace
                    .runs
                    .iter()
                    .find(|run| run.id() == end.child_run_id)
            });
            if finish(app, &end, child).await {
                attempted.insert(end);
            }
        }
    }
}

/// Records one child end on its parent step. Returns whether an attempt was
/// made (false when the project is not live: a later observation retries).
async fn finish<R: Runtime>(app: &AppHandle<R>, end: &PendingEnd, child: Option<&Run>) -> bool {
    let (Some(host), Some(api)) = (
        app.try_state::<HostState>(),
        app.try_state::<OrchestrationApiState>(),
    ) else {
        return false;
    };
    if validate_live_workspace_scope(&host, &end.workspace_id).is_err() {
        return false;
    }
    // `None`: the child record is gone and its outcome can never be observed.
    let completion = match (end.child, child) {
        (ChildEnd::Ended, Some(child)) => {
            let texts = child_texts(&host, &end.workspace_id, child).await;
            let Some(completion) = piui_orchestration::child_completion(child, &texts) else {
                return false;
            };
            Some(completion)
        }
        _ => None,
    };
    let recorded = {
        let _operation = host.live_runtime_operation_gate.lock().await;
        if validate_live_workspace_scope(&host, &end.workspace_id).is_err() {
            return false;
        }
        match completion {
            Some(completion) => {
                let code = match &completion {
                    piui_orchestration::PipelineCompletion::Succeeded { .. } => "succeeded",
                    piui_orchestration::PipelineCompletion::Failed { failure } => {
                        failure_code(&failure.code)
                    }
                };
                let recorded = api.record_pipeline_outcome(
                    &end.workspace_id,
                    &end.parent_run_id,
                    &end.step_id,
                    &end.child_run_id,
                    completion,
                );
                if recorded.is_ok() {
                    eprintln!(
                        "event=subpipeline_step_completed run_id={:?} step_id={:?} child_run_id={:?} outcome={code}",
                        end.parent_run_id, end.step_id, end.child_run_id
                    );
                }
                recorded
            }
            None => {
                let marked = api.mark_task_uncertain(
                    &end.workspace_id,
                    &end.parent_run_id,
                    0,
                    &end.step_id,
                    end.task_revision,
                    UncertaintyIdentity::Execution(end.child_run_id.clone()),
                );
                if marked.is_ok() {
                    eprintln!(
                        "event=subpipeline_child_missing run_id={:?} step_id={:?} child_run_id={:?}",
                        end.parent_run_id, end.step_id, end.child_run_id
                    );
                }
                marked
            }
        }
    };
    if let Ok(run) = recorded {
        emit_run_changed(app, &end.workspace_id, &run);
        if let Some(scheduler) = app.try_state::<OrchestrationScheduler>() {
            scheduler.spawn_reschedule(
                app.clone(),
                end.workspace_id.clone(),
                end.parent_run_id.clone(),
            );
        }
    }
    true
}

/// A known failure code for logs; anything else is `result-check`.
fn failure_code(code: &str) -> &'static str {
    [
        piui_orchestration::SUBPIPELINE_FAILED,
        piui_orchestration::SUBPIPELINE_CANCELLED,
        piui_orchestration::SUBPIPELINE_OUTPUT_UNAVAILABLE,
    ]
    .into_iter()
    .find(|known| *known == code)
    .unwrap_or("result-check")
}

/// Native whole-result texts the child's outputs need, hash-verified. A text
/// that cannot be read is left out: the outputs are then unavailable.
async fn child_texts(
    host: &HostState,
    workspace_id: &str,
    child: &Run,
) -> BTreeMap<String, String> {
    let mut texts = BTreeMap::new();
    let references = piui_orchestration::child_output_references(child);
    if references.is_empty() {
        return texts;
    }
    let Ok(directory) = crate::api::verified_project_directory(host, workspace_id, false) else {
        return texts;
    };
    for (step_id, reference) in references {
        if let Ok(text) = host
            .workspace
            .dependency_text(&reference, workspace_id, directory.canonical_path())
            .await
        {
            texts.insert(step_id, text);
        }
    }
    texts
}

#[cfg(test)]
#[path = "subpipelines_tests.rs"]
mod tests;
