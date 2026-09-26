//! Step executors (orchestration v6.2): how one pipeline step runs.
//!
//! `agent` (the default) is a native harness turn with its tools and team
//! communication. `llm` is exactly one native turn of the step's profile with
//! the least authority the adapter can enforce: no collaboration, read-only
//! files, no network, and no tools where the harness can disable them. `script`
//! is user code that the trusted host runs in the project folder under process
//! containment; it is not a sandbox. `plugin` (v6.5) is a node type of an
//! installed plugin that the plugin's contained backend runs; like a script
//! it is host work outside the team (see `plugin_steps`).
//!
//! The coordinator owns the durable lease, the dependency hand-off and the
//! result checks for every executor. It never starts a process, resolves an
//! interpreter or reads a file.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::coordinator::{check_revision, check_run_revision, ensure_active};
use crate::flow::settle_result;
use crate::{
    CompletionOutcome, Coordinator, CoordinatorError, DefinitionError, ExecutionMode,
    FailureRecord, NativeExecutionReference, NativeHistoryReference, PermissionMode, PipelineStep,
    ResultSelection, Revision, Run, RunDefinitionSnapshot, TaskStatus, ToolDecision,
};

/// Largest script source, in UTF-8 bytes.
pub const MAX_SCRIPT_SOURCE_BYTES: usize = 64 * 1024;
/// Smallest and largest script timeout, in seconds.
pub const MIN_SCRIPT_TIMEOUT_SECONDS: u32 = 1;
pub const MAX_SCRIPT_TIMEOUT_SECONDS: u32 = 3600;
/// Most stdout bytes the host keeps from one script; the rest is dropped.
pub const MAX_SCRIPT_STDOUT_BYTES: usize = 256 * 1024;
/// Most stderr bytes the host keeps from one script (its tail).
pub const MAX_SCRIPT_STDERR_BYTES: usize = 64 * 1024;
/// Largest failure detail, in UTF-8 bytes.
pub const MAX_FAILURE_DETAIL_BYTES: usize = 2 * 1024;

/// The script exited with a non-zero status.
pub const SCRIPT_FAILED: &str = "script-failed";
/// The script ran longer than its timeout and its process tree was killed.
pub const SCRIPT_TIMEOUT: &str = "script-timeout";
/// The script's interpreter is not installed; nothing was executed.
pub const SCRIPT_RUNTIME_UNAVAILABLE: &str = "script-runtime-unavailable";
/// A dependency result could not be read for the script's stdin; nothing ran.
pub const SCRIPT_INPUT_UNAVAILABLE: &str = "script-input-unavailable";
/// The host could not write or start the script; nothing was executed.
pub const SCRIPT_START_FAILED: &str = "script-start-failed";

/// Interpreter of a script step. The host resolves it; a file never names one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRuntime {
    Node,
    Python,
    PowerShell,
}

impl ScriptRuntime {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Python => "python",
            Self::PowerShell => "powershell",
        }
    }
}

