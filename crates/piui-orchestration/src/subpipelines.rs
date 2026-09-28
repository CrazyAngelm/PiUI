//! Sub-pipelines (orchestration v6.7, ADR-042).
//!
//! A `pipeline` step names a saved launch command of the same project. The
//! host admits it only in a trusted, live project outside safe mode, checks
//! the reference, the nesting depth and reference cycles against the
//! current definitions, and then creates an ordinary **child run** of that
//! launch command (trigger [`RunTrigger::Pipeline`]) and dispatches the
//! parent task under the child run id in one durable transaction. Every
//! refusal before the child exists is certain because nothing ran.
//!
//! The parent task stays running while the child runs; a restart keeps it
//! running because the child is durable. When the child ends the host
//! records the parent's outcome with [`Coordinator::complete_pipeline_task`]:
//! the child's declared outputs (or its last succeeded step's text) checked
//! against the step's declared result fields like a script's JSON, or a
//! certain `subpipeline-*` failure. This crate never starts a run itself.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::coordinator::{check_run_revision, ensure_active};
use crate::executors::{
    ScriptDependency, ScriptStdoutResult, host_step, script_dependencies, script_stdout_result,
};
use crate::flow::settle_result;
use crate::inputs::valid_input_name;
use crate::{
    CompletionOutcome, Coordinator, CoordinatorError, DefinitionError, ExecutionMode,
    FailureRecord, HostStepLease, NativeHistoryReference, PipelineDefinition, PipelineStep,
    ResultField, ResultFieldKind, Revision, Run, RunStatus, RunTrigger, StepExecutor, TaskRecord,
    TaskStatus,
};

/// Most nested sub-pipeline runs below a top-level run.
pub const MAX_SUBPIPELINE_DEPTH: u8 = 4;
/// Most child inputs one sub-pipeline step maps.
pub const MAX_SUBPIPELINE_INPUTS: usize = 64;
/// Most outputs one pipeline declares.
pub const MAX_PIPELINE_OUTPUTS: usize = 32;
/// Longest launch command id a sub-pipeline step names (the run trigger bound).
const MAX_LAUNCH_COMMAND_ID_BYTES: usize = 512;

/// The launch command, its team or its pipeline does not exist in this
/// project; nothing started.
pub const SUBPIPELINE_UNAVAILABLE: &str = "subpipeline-unavailable";
/// Starting the child would run a launch command that is already running
/// above it, or its definitions reference each other; nothing started.
pub const SUBPIPELINE_CYCLE: &str = "subpipeline-cycle";
/// The child would nest deeper than [`MAX_SUBPIPELINE_DEPTH`]; nothing started.
pub const SUBPIPELINE_DEPTH: &str = "subpipeline-depth";
/// The mapped values do not satisfy the child's inputs; nothing started.
pub const SUBPIPELINE_INPUT_INVALID: &str = "subpipeline-input-invalid";
/// A dependency result a child input reads could not be read; nothing started.
pub const SUBPIPELINE_INPUT_UNAVAILABLE: &str = "subpipeline-input-unavailable";
/// The child run failed (its first failed step is the detail).
pub const SUBPIPELINE_FAILED: &str = "subpipeline-failed";
/// The child run was cancelled on its own.
pub const SUBPIPELINE_CANCELLED: &str = "subpipeline-cancelled";
/// The child succeeded but its declared outputs could not be read.
pub const SUBPIPELINE_OUTPUT_UNAVAILABLE: &str = "subpipeline-output-unavailable";

/// Where one input of a sub-pipeline's child run comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubpipelineInputSource {
    /// A literal string, number or boolean, checked against the child input.
    Value { value: Value },
    /// An input of the parent run.
    Input { name: String },
    /// A direct dependency of the step: a field of its result data, or
    /// without `field` its whole result text.
    Step {
        step_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field: Option<String>,
    },
}

/// A declared result of a whole pipeline: what a parent's sub-pipeline step
/// receives when this pipeline runs as a child.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineOutput {
    /// Result data key: `[a-z][A-Za-z0-9_]{0,63}`, unique in the pipeline.
    pub name: String,
    pub kind: ResultFieldKind,
    /// A step of this pipeline that is not a callable role.
    pub source_step_id: String,
    /// A field of the source step's result data; absent is its whole
    /// result text (`kind: text`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

