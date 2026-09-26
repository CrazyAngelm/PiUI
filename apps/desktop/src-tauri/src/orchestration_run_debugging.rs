//! Run debugging v1 (`contracts/orchestration-run-debugging-v1.ts`):
//! recorded step outputs, pinning one into the saved pipeline, archiving and
//! deleting finished runs.
//!
//! Every command takes opaque ids only. Outputs are read the way the
//! scheduler reads dependency results: script and pinned text from the run
//! record, native final answers from native history verified by their
//! content hash. Nothing here starts, resumes or replays work.
//!
//! Deleting a run removes PiUI-owned records only: the run's entry in the
//! orchestration journal (a new create-only, fsynced generation without it)
//! and script working copies left for its executions in PiUI's application
//! data folder, each resolved and verified as a direct child of that folder
//! without following links or reparse points. Native harness sessions and
//! their histories, chats and project files are never touched. Running and
//! uncertain runs are refused. Only metadata is logged.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use piui_orchestration::{
    MAX_PINNED_DATA_BYTES, MAX_PINNED_TEXT_BYTES, PinnedOutput, Run, RunStatus, TaskRecord,
    TaskStatus, pinning_refusal, validate_pipeline_declarations,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::api::verified_project_directory;
use crate::orchestration_api::OrchestrationApiState;
use crate::orchestration_store::StoreError;
use crate::state::HostState;

pub const RUN_DEBUGGING_PROTOCOL: u8 = 1;
const MAX_ID_BYTES: usize = 512;
/// Execution ids are host-allocated UUIDs; anything else is never a folder
/// PiUI created.
const MAX_EXECUTION_ID_BYTES: usize = 128;

/// Typed refusals, serialized as `{"code": "<kebab-case>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum RunDebuggingError {
    #[error("the request is invalid")]
    Invalid,
    #[error("the project, run, pipeline or step was not found")]
    NotFound,
    #[error("the pipeline or run changed")]
    Conflict,
    #[error("safe mode keeps runs and pipelines read-only")]
    SafeMode,
    #[error("PiUI is shutting down")]
    ShuttingDown,
    #[error("the run is running or uncertain")]
    RunActive,
    #[error("only a succeeded step's output can be pinned")]
    StepNotSucceeded,
    #[error("this step cannot hold pinned data")]
    NotPinnable,
    #[error("the step has no recorded output")]
    NoOutput,
    #[error("the output is too large to pin")]
    TooLarge,
    #[error("the output's native history could not be read")]
    OutputUnavailable,
    #[error("PiUI's data could not be saved")]
    Io,
}

