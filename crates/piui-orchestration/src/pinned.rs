//! Pinned step outputs (orchestration v6.4): debugging without paid re-runs.
//!
//! A saved pipeline step may hold pinned data: text and/or a structured
//! result a person copied from a finished run. A run started with pinned
//! data admits every pinned step that becomes ready as succeeded with that
//! output instead of launching it: no native session, no model call and no
//! script process. Downstream steps receive it through the normal dependency
//! path, like a recorded script result, and the task is marked `pinned`.
//!
//! A run started without pinned data freezes its snapshot without pins: they
//! take no part in it. Pinned data is task data, never policy, and the
//! coordinator applies the step's declared result contract to it exactly as
//! to a native result. Artifact paths in it are not checked again.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::coordinator::refresh_status;
use crate::flow::settle_result;
use crate::{
    Coordinator, DefinitionError, ExecutionMode, FailureRecord, PipelineDefinition, PipelineStep,
    RouterMode, Run, TaskOutput, TaskStatus,
};

/// Largest pinned text, in UTF-8 bytes (the bound of a recorded script output).
pub const MAX_PINNED_TEXT_BYTES: usize = 256 * 1024;
/// Largest pinned structured result, as compact JSON.
pub const MAX_PINNED_DATA_BYTES: usize = 256 * 1024;
/// Largest total of pinned text and results in one pipeline.
pub const MAX_PIPELINE_PINNED_BYTES: usize = 1024 * 1024;
/// Largest `pinnedAt` timestamp and `sourceRunId`, in bytes.
pub const MAX_PINNED_AT_BYTES: usize = 64;
pub const MAX_PINNED_SOURCE_RUN_ID_BYTES: usize = 256;

/// A review rejected a result whose correction step runs from pinned data:
/// another round would repeat the same input, so a person decides instead.
pub const REVIEW_RETRY_PINNED: &str = "review-retry-pinned";

/// Output a person pinned on a pipeline step (v6.4, additive).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedOutput {
    /// The step's text output: a native final answer or a script's stdout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The text is the first part of a longer output that was cut.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// The step's structured result, a JSON object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// RFC 3339 time the output was pinned.
    pub pinned_at: String,
    /// The run the output was copied from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_id: Option<String>,
}

impl PinnedOutput {
    /// Pinned text and result bytes that count toward the pipeline bound.
    pub fn size_bytes(&self) -> usize {
        self.text.as_ref().map_or(0, String::len) + self.data.as_ref().map_or(0, json_bytes)
    }
}

/// Options frozen when a run starts (v6.4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunOptions {
    /// Admit pinned steps from their pinned data instead of running them.
    pub use_pinned_data: bool,
}

fn json_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn invalid(step: &PipelineStep, reason: &'static str) -> DefinitionError {
    DefinitionError::InvalidPinnedOutput {
        step_id: step.id.clone(),
        reason,
    }
}

/// Why a step can never use pinned data, whatever its output.
pub fn pinning_refusal(step: &PipelineStep) -> Option<&'static str> {
    if step.execution_mode == Some(ExecutionMode::Callable) {
        return Some("a callable role runs only when an agent calls it; it cannot be pinned");
    }
    if step
        .router
        .as_ref()
        .is_some_and(|router| router.mode == RouterMode::Program)
    {
        return Some("a program router is evaluated by the coordinator; it cannot be pinned");
    }
    if step.review.is_some() {
        return Some("a reviewing step always runs: a pinned verdict would repeat the same round");
    }
    None
}

/// Checks the shape and bounds of one pinned output.
pub fn validate_pinned_output(
    step: &PipelineStep,
    pinned: &PinnedOutput,
) -> Result<(), DefinitionError> {
    if let Some(reason) = pinning_refusal(step) {
        return Err(invalid(step, reason));
    }
    if pinned.text.is_none() && pinned.data.is_none() {
        return Err(invalid(step, "pinned data needs text or a result"));
    }
    if pinned.truncated && pinned.text.is_none() {
        return Err(invalid(step, "only pinned text can be marked as cut"));
    }
    if pinned
        .text
        .as_ref()
        .is_some_and(|text| text.len() > MAX_PINNED_TEXT_BYTES)
    {
        return Err(invalid(step, "pinned text is larger than 256 KiB"));
    }
    if let Some(data) = &pinned.data {
        if !data.is_object() {
            return Err(invalid(step, "a pinned result is a JSON object"));
        }
        if json_bytes(data) > MAX_PINNED_DATA_BYTES {
            return Err(invalid(step, "a pinned result is larger than 256 KiB"));
        }
    }
    let pinned_at = pinned.pinned_at.trim();
    if pinned_at.is_empty()
        || pinned.pinned_at.len() > MAX_PINNED_AT_BYTES
        || !pinned.pinned_at.chars().all(|c| c.is_ascii_graphic())
    {
        return Err(invalid(step, "pinned data needs the time it was pinned"));
    }
    if pinned
        .source_run_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty() || id.len() > MAX_PINNED_SOURCE_RUN_ID_BYTES)
    {
        return Err(invalid(step, "the source run of pinned data is invalid"));
    }
    Ok(())
}