/// Self-contained rules of one sub-pipeline executor. That the launch
/// command exists, its inputs and cycles are checked by the host with the
/// whole project, at save and again at admission.
pub(crate) fn validate_pipeline_executor(
    step: &PipelineStep,
    launch_command_id: &str,
    inputs: &BTreeMap<String, SubpipelineInputSource>,
) -> Result<(), &'static str> {
    if launch_command_id.trim().is_empty()
        || launch_command_id.len() > MAX_LAUNCH_COMMAND_ID_BYTES
        || launch_command_id.chars().any(char::is_control)
    {
        return Err("a sub-pipeline names a saved launch command");
    }
    if !step.input_bindings.is_empty() {
        return Err(
            "a sub-pipeline maps its dependencies with its inputs; input bindings apply to agent and llm steps",
        );
    }
    if inputs.len() > MAX_SUBPIPELINE_INPUTS {
        return Err("a sub-pipeline maps at most 64 inputs");
    }
    for (name, source) in inputs {
        if !valid_input_name(name) {
            return Err("sub-pipeline input names match [a-z][A-Za-z0-9_]{0,63}");
        }
        match source {
            SubpipelineInputSource::Value { value } => {
                if !(value.is_string() || value.is_number() || value.is_boolean()) {
                    return Err("a sub-pipeline input value is text, a number or a boolean");
                }
            }
            SubpipelineInputSource::Input { name } => {
                if !valid_input_name(name) {
                    return Err("a sub-pipeline input reads a declared run input");
                }
            }
            SubpipelineInputSource::Step { step_id, field } => {
                if !step.dependency_step_ids.contains(step_id) {
                    return Err("a sub-pipeline input reads a direct dependency");
                }
                if field
                    .as_deref()
                    .is_some_and(|field| field.trim().is_empty())
                {
                    return Err("a sub-pipeline input field name must not be empty");
                }
            }
        }
    }
    Ok(())
}

/// Pipeline-level sub-pipeline rules: parent run inputs a step reads are
/// declared, and the declared outputs are valid.
pub(crate) fn validate_pipeline_subpipelines(
    pipeline: &PipelineDefinition,
) -> Result<(), DefinitionError> {
    for step in &pipeline.steps {
        let Some(StepExecutor::Pipeline { inputs, .. }) = &step.executor else {
            continue;
        };
        for source in inputs.values() {
            if let SubpipelineInputSource::Input { name } = source
                && !pipeline.inputs.iter().any(|input| input.name == *name)
            {
                return Err(DefinitionError::InvalidExecutor {
                    step_id: step.id.clone(),
                    reason: "a sub-pipeline input reads a run input this pipeline does not declare",
                });
            }
        }
    }
    validate_pipeline_outputs(pipeline)
}

fn validate_pipeline_outputs(pipeline: &PipelineDefinition) -> Result<(), DefinitionError> {
    if pipeline.outputs.len() > MAX_PIPELINE_OUTPUTS {
        return Err(DefinitionError::TooManyOutputs {
            limit: MAX_PIPELINE_OUTPUTS,
        });
    }
    let mut names = BTreeSet::new();
    for output in &pipeline.outputs {
        let invalid = |reason: &'static str| DefinitionError::InvalidOutput {
            name: output.name.clone(),
            reason,
        };
        if !valid_input_name(&output.name) {
            return Err(invalid("name must match [a-z][A-Za-z0-9_]{0,63}"));
        }
        if !names.insert(output.name.as_str()) {
            return Err(DefinitionError::DuplicateId {
                kind: "pipeline output",
                id: output.name.clone(),
            });
        }
        let Some(source) = pipeline
            .steps
            .iter()
            .find(|step| step.id == output.source_step_id)
        else {
            return Err(DefinitionError::MissingId {
                kind: "output source step",
                id: output.source_step_id.clone(),
            });
        };
        if source.execution_mode == Some(ExecutionMode::Callable) {
            return Err(invalid("a callable role cannot be an output source"));
        }
        match output.field.as_deref() {
            Some(field) => {
                if field.trim().is_empty() {
                    return Err(invalid("an output field name must not be empty"));
                }
                if !source.result_fields.is_empty() {
                    let Some(declared) = source
                        .result_fields
                        .iter()
                        .find(|candidate| candidate.name == field)
                    else {
                        return Err(invalid(
                            "an output reads a declared result field of its step",
                        ));
                    };
                    if declared.kind != output.kind {
                        return Err(invalid("an output has the kind of the field it reads"));
                    }
                }
            }
            None => {
                if output.kind != ResultFieldKind::Text {
                    return Err(invalid("an output of a whole result text is text"));
                }
            }
        }
    }
    Ok(())
}