impl From<StoreError> for RunDebuggingError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict | StoreError::AlreadyExists => Self::Conflict,
            StoreError::NotFound => Self::NotFound,
            StoreError::Invalid | StoreError::Denied => Self::Invalid,
            StoreError::Io(_) => Self::Io,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunOutputsRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) run_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepOutputIssue {
    TooLarge,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutputV1 {
    pub step_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<StepOutputIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutputsResultV1 {
    pub protocol: u8,
    pub run_id: String,
    pub outputs: Vec<StepOutputV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinStepOutputRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) run_id: String,
    pub(crate) step_id: String,
    pub(crate) pipeline_id: String,
    pub(crate) expected_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinStepOutputResultV1 {
    pub protocol: u8,
    pub revision: u64,
    pub pinned_output: PinnedOutput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRunArchivedRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) run_id: String,
    pub(crate) archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRunArchivedResultV1 {
    pub protocol: u8,
    pub run_id: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRunRequestV1 {
    pub(crate) workspace_id: String,
    pub(crate) run_id: String,
    pub(crate) expected_run_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRunResultV1 {
    pub protocol: u8,
    pub run_id: String,
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_ID_BYTES
}

fn require_ids(ids: &[&str]) -> Result<(), RunDebuggingError> {
    if ids.iter().all(|id| valid_id(id)) {
        Ok(())
    } else {
        Err(RunDebuggingError::Invalid)
    }
}

/// Writes need a registered project outside safe mode and shutdown.
fn writable(host: &HostState) -> Result<(), RunDebuggingError> {
    if host.safe_mode {
        return Err(RunDebuggingError::SafeMode);
    }
    if host.is_shutting_down() {
        return Err(RunDebuggingError::ShuttingDown);
    }
    Ok(())
}

fn active(run: &Run) -> bool {
    matches!(run.status(), RunStatus::Running | RunStatus::Uncertain)
}

/// The recorded output of one succeeded task: its text (script stdout,
/// pinned text or the verified native final answer, never a projection) and
/// structured result, each within the pinning bound.
async fn step_output(
    host: &HostState,
    workspace_id: &str,
    project_path: &Path,
    task: &TaskRecord,
) -> StepOutputV1 {
    let mut output = StepOutputV1 {
        step_id: task.step_id().to_owned(),
        text: None,
        truncated: false,
        data: None,
        issue: None,
    };
    if let Some(recorded) = task.output() {
        output.text = Some(recorded.text.clone());
        output.truncated = recorded.truncated;
    } else if let Some(reference) = task.result_reference() {
        let mut whole = reference.clone();
        whole.fields.clear();
        match host
            .workspace
            .dependency_text(&whole, workspace_id, project_path)
            .await
        {
            Ok(text) => output.text = Some(text),
            Err(_) => output.issue = Some(StepOutputIssue::Unavailable),
        }
    }
    if output
        .text
        .as_ref()
        .is_some_and(|text| text.len() > MAX_PINNED_TEXT_BYTES)
    {
        output.text = None;
        output.truncated = false;
        output.issue = Some(StepOutputIssue::TooLarge);
    }
    if let Some(data) = task.result_data() {
        let size = serde_json::to_vec(data).map_or(usize::MAX, |bytes| bytes.len());
        if size > MAX_PINNED_DATA_BYTES {
            output.issue = Some(StepOutputIssue::TooLarge);
        } else {
            output.data = Some(data.clone());
        }
    }
    output
}

/// Recorded outputs of every succeeded step of a run, in task order.
pub(crate) async fn run_outputs(
    api: &OrchestrationApiState,
    host: &HostState,
    request: RunOutputsRequestV1,
) -> Result<RunOutputsResultV1, RunDebuggingError> {
    require_ids(&[&request.workspace_id, &request.run_id])?;
    let directory = verified_project_directory(host, &request.workspace_id, false)
        .map_err(|_| RunDebuggingError::NotFound)?;
    let run = api
        .get_run(&request.workspace_id, &request.run_id)
        .map_err(|_| RunDebuggingError::Io)?
        .ok_or(RunDebuggingError::NotFound)?;
    let mut outputs = Vec::new();
    for task in run
        .tasks()
        .iter()
        .filter(|task| task.status() == TaskStatus::Succeeded)
    {
        outputs.push(
            step_output(
                host,
                &request.workspace_id,
                directory.canonical_path(),
                task,
            )
            .await,
        );
    }
    Ok(RunOutputsResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        run_id: request.run_id,
        outputs,
    })
}

/// Copies one succeeded step's recorded output into the saved pipeline's
/// step as pinned data, checked against the pipeline revision the person
/// saw and the task revision that was read. Native history is read before
/// the operation gate is taken; the write is one atomic journal transaction.
pub(crate) async fn pin_step_output(
    api: &OrchestrationApiState,
    host: &HostState,
    request: PinStepOutputRequestV1,
    now: DateTime<Utc>,
) -> Result<PinStepOutputResultV1, RunDebuggingError> {
    require_ids(&[
        &request.workspace_id,
        &request.run_id,
        &request.step_id,
        &request.pipeline_id,
    ])?;
    writable(host)?;
    let directory = verified_project_directory(host, &request.workspace_id, false)
        .map_err(|_| RunDebuggingError::NotFound)?;
    let run = api
        .get_run(&request.workspace_id, &request.run_id)
        .map_err(|_| RunDebuggingError::Io)?
        .ok_or(RunDebuggingError::NotFound)?;
    let task = run
        .tasks()
        .iter()
        .find(|task| task.step_id() == request.step_id)
        .ok_or(RunDebuggingError::NotFound)?;
    if task.status() != TaskStatus::Succeeded {
        return Err(RunDebuggingError::StepNotSucceeded);
    }
    let task_revision = task.revision();
    let output = step_output(
        host,
        &request.workspace_id,
        directory.canonical_path(),
        task,
    )
    .await;
    match output.issue {
        Some(StepOutputIssue::TooLarge) => return Err(RunDebuggingError::TooLarge),
        Some(StepOutputIssue::Unavailable) => return Err(RunDebuggingError::OutputUnavailable),
        None => {}
    }
    if output.text.is_none() && output.data.is_none() {
        return Err(RunDebuggingError::NoOutput);
    }
    let pinned = PinnedOutput {
        text: output.text,
        truncated: output.truncated,
        data: output.data,
        pinned_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
        source_run_id: Some(request.run_id.clone()),
    };
    let _operation = host.live_runtime_operation_gate.lock().await;
    writable(host)?;
    let mut refusal = None;
    let result = api.store().transact(|workspaces| {
        let workspace = workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_id == request.workspace_id)
            .ok_or(StoreError::NotFound)?;
        // The output read above is still the run's recorded result.
        let current = workspace
            .runs
            .iter()
            .find(|run| run.id() == request.run_id)
            .and_then(|run| {
                run.tasks()
                    .iter()
                    .find(|task| task.step_id() == request.step_id)
            })
            .ok_or(StoreError::NotFound)?;
        if current.revision() != task_revision || current.status() != TaskStatus::Succeeded {
            return Err(StoreError::Conflict);
        }
        let stored = workspace
            .pipelines
            .iter_mut()
            .find(|stored| stored.value.id == request.pipeline_id)
            .ok_or(StoreError::NotFound)?;
        if stored.revision != request.expected_revision {
            return Err(StoreError::Conflict);
        }
        let mut pipeline = stored.value.clone();
        let step = pipeline
            .steps
            .iter_mut()
            .find(|step| step.id == request.step_id)
            .ok_or(StoreError::NotFound)?;
        if pinning_refusal(step).is_some() {
            refusal = Some(RunDebuggingError::NotPinnable);
            return Err(StoreError::Denied);
        }
        step.pinned_output = Some(pinned.clone());
        if validate_pipeline_declarations(&pipeline).is_err() {
            // The single pin is within its bounds: only the pipeline's
            // total can be exceeded here.
            refusal = Some(RunDebuggingError::TooLarge);
            return Err(StoreError::Denied);
        }
        stored.revision = stored.revision.checked_add(1).ok_or(StoreError::Invalid)?;
        stored.value = pipeline;
        Ok(stored.revision)
    });
    let revision = result.map_err(|error| refusal.unwrap_or_else(|| error.into()))?;
    Ok(PinStepOutputResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        revision,
        pinned_output: pinned,
    })
}

/// Hides a finished run from the default list, or shows it again. The run
/// record, its revision and its scheduling are unchanged.
pub(crate) fn set_run_archived(
    api: &OrchestrationApiState,
    host: &HostState,
    request: SetRunArchivedRequestV1,
) -> Result<SetRunArchivedResultV1, RunDebuggingError> {
    require_ids(&[&request.workspace_id, &request.run_id])?;
    writable(host)?;
    verified_project_directory(host, &request.workspace_id, false)
        .map_err(|_| RunDebuggingError::NotFound)?;
    let result = SetRunArchivedResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        run_id: request.run_id.clone(),
        archived: request.archived,
    };
    // Already as requested: nothing to write.
    let unchanged = api.store().snapshot().ok().is_some_and(|snapshot| {
        snapshot
            .workspace(&request.workspace_id)
            .is_some_and(|workspace| {
                workspace.runs.iter().any(|run| run.id() == request.run_id)
                    && workspace.archived_run_ids.contains(&request.run_id) == request.archived
            })
    });
    if unchanged {
        return Ok(result);
    }
    let mut refusal = None;
    api.store()
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            let run = workspace
                .runs
                .iter()
                .find(|run| run.id() == request.run_id)
                .ok_or(StoreError::NotFound)?;
            if request.archived {
                // A running run stays visible until it ends.
                if active(run) {
                    refusal = Some(RunDebuggingError::RunActive);
                    return Err(StoreError::Denied);
                }
                workspace.archived_run_ids.insert(request.run_id.clone());
            } else {
                workspace.archived_run_ids.remove(&request.run_id);
            }
            Ok(())
        })
        .map_err(|error| refusal.unwrap_or_else(|| error.into()))?;
    Ok(result)
}