/// How a pipeline step runs. Absent on a step means `Agent`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StepExecutor {
    // Empty struct variants (not unit variants) so that serde rejects
    // unknown fields next to the tag, like every other contract type.
    /// A native harness turn with the profile's tools and team routes.
    Agent {},
    /// Exactly one native turn of the profile with no collaboration and the
    /// least authority the adapter enforces.
    Llm {},
    /// User code the trusted host runs in the project folder (not a sandbox).
    Script {
        runtime: ScriptRuntime,
        source: String,
        timeout_seconds: u32,
    },
    /// A node type of an installed plugin, run by its contained backend
    /// (v6.5). `config` is flat: strings, numbers and booleans.
    Plugin {
        plugin_id: String,
        node_type: String,
        config: serde_json::Map<String, Value>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutorKind {
    Agent,
    Llm,
    Script,
    Plugin,
}

impl StepExecutor {
    pub const fn kind(&self) -> ExecutorKind {
        match self {
            Self::Agent {} => ExecutorKind::Agent,
            Self::Llm {} => ExecutorKind::Llm,
            Self::Script { .. } => ExecutorKind::Script,
            Self::Plugin { .. } => ExecutorKind::Plugin,
        }
    }
}

impl PipelineStep {
    /// The step's executor kind; a step without one is an agent.
    pub fn executor_kind(&self) -> ExecutorKind {
        self.executor
            .as_ref()
            .map_or(ExecutorKind::Agent, StepExecutor::kind)
    }

    /// A script step (v6.2).
    pub fn is_script(&self) -> bool {
        self.executor_kind() == ExecutorKind::Script
    }

    /// A plugin node step (v6.5).
    pub fn is_plugin(&self) -> bool {
        self.executor_kind() == ExecutorKind::Plugin
    }

    /// Host-executed work with no native session and no team member: a
    /// script or a plugin node. Its result exists only when the host
    /// observed it, and a restart leaves it uncertain.
    pub fn is_host_executed(&self) -> bool {
        matches!(
            self.executor_kind(),
            ExecutorKind::Script | ExecutorKind::Plugin
        )
    }
}

/// Bounded text result of a host-executed step (v6.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskOutput {
    pub text: String,
    /// The text is the first part of a longer output.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// A completed host-executed dependency, handed to a native step where a
/// native history reference would be. Its text is task data, never policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DependencyOutput {
    pub step_id: String,
    /// The recipient's input bindings from this dependency; empty passes the
    /// whole result.
    pub fields: Vec<ResultSelection>,
    pub text: Option<String>,
    pub data: Option<Value>,
}

impl DependencyOutput {
    /// Dependency context for a prompt: the bound fields as a JSON object,
    /// otherwise the JSON result, otherwise the recorded text.
    pub fn context_text(&self) -> Result<String, &'static str> {
        let whole = match (&self.data, &self.text) {
            (Some(data), _) => data.to_string(),
            (None, Some(text)) => text.clone(),
            (None, None) => String::new(),
        };
        crate::project_result(&whole, &self.fields)
    }
}

/// One direct dependency of a script step. Native results stay in native
/// history: the host resolves `reference` into `text`, verified by hash.
/// Host-executed and coordinator-owned results carry their recorded values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptDependency {
    pub step_id: String,
    pub reference: Option<NativeHistoryReference>,
    pub text: Option<String>,
    pub data: Option<Value>,
}

/// A durably leased script step. The source comes from the frozen run
/// snapshot, never from later edits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub step_name: String,
    pub runtime: ScriptRuntime,
    pub source: String,
    pub timeout_seconds: u32,
    pub inputs: BTreeMap<String, Value>,
    pub dependencies: Vec<ScriptDependency>,
}