/// Launch commands the sub-pipeline steps of `pipeline` name, sorted and
/// without duplicates.
pub fn referenced_launch_commands(pipeline: &PipelineDefinition) -> Vec<String> {
    pipeline
        .steps
        .iter()
        .filter_map(|step| match &step.executor {
            Some(StepExecutor::Pipeline {
                launch_command_id, ..
            }) => Some(launch_command_id.clone()),
            _ => None,
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Whether a reference cycle is reachable from launch command `start`:
/// a launch command runs its pipeline, whose sub-pipeline steps name further
/// launch commands. `pipeline_of` gives the pipeline a launch command runs;
/// a missing one ends that path (admission refuses it separately).
pub fn subpipeline_cycle<'a, F>(start: &str, pipeline_of: F) -> bool
where
    F: Fn(&str) -> Option<&'a PipelineDefinition>,
{
    let children = |id: &str| pipeline_of(id).map_or_else(Vec::new, referenced_launch_commands);
    // `true` while a command is on the current path, `false` when finished.
    let mut on_path: BTreeMap<String, bool> = BTreeMap::new();
    on_path.insert(start.to_owned(), true);
    let mut stack: Vec<(String, Vec<String>)> = vec![(start.to_owned(), children(start))];
    while let Some((_, pending)) = stack.last_mut() {
        let next = pending.pop();
        match next {
            Some(next) => match on_path.get(&next).copied() {
                Some(true) => return true,
                Some(false) => {}
                None => {
                    on_path.insert(next.clone(), true);
                    let grandchildren = children(&next);
                    stack.push((next, grandchildren));
                }
            },
            None => {
                if let Some((finished, _)) = stack.pop() {
                    on_path.insert(finished, false);
                }
            }
        }
    }
    false
}

/// Launch commands of `run` and of every run above it (via sub-pipeline
/// triggers), nearest first. `find_run` looks a run up in the same project;
/// the walk stops at a missing run and after [`MAX_SUBPIPELINE_DEPTH`] hops.
pub fn ancestor_launch_commands<'a, F>(run: &'a Run, find_run: F) -> Vec<String>
where
    F: Fn(&str) -> Option<&'a Run>,
{
    let mut commands = Vec::new();
    let mut current = Some(run);
    let mut hops = 0_u8;
    while let Some(run) = current {
        if let Some(command) = run.definition().launch_command.as_ref() {
            commands.push(command.id.clone());
        }
        if let Some(RunTrigger::Pipeline {
            launch_command_id, ..
        }) = run.trigger()
        {
            commands.push(launch_command_id.clone());
        }
        if hops > MAX_SUBPIPELINE_DEPTH {
            break;
        }
        hops += 1;
        current = run
            .trigger()
            .and_then(RunTrigger::pipeline_parent)
            .and_then(|(parent, _)| find_run(parent));
    }
    commands.dedup();
    commands
}

/// The values a child run is started with: literals, parent run inputs and
/// dependency results. A parent input without a value is left out (the
/// child's default or required rule decides). `dependencies` carry the
/// native text the host resolved (hash-verified) for whole-text sources.
/// The child's own declarations are checked with [`crate::resolve_run_inputs`].
pub fn resolve_child_inputs(
    sources: &BTreeMap<String, SubpipelineInputSource>,
    run_inputs: &BTreeMap<String, Value>,
    dependencies: &[ScriptDependency],
) -> Result<BTreeMap<String, Value>, &'static str> {
    let mut values = BTreeMap::new();
    for (name, source) in sources {
        let value = match source {
            SubpipelineInputSource::Value { value } => Some(value.clone()),
            SubpipelineInputSource::Input { name } => run_inputs.get(name).cloned(),
            SubpipelineInputSource::Step { step_id, field } => {
                let dependency = dependencies
                    .iter()
                    .find(|dependency| dependency.step_id == *step_id)
                    .ok_or(SUBPIPELINE_INPUT_UNAVAILABLE)?;
                Some(match field {
                    Some(field) => dependency
                        .data
                        .as_ref()
                        .and_then(|data| data.get(field))
                        .cloned()
                        .ok_or(SUBPIPELINE_INPUT_UNAVAILABLE)?,
                    None => Value::String(match (&dependency.text, &dependency.data) {
                        (Some(text), _) => text.clone(),
                        (None, Some(data)) => data.to_string(),
                        (None, None) => return Err(SUBPIPELINE_INPUT_UNAVAILABLE),
                    }),
                })
            }
        };
        if let Some(value) = value {
            values.insert(name.clone(), value);
        }
    }
    Ok(values)
}

/// What the host observed when a child run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PipelineCompletion {
    /// The child succeeded: its declared outputs as `data`, or without
    /// declared outputs its last succeeded step's `text`.
    Succeeded {
        data: Option<Map<String, Value>>,
        text: Option<String>,
    },
    /// The child failed or was cancelled, or its outputs are unavailable.
    Failed { failure: FailureRecord },
}