/// Removes a finished run's PiUI records. See the module documentation.
pub(crate) async fn delete_run(
    api: &OrchestrationApiState,
    host: &HostState,
    request: DeleteRunRequestV1,
) -> Result<DeleteRunResultV1, RunDebuggingError> {
    require_ids(&[&request.workspace_id, &request.run_id])?;
    writable(host)?;
    let _operation = host.live_runtime_operation_gate.lock().await;
    writable(host)?;
    verified_project_directory(host, &request.workspace_id, false)
        .map_err(|_| RunDebuggingError::NotFound)?;
    let mut refusal = None;
    let executions = api
        .store()
        .transact(|workspaces| {
            let workspace = workspaces
                .iter_mut()
                .find(|workspace| workspace.workspace_id == request.workspace_id)
                .ok_or(StoreError::NotFound)?;
            let index = workspace
                .runs
                .iter()
                .position(|run| run.id() == request.run_id)
                .ok_or(StoreError::NotFound)?;
            let run = &workspace.runs[index];
            if run.revision() != request.expected_run_revision {
                return Err(StoreError::Conflict);
            }
            // Running or uncertain work may still hold a native session or
            // a process: its record is the only proof of what happened.
            if active(run) {
                refusal = Some(RunDebuggingError::RunActive);
                return Err(StoreError::Denied);
            }
            let executions = script_executions(run);
            workspace.runs.remove(index);
            workspace.archived_run_ids.remove(&request.run_id);
            Ok(executions)
        })
        .map_err(|error| refusal.unwrap_or_else(|| error.into()))?;
    let removed = remove_script_folders(api.script_work_root(), &executions);
    eprintln!(
        "event=orchestration_run_deleted script_folders={removed} script_executions={}",
        executions.len()
    );
    Ok(DeleteRunResultV1 {
        protocol: RUN_DEBUGGING_PROTOCOL,
        run_id: request.run_id,
    })
}