/// Every pinned output of a pipeline and their total bound.
pub fn validate_pipeline_pins(pipeline: &PipelineDefinition) -> Result<(), DefinitionError> {
    let mut total = 0usize;
    for step in &pipeline.steps {
        if let Some(pinned) = &step.pinned_output {
            validate_pinned_output(step, pinned)?;
            total = total.saturating_add(pinned.size_bytes());
            if total > MAX_PIPELINE_PINNED_BYTES {
                return Err(invalid(
                    step,
                    "pinned data of a pipeline is larger than 1 MiB",
                ));
            }
        }
    }
    Ok(())
}

/// What a run records for a pinned step, checked against the step's result
/// contract exactly like a native result: a structured result stands as
/// pinned; otherwise complete text that is one JSON object is the result.
/// An agent router's selection is checked and normalized.
pub fn pinned_result(
    step: &PipelineStep,
    pinned: &PinnedOutput,
) -> Result<(Option<Value>, Option<TaskOutput>), FailureRecord> {
    let output = pinned.text.as_ref().map(|text| TaskOutput {
        text: text.clone(),
        truncated: pinned.truncated,
    });
    let complete_text = pinned.text.as_deref().filter(|_| !pinned.truncated);
    let mut data = match &pinned.data {
        Some(value) => Some(value.clone()),
        None => complete_text
            .and_then(|text| serde_json::from_str::<Value>(text.trim()).ok())
            .filter(Value::is_object),
    };
    match &data {
        Some(value) => {
            crate::validate_result_value(&step.result_fields, value).map_err(FailureRecord::new)?
        }
        None if !step.result_fields.is_empty() => {
            let code = match complete_text {
                Some(text) => crate::validate_result(&step.result_fields, text)
                    .err()
                    .unwrap_or("result-not-object"),
                None => "result-invalid-json",
            };
            return Err(FailureRecord::new(code));
        }
        None => {}
    }
    if let Some(router) = step
        .router
        .as_ref()
        .filter(|router| router.mode == RouterMode::Agent)
    {
        let Some(object) = data.as_mut().and_then(Value::as_object_mut) else {
            return Err(FailureRecord::new("router-selection-invalid"));
        };
        let selected = crate::agent_router_selection(router, &Value::Object(object.clone()))
            .map_err(FailureRecord::new)?;
        let field = router
            .selection_field
            .as_deref()
            .unwrap_or("selectedBranchIds");
        object.insert(
            field.to_owned(),
            Value::Array(selected.into_iter().map(Value::String).collect()),
        );
    }
    Ok((data, output))
}

/// The step a review retries from runs from pinned data in this run.
pub(crate) fn retries_pinned_step(run: &Run, retry_from_step_id: &str) -> bool {
    run.use_pinned_data
        && run
            .definition
            .pipeline
            .steps
            .iter()
            .any(|step| step.id == retry_from_step_id && step.pinned_output.is_some())
}

/// The step is admitted from pinned data in this run and never launched.
pub(crate) fn admitted_from_pin(run: &Run, step: &PipelineStep) -> bool {
    run.use_pinned_data && step.pinned_output.is_some()
}

/// Admits every ready pinned step of a run started with pinned data, in
/// deterministic step-id order, and returns whether anything changed.
/// Readiness is exactly the scheduler's: dependencies succeeded, condition
/// and routes satisfied, the run running and not paused. Pinned data that
/// does not satisfy the step's result contract fails the step like a native
/// result would; nothing ran, so the failure is certain.
pub(crate) fn admit_pinned_steps(run: &mut Run) -> bool {
    if !run.use_pinned_data {
        return false;
    }
    let candidates = Coordinator::ready_task_ids(run)
        .into_iter()
        .filter(|id| {
            run.definition
                .pipeline
                .steps
                .iter()
                .any(|step| step.id == *id && step.pinned_output.is_some())
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut changed = false;
    for step_id in candidates {
        let Some(step) = run
            .definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .cloned()
        else {
            continue;
        };
        let Some(pinned) = step.pinned_output.as_ref() else {
            continue;
        };
        let Some(index) = run.tasks.iter().position(|task| {
            task.step_id == step_id && task.status == TaskStatus::Ready && task.lease_id.is_none()
        }) else {
            // An earlier admission of this pass failed and cancelled it.
            continue;
        };
        let task = &mut run.tasks[index];
        task.pinned = true;
        task.revision += 1;
        match pinned_result(&step, pinned) {
            Ok((data, output)) => {
                task.status = TaskStatus::Succeeded;
                task.result_data = data;
                task.output = output;
                task.failure = None;
                run.revision += 1;
                settle_result(run, index, &step);
            }
            Err(failure) => {
                task.status = TaskStatus::Failed;
                task.failure = Some(failure);
                // Fail fast like any failed result: ready work stops here.
                for other in &mut run.tasks {
                    if other.status == TaskStatus::Ready {
                        other.status = TaskStatus::Cancelled;
                        other.revision += 1;
                    }
                }
                run.revision += 1;
                refresh_status(run);
            }
        }
        changed = true;
    }
    changed
}