/// Steps of an ended child run whose whole native result text the host must
/// read (hash-verified) to build the parent's result: whole-text outputs or,
/// without declared outputs, the last succeeded step. The references carry
/// no field selection.
pub fn child_output_references(child: &Run) -> Vec<(String, NativeHistoryReference)> {
    text_steps(child)
        .into_iter()
        .filter_map(|step_id| {
            let task = child
                .tasks()
                .iter()
                .find(|task| task.step_id() == step_id && task.status() == TaskStatus::Succeeded)?;
            if task.output().is_some() {
                return None;
            }
            let mut reference = task.result_reference()?.clone();
            reference.fields.clear();
            Some((step_id, reference))
        })
        .collect()
}

fn text_steps(child: &Run) -> Vec<String> {
    let outputs = &child.definition().pipeline.outputs;
    if outputs.is_empty() {
        return last_succeeded(child)
            .map(|task| vec![task.step_id().to_owned()])
            .unwrap_or_default();
    }
    outputs
        .iter()
        .filter(|output| output.field.is_none())
        .map(|output| output.source_step_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn last_succeeded(run: &Run) -> Option<&TaskRecord> {
    run.tasks()
        .iter()
        .rev()
        .find(|task| task.status() == TaskStatus::Succeeded)
}

/// The whole text of a succeeded task: host-recorded output, the native text
/// the host resolved, or its JSON result.
fn task_text(task: &TaskRecord, native_texts: &BTreeMap<String, String>) -> Option<String> {
    task.output()
        .map(|output| output.text.clone())
        .or_else(|| native_texts.get(task.step_id()).cloned())
        .or_else(|| task.result_data().map(Value::to_string))
}

/// Declared output data and fallback text a succeeded child hands on.
pub type ChildResult = (Option<Map<String, Value>>, Option<String>);

/// The result a succeeded child hands to its parent step: its declared
/// outputs as data, or without outputs its last succeeded step's text.
/// An output whose source step was skipped is left out; one whose source
/// succeeded without the value, or with a value of another kind, makes the
/// outputs unavailable.
pub fn child_outputs(
    child: &Run,
    native_texts: &BTreeMap<String, String>,
) -> Result<ChildResult, &'static str> {
    let outputs = &child.definition().pipeline.outputs;
    if outputs.is_empty() {
        return Ok((
            None,
            last_succeeded(child).and_then(|task| task_text(task, native_texts)),
        ));
    }
    let mut data = Map::new();
    let mut present = Vec::new();
    for output in outputs {
        let Some(task) = child
            .tasks()
            .iter()
            .find(|task| task.step_id() == output.source_step_id)
        else {
            return Err(SUBPIPELINE_OUTPUT_UNAVAILABLE);
        };
        if task.status() != TaskStatus::Succeeded {
            continue;
        }
        let value = match &output.field {
            Some(field) => task
                .result_data()
                .and_then(|result| result.get(field))
                .cloned(),
            None => task_text(task, native_texts).map(Value::String),
        }
        .ok_or(SUBPIPELINE_OUTPUT_UNAVAILABLE)?;
        data.insert(output.name.clone(), value);
        present.push(ResultField {
            name: output.name.clone(),
            kind: output.kind,
        });
    }
    crate::validate_result_value(&present, &Value::Object(data.clone()))
        .map_err(|_| SUBPIPELINE_OUTPUT_UNAVAILABLE)?;
    Ok((Some(data), None))
}

/// The parent's outcome for an ended child run, or `None` while the child
/// is running or uncertain. A failed child's first failed step becomes the
/// bounded failure detail.
pub fn child_completion(
    child: &Run,
    native_texts: &BTreeMap<String, String>,
) -> Option<PipelineCompletion> {
    match child.status() {
        RunStatus::Running | RunStatus::Uncertain => None,
        RunStatus::Cancelled => Some(PipelineCompletion::Failed {
            failure: FailureRecord::new(SUBPIPELINE_CANCELLED),
        }),
        RunStatus::Failed => Some(PipelineCompletion::Failed {
            failure: child_failure(child),
        }),
        RunStatus::Succeeded => Some(match child_outputs(child, native_texts) {
            Ok((data, text)) => PipelineCompletion::Succeeded { data, text },
            Err(code) => PipelineCompletion::Failed {
                failure: FailureRecord::new(code),
            },
        }),
    }
}

fn child_failure(child: &Run) -> FailureRecord {
    let failed = child
        .tasks()
        .iter()
        .filter(|task| task.status() == TaskStatus::Failed)
        .find_map(|task| task.failure().map(|failure| (task.step_id(), failure)));
    match failed {
        Some((step_id, failure)) => {
            let mut detail = format!("step \"{step_id}\" failed ({})", failure.code);
            if let Some(inner) = failure
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|inner| !inner.is_empty())
            {
                detail.push_str(": ");
                detail.push_str(inner);
            }
            FailureRecord::with_detail(SUBPIPELINE_FAILED, &detail)
        }
        None => FailureRecord::new(SUBPIPELINE_FAILED),
    }
}