/// Host execution ids of the run's script steps, current and earlier attempts.
fn script_executions(run: &Run) -> BTreeSet<String> {
    let scripts = run
        .definition()
        .pipeline
        .steps
        .iter()
        .filter(|step| step.is_script())
        .map(|step| step.id.as_str())
        .collect::<BTreeSet<_>>();
    run.tasks()
        .iter()
        .chain(run.attempts())
        .filter(|task| scripts.contains(task.step_id()))
        .filter_map(|task| task.execution().map(|execution| execution.id.clone()))
        .collect()
}

/// A plain host-allocated id: one path component, never `.`/`..`.
fn owned_folder_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_EXECUTION_ID_BYTES
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

/// A real directory, not a link, junction or other reparse point.
fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir() && !metadata.file_type().is_symlink() && !is_reparse_point(&metadata)
    })
}

/// Removes the working copies a deleted run's scripts left in PiUI's script
/// folder. Each target must be a plain directory whose resolved parent is
/// exactly the resolved script folder; links and reparse points are never
/// followed or removed. Returns how many folders were removed.
pub(crate) fn remove_script_folders(root: &Path, executions: &BTreeSet<String>) -> usize {
    if executions.is_empty() || !plain_directory(root) {
        return 0;
    }
    let Ok(root) = root.canonicalize() else {
        return 0;
    };
    let mut removed = 0;
    for id in executions {
        if !owned_folder_name(id) {
            continue;
        }
        let path = root.join(id);
        if !plain_directory(&path) {
            continue;
        }
        let Ok(resolved) = path.canonicalize() else {
            continue;
        };
        if resolved.parent() != Some(root.as_path()) || resolved != path {
            continue;
        }
        if fs::remove_dir_all(&resolved).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[tauri::command]
pub async fn orchestration_run_outputs_v1(
    api: State<'_, OrchestrationApiState>,
    host: State<'_, HostState>,
    request: RunOutputsRequestV1,
) -> Result<RunOutputsResultV1, RunDebuggingError> {
    run_outputs(&api, &host, request).await
}

#[tauri::command]
pub async fn orchestration_pin_step_output_v1(
    api: State<'_, OrchestrationApiState>,
    host: State<'_, HostState>,
    request: PinStepOutputRequestV1,
) -> Result<PinStepOutputResultV1, RunDebuggingError> {
    pin_step_output(&api, &host, request, Utc::now()).await
}

#[tauri::command]
pub async fn orchestration_set_run_archived_v1(
    api: State<'_, OrchestrationApiState>,
    host: State<'_, HostState>,
    request: SetRunArchivedRequestV1,
) -> Result<SetRunArchivedResultV1, RunDebuggingError> {
    set_run_archived(&api, &host, request)
}

#[tauri::command]
pub async fn orchestration_delete_run_v1(
    api: State<'_, OrchestrationApiState>,
    host: State<'_, HostState>,
    request: DeleteRunRequestV1,
) -> Result<DeleteRunResultV1, RunDebuggingError> {
    delete_run(&api, &host, request).await
}

#[cfg(test)]
#[path = "orchestration_run_debugging_tests.rs"]
mod tests;