impl ScriptLease {
    /// The single JSON document the script reads on stdin:
    /// `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}`.
    /// Native text the host has not resolved into `text` is `null`.
    pub fn stdin_document(&self) -> Value {
        let dependencies = self
            .dependencies
            .iter()
            .map(|dependency| {
                (
                    dependency.step_id.clone(),
                    json!({ "text": dependency.text, "data": dependency.data }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        json!({
            "inputs": self.inputs,
            "dependencies": dependencies,
            "step": { "id": self.step_id, "name": self.step_name },
        })
    }
}

/// What the host observed when a leased script ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScriptCompletion {
    /// Exit status 0. `truncated` marks stdout cut at the host's bound.
    Exited { stdout: String, truncated: bool },
    /// No result: a non-zero exit, a timeout or a start failure.
    Failed { failure: FailureRecord },
}

/// The last whole lines of `text` within [`MAX_FAILURE_DETAIL_BYTES`], with
/// control characters other than newlines and tabs removed.
pub fn failure_detail(text: &str) -> String {
    let cleaned = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.len() <= MAX_FAILURE_DETAIL_BYTES {
        return cleaned.to_owned();
    }
    let mut start = cleaned.len() - MAX_FAILURE_DETAIL_BYTES;
    while !cleaned.is_char_boundary(start) {
        start += 1;
    }
    let tail = &cleaned[start..];
    // Prefer starting at a line boundary unless the tail is a single line.
    let tail = match tail.find('\n') {
        Some(offset) if offset + 1 < tail.len() => &tail[offset + 1..],
        _ => tail,
    };
    tail.trim().to_owned()
}

/// `text` cut to at most `limit` bytes on a character boundary; the flag is
/// true when anything was dropped.
pub fn bounded_text(text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// What a run records for the stdout of a script that exited with status 0.
#[derive(Clone, Debug, PartialEq)]
pub enum ScriptStdoutResult {
    /// Complete stdout that is one JSON object satisfying the declared fields.
    Data(Value),
    /// Any other stdout of a step without declared result fields.
    Output(TaskOutput),
    /// The declared result fields are not satisfied.
    Failed(FailureRecord),
}

/// The result check of a script's stdout, shared by runs and the editor's
/// script test: complete stdout that is one JSON object becomes result data
/// checked against the declared fields exactly like a native result; any
/// other stdout is text output, which a step with declared fields rejects. A
/// cut stdout is never read as JSON: its end is unknown.
pub fn script_stdout_result(
    fields: &[crate::ResultField],
    stdout: String,
    truncated: bool,
) -> ScriptStdoutResult {
    let (stdout, cut) = bounded_text(stdout, MAX_SCRIPT_STDOUT_BYTES);
    let truncated = truncated || cut;
    let parsed = if truncated {
        None
    } else {
        serde_json::from_str::<Value>(stdout.trim()).ok()
    };
    match parsed {
        Some(value) if value.is_object() => match crate::validate_result_value(fields, &value) {
            Ok(()) => ScriptStdoutResult::Data(value),
            Err(code) => ScriptStdoutResult::Failed(FailureRecord::new(code)),
        },
        parsed if !fields.is_empty() => {
            ScriptStdoutResult::Failed(FailureRecord::new(if parsed.is_some() {
                "result-not-object"
            } else {
                "result-invalid-json"
            }))
        }
        _ => ScriptStdoutResult::Output(TaskOutput {
            text: stdout,
            truncated,
        }),
    }
}

fn invalid(step: &PipelineStep, reason: &'static str) -> DefinitionError {
    DefinitionError::InvalidExecutor {
        step_id: step.id.clone(),
        reason,
    }
}

/// Self-contained executor rules of one stored step.
pub(crate) fn validate_step_executor(step: &PipelineStep) -> Result<(), DefinitionError> {
    let kind = step.executor_kind();
    if kind == ExecutorKind::Agent {
        return Ok(());
    }
    if step.execution_mode == Some(ExecutionMode::Callable) {
        return Err(invalid(
            step,
            "only agent steps can be callable roles; llm and script steps are scheduled",
        ));
    }
    if step.router.is_some() {
        return Err(invalid(step, "llm and script steps cannot be routers"));
    }
    if let Some(StepExecutor::Script {
        source,
        timeout_seconds,
        ..
    }) = &step.executor
    {
        if source.trim().is_empty() {
            return Err(invalid(step, "a script needs source code"));
        }
        if source.len() > MAX_SCRIPT_SOURCE_BYTES {
            return Err(invalid(step, "script source is larger than 64 KiB"));
        }
        if !(MIN_SCRIPT_TIMEOUT_SECONDS..=MAX_SCRIPT_TIMEOUT_SECONDS).contains(timeout_seconds) {
            return Err(invalid(step, "a script timeout is 1 to 3600 seconds"));
        }
        if !step.input_bindings.is_empty() {
            return Err(invalid(
                step,
                "a script reads every dependency result on stdin; input bindings apply to agent and llm steps",
            ));
        }
    }
    if let Some(StepExecutor::Plugin {
        plugin_id,
        node_type,
        config,
    }) = &step.executor
    {
        crate::plugin_steps::validate_plugin_executor(plugin_id, node_type, config)
            .map_err(|reason| invalid(step, reason))?;
        if !step.input_bindings.is_empty() {
            return Err(invalid(
                step,
                "a plugin node reads every dependency result; input bindings apply to agent and llm steps",
            ));
        }
    }
    Ok(())
}

/// Rules that need the whole snapshot: a script is host work outside the
/// team, and an llm step's profile holds the least authority and no routes.
pub(crate) fn validate_executor_authority(
    snapshot: &RunDefinitionSnapshot,
    step: &PipelineStep,
    members: &BTreeSet<&str>,
) -> Result<(), DefinitionError> {
    match step.executor_kind() {
        ExecutorKind::Agent => Ok(()),
        ExecutorKind::Script => {
            if members.contains(step.assigned_member_id.as_str()) {
                return Err(invalid(
                    step,
                    "a script runs on the host, not as a team member",
                ));
            }
            Ok(())
        }
        ExecutorKind::Plugin => {
            if members.contains(step.assigned_member_id.as_str()) {
                return Err(invalid(
                    step,
                    "a plugin node runs on the host, not as a team member",
                ));
            }
            Ok(())
        }
        ExecutorKind::Llm => {
            let member = &step.assigned_member_id;
            let team = &snapshot.team;
            if team
                .send_edges
                .iter()
                .chain(&team.observe_edges)
                .any(|edge| edge.from_member_id == *member || edge.to_member_id == *member)
            {
                return Err(invalid(
                    step,
                    "an llm step cannot send, receive or observe messages",
                ));
            }
            let Some(profile) = team
                .members
                .iter()
                .find(|candidate| candidate.id == *member)
                .and_then(|candidate| {
                    snapshot
                        .profiles
                        .iter()
                        .find(|profile| profile.id == candidate.profile_id)
                })
            else {
                return Err(DefinitionError::MissingId {
                    kind: "assigned member",
                    id: member.clone(),
                });
            };
            if profile.permission_mode != PermissionMode::ReadOnly {
                return Err(invalid(step, "an llm step's profile must be read-only"));
            }
            if profile.network_access {
                return Err(invalid(step, "an llm step's profile has no network access"));
            }
            if profile
                .tool_policy
                .rules
                .iter()
                .any(|rule| rule.decision == ToolDecision::Allow)
            {
                return Err(invalid(step, "an llm step's profile cannot allow tools"));
            }
            if profile.resource_rules.iter().any(|rule| rule.enabled) {
                return Err(invalid(
                    step,
                    "an llm step's profile cannot enable skills or MCP servers",
                ));
            }
            if !profile.allowed_spawn_profile_ids.is_empty() {
                return Err(invalid(step, "an llm step cannot spawn agents"));
            }
            if snapshot
                .profiles
                .iter()
                .any(|candidate| candidate.allowed_spawn_profile_ids.contains(&profile.id))
            {
                return Err(invalid(step, "an llm step's profile cannot be spawned"));
            }
            Ok(())
        }
    }
}

/// Every direct dependency of a host-executed step, in declared order.
pub(crate) fn script_dependencies(run: &Run, step: &PipelineStep) -> Vec<ScriptDependency> {
    step.dependency_step_ids
        .iter()
        .map(|dependency| {
            let task = run.tasks.iter().find(|task| task.step_id == *dependency);
            ScriptDependency {
                step_id: dependency.clone(),
                reference: task.and_then(|task| task.result_reference.clone()),
                text: task.and_then(|task| task.output.as_ref().map(|output| output.text.clone())),
                data: task.and_then(|task| task.result_data.clone()),
            }
        })
        .collect()
}

/// Recorded results of succeeded host-executed and pinned (v6.4)
/// dependencies of `step`, with the step's input bindings from each.
pub(crate) fn dependency_outputs(run: &Run, step: &PipelineStep) -> Vec<DependencyOutput> {
    step.dependency_step_ids
        .iter()
        .filter(|dependency| {
            run.definition
                .pipeline
                .steps
                .iter()
                .any(|source| source.id == **dependency && source.is_host_executed())
                || run
                    .tasks
                    .iter()
                    .any(|task| task.step_id == **dependency && task.pinned)
        })
        .filter_map(|dependency| {
            let task = run
                .tasks
                .iter()
                .find(|task| task.step_id == *dependency && task.status == TaskStatus::Succeeded)?;
            if task.output.is_none() && task.result_data.is_none() {
                return None;
            }
            Some(DependencyOutput {
                step_id: dependency.clone(),
                fields: step
                    .input_bindings
                    .iter()
                    .filter(|binding| binding.source_step_id == *dependency)
                    .map(|binding| ResultSelection {
                        field: binding.field.clone(),
                        name: binding.name.clone(),
                    })
                    .collect(),
                text: task.output.as_ref().map(|output| output.text.clone()),
                data: task.result_data.clone(),
            })
        })
        .collect()
}

/// A host-executed step of the run (a script or a plugin node).
pub(crate) fn host_step(run: &Run, step_id: &str) -> Result<PipelineStep, CoordinatorError> {
    let step = run
        .definition
        .pipeline
        .steps
        .iter()
        .find(|step| step.id == step_id)
        .cloned()
        .ok_or_else(|| CoordinatorError::UnknownTask {
            step_id: step_id.to_owned(),
        })?;
    if !step.is_host_executed() {
        return Err(CoordinatorError::ExecutorMismatch {
            step_id: step_id.to_owned(),
        });
    }
    Ok(step)
}

impl Coordinator {
    /// Durably leases the next deterministic ready task when it is a script,
    /// before the host resolves its interpreter or writes anything. Native
    /// work is leased with `lease_next_task`; this returns `ExecutorMismatch`
    /// for it. A restored lease becomes uncertain rather than replayable.
    pub fn lease_next_script(
        run: &mut Run,
        expected_run_revision: Revision,
        lease_id: String,
    ) -> Result<Option<ScriptLease>, CoordinatorError> {
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
        let Some(StepExecutor::Script {
            runtime,
            source,
            timeout_seconds,
        }) = step.executor.clone()
        else {
            return Err(CoordinatorError::ExecutorMismatch { step_id });
        };
        let dependencies = script_dependencies(run, &step);
        let inputs = run.inputs.clone();
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        task.lease_id = Some(lease_id.clone());
        task.revision += 1;
        run.revision += 1;
        Ok(Some(ScriptLease {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: task.revision,
            lease_id,
            step_id,
            step_name: step.name,
            runtime,
            source,
            timeout_seconds,
            inputs,
            dependencies,
        }))
    }

    /// Commits a leased script as running under an opaque host execution id,
    /// immediately before the host starts its process.
    pub fn dispatch_leased_script(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        lease_id: &str,
        execution: NativeExecutionReference,
    ) -> Result<(), CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if execution.id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "execution" });
        }
        host_step(run, step_id)?;
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::UnknownTask {
                step_id: step_id.to_owned(),
            });
        };
        check_revision("task", expected_task_revision, task.revision)?;
        if task.status != TaskStatus::Ready {
            return Err(CoordinatorError::InvalidTaskStatus {
                step_id: step_id.to_owned(),
                expected: TaskStatus::Ready,
                actual: task.status,
            });
        }
        if task.lease_id.as_deref() != Some(lease_id) {
            return Err(CoordinatorError::LeaseConflict {
                step_id: step_id.to_owned(),
            });
        }
        task.status = TaskStatus::Running;
        task.lease_id = None;
        task.execution = Some(execution);
        task.revision += 1;
        run.revision += 1;
        Ok(())
    }

    /// Records what the host observed when a script ended. Exit status 0
    /// succeeds: complete stdout that is one JSON object becomes the result
    /// data, checked against declared result fields exactly like a native
    /// result; any other stdout is the recorded text output. Review and
    /// approval rules then apply as for native results.
    pub fn complete_script_task(
        run: &mut Run,
        expected_run_revision: Revision,
        step_id: &str,
        expected_task_revision: Revision,
        execution_id: &str,
        completion: ScriptCompletion,
    ) -> Result<(), CoordinatorError> {
        let step = host_step(run, step_id)?;
        let succeeded = CompletionOutcome::Succeeded {
            result_reference: None,
        };
        let (outcome, data, output) = match completion {
            ScriptCompletion::Failed { failure } => {
                (CompletionOutcome::Failed { failure }, None, None)
            }
            ScriptCompletion::Exited { stdout, truncated } => {
                match script_stdout_result(&step.result_fields, stdout, truncated) {
                    ScriptStdoutResult::Data(value) => (succeeded, Some(value), None),
                    ScriptStdoutResult::Output(output) => (succeeded, None, Some(output)),
                    ScriptStdoutResult::Failed(failure) => {
                        (CompletionOutcome::Failed { failure }, None, None)
                    }
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