/// A durably leased sub-pipeline step. The launch command and the input
/// sources come from the frozen run snapshot; the child's definitions are
/// read when it starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PipelineStepLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub step_name: String,
    pub launch_command_id: String,
    /// Child input name -> where its value comes from.
    pub sources: BTreeMap<String, SubpipelineInputSource>,
    /// The parent run's frozen input values.
    pub run_inputs: BTreeMap<String, Value>,
    /// Direct dependencies; native text is resolved by the host.
    pub dependencies: Vec<ScriptDependency>,
    /// What started the parent run (its depth and ancestry).
    pub parent_trigger: Option<RunTrigger>,
}

impl PipelineStepLease {
    /// The trigger of the child run, one level below the parent, or
    /// [`SUBPIPELINE_DEPTH`] when that would nest too deep.
    pub fn child_trigger(&self) -> Result<RunTrigger, &'static str> {
        let depth = self
            .parent_trigger
            .as_ref()
            .map_or(0, RunTrigger::subpipeline_depth)
            .saturating_add(1);
        if depth > MAX_SUBPIPELINE_DEPTH {
            return Err(SUBPIPELINE_DEPTH);
        }
        Ok(RunTrigger::Pipeline {
            parent_run_id: self.run_id.clone(),
            parent_step_id: self.step_id.clone(),
            launch_command_id: self.launch_command_id.clone(),
            depth,
        })
    }
}

