//! Harness-neutral orchestration policy and deterministic run coordination.
//!
//! Native harness adapters are the integration seam. The coordinator emits a
//! [`LaunchRequest`] or [`CancelRequest`]; the application executes it through
//! its typed adapter and later calls [`Coordinator::complete_task`]. This crate
//! owns no process, model loop, provider, shell, filesystem, or credentials.

#![forbid(unsafe_code)]

mod coordinator;
mod executors;
pub use executors::{
    DependencyOutput, ExecutorKind, MAX_FAILURE_DETAIL_BYTES, MAX_SCRIPT_SOURCE_BYTES,
    MAX_SCRIPT_STDERR_BYTES, MAX_SCRIPT_STDOUT_BYTES, MAX_SCRIPT_TIMEOUT_SECONDS,
    MIN_SCRIPT_TIMEOUT_SECONDS, SCRIPT_FAILED, SCRIPT_INPUT_UNAVAILABLE,
    SCRIPT_RUNTIME_UNAVAILABLE, SCRIPT_START_FAILED, SCRIPT_TIMEOUT, ScriptCompletion,
    ScriptDependency, ScriptLease, ScriptRuntime, ScriptStdoutResult, StepExecutor, TaskOutput,
    bounded_text, failure_detail, script_stdout_result,
};
mod flow;
pub use flow::*;
mod plugin_steps;
pub use plugin_steps::{
    HostStepLease, MAX_PLUGIN_CONFIG_BYTES, MAX_PLUGIN_CONFIG_KEYS, PLUGIN_CONFIG_INVALID,
    PLUGIN_INPUT_UNAVAILABLE, PLUGIN_NODE_FAILED, PLUGIN_NODE_TIMEOUT, PLUGIN_START_FAILED,
    PLUGIN_UNAVAILABLE, PluginStepLease,
};
mod inputs;
pub use inputs::{
    MAX_CHOICE_OPTIONS, MAX_INPUT_LABEL_CHARS, MAX_INPUT_NAME_LEN, MAX_INPUT_TEXT_BYTES,
    MAX_PIPELINE_INPUTS, MAX_REVIEW_ITERATIONS, MAX_RUN_INPUT_TEXT_BYTES, MIN_REVIEW_ITERATIONS,
    PipelineInput, PipelineInputKind, RunInputError, resolve_run_inputs,
    validate_pipeline_declarations, validate_pipeline_inputs,
};
mod results;
pub use results::*;
mod types;
mod validation;

pub use coordinator::{
    Coordinator, CoordinatorError, RunDataError, deserialize_run, serialize_run,
};
pub use types::*;
pub use validation::{
    AuthorizationError, DefinitionError, authorize_coordinator_tool, authorize_observe,
    authorize_send, authorize_spawn, spawn_permissions_subset, validate_definition,
    validate_history_reference, validate_profile_capabilities,
};

#[cfg(test)]
mod executor_tests;
#[cfg(test)]
mod input_tests;
#[cfg(test)]
mod plugin_step_tests;
#[cfg(test)]
mod tests;
