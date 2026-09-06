//! Harness-neutral orchestration policy and deterministic run coordination.
//!
//! Native harness adapters are the integration seam. The coordinator emits a
//! [`LaunchRequest`] or [`CancelRequest`]; the application executes it through
//! its typed adapter and later calls [`Coordinator::complete_task`]. This crate
//! owns no process, model loop, provider, shell, filesystem, or credentials.

#![forbid(unsafe_code)]

mod coordinator;
mod types;
mod validation;

pub use coordinator::{
    Coordinator, CoordinatorError, RunDataError, deserialize_run, serialize_run,
};
pub use types::*;
pub use validation::{
    AuthorizationError, DefinitionError, authorize_coordinator_tool, authorize_observe,
    authorize_send, authorize_spawn, validate_definition, validate_history_reference,
    validate_profile_capabilities,
};

#[cfg(test)]
mod tests;