impl HostStepLease for PipelineStepLease {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn step_id(&self) -> &str {
        &self.step_id
    }
    fn task_revision(&self) -> Revision {
        self.task_revision
    }
    fn lease_id(&self) -> &str {
        &self.lease_id
    }
}

impl Coordinator {
    /// Durably leases the next deterministic ready task when it is a
    /// sub-pipeline step, before the host checks the launch command or
    /// creates anything. Other work returns `ExecutorMismatch`. Dispatch
    /// (with the child run id as the execution id), release and rejection
    /// use the transitions scripts use; a restored lease becomes uncertain.
    pub fn lease_next_pipeline_step(
        run: &mut Run,
        expected_run_revision: Revision,
        lease_id: String,
    ) -> Result<Option<PipelineStepLease>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if lease_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "lease" });
        }
        Self::advance_automatic_steps(run);
        let Some(step_id) = Self::ready_task_ids(run).first().map(|id| (*id).to_owned()) else {
            return Ok(None);
        };
        let step = host_step(run, &step_id)?;
        let Some(StepExecutor::Pipeline {
            launch_command_id,
            inputs,
        }) = step.executor.clone()
        else {
            return Err(CoordinatorError::ExecutorMismatch { step_id });
        };
        let dependencies = script_dependencies(run, &step);
        let run_inputs = run.inputs.clone();
        let parent_trigger = run.trigger.clone();
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        task.lease_id = Some(lease_id.clone());
        task.revision += 1;
        run.revision += 1;
        Ok(Some(PipelineStepLease {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: task.revision,
            lease_id,
            step_id,
            step_name: step.name,
            launch_command_id,
            sources: inputs,
            run_inputs,
            dependencies,
            parent_trigger,
        }))
    }

    /// Records the outcome of a dispatched sub-pipeline step when its child
    /// run ended. Declared outputs become the result data, checked against
    /// the step's declared result fields like a script's JSON; a text result
    /// is recorded like a script's stdout (one JSON object becomes data).
    /// Review and approval rules then apply as for every result.
    pub fn complete_pipeline_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        execution_id: &str,
        completion: PipelineCompletion,
    ) -> Result<(), CoordinatorError> {
        let step = host_step(run, step_id)?;
        if !step.is_pipeline() {
            return Err(CoordinatorError::ExecutorMismatch {
                step_id: step_id.to_owned(),
            });
        }
        let succeeded = || CompletionOutcome::Succeeded {
            result_reference: None,
        };
        let failed = |code: &'static str| CompletionOutcome::Failed {
            failure: FailureRecord::new(code),
        };
        let (outcome, data, output) = match completion {
            PipelineCompletion::Failed { failure } => {
                (CompletionOutcome::Failed { failure }, None, None)
            }
            PipelineCompletion::Succeeded {
                data: Some(data), ..
            } => {
                let value = Value::Object(data);
                match crate::validate_result_value(&step.result_fields, &value) {
                    Ok(()) => (succeeded(), Some(value), None),
                    Err(code) => (failed(code), None, None),
                }
            }
            PipelineCompletion::Succeeded {
                data: None,
                text: Some(text),
            } => match script_stdout_result(&step.result_fields, text, false) {
                ScriptStdoutResult::Data(value) => (succeeded(), Some(value), None),
                ScriptStdoutResult::Output(output) => (succeeded(), None, Some(output)),
                ScriptStdoutResult::Failed(failure) => {
                    (CompletionOutcome::Failed { failure }, None, None)
                }
            },
            PipelineCompletion::Succeeded {
                data: None,
                text: None,
            } => {
                if step.result_fields.is_empty() {
                    (succeeded(), None, None)
                } else {
                    (failed(SUBPIPELINE_OUTPUT_UNAVAILABLE), None, None)
                }
            }
        };
        crate::coordinator::complete_task_transition(
            run,
            expected_run_revision,
            step_id,
            expected_task_revision,
            execution_id,
            outcome,
        )?;
        let index = run
            .tasks
            .iter()
            .position(|task| task.step_id == step_id)
            .ok_or_else(|| CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            })?;
        run.tasks[index].result_data = data;
        run.tasks[index].output = output;
        settle_result(run, index, &step);
        Ok(())
    }
}
