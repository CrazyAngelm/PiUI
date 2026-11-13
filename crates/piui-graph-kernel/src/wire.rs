//! Private host-to-kernel protocol. These DTOs are not a browser API.
//!
//! Request types deliberately do not implement Debug: snapshots, input values,
//! native output and instructions are never ordinary diagnostic log payloads.

use std::collections::BTreeMap;

use piui_orchestration::{
    AgentProfile, FailureRecord, NativeBridgeCapabilities, NativeExecutionReference,
    NativeHistoryReference, ResultSelection, Revision, RunDefinitionSnapshot, RunStatus,
    RunTrigger,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol: u32,
    pub request_id: String,
    pub command: Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    /// Exact serialized Run returned by the kernel and persisted by the host.
    pub snapshot: String,
    pub expected_run_revision: Revision,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Create {
        run_id: String,
        definition: Box<RunDefinitionSnapshot>,
        /// Authoritative adapter facts supplied by the trusted host, not UI metadata.
        profile_capabilities: BTreeMap<String, NativeBridgeCapabilities>,
        inputs: BTreeMap<String, Value>,
        #[serde(default)]
        trigger: Option<RunTrigger>,
        use_pinned_data: bool,
    },
    Inspect {
        state: State,
    },
    ProjectResult {
        state: State,
        text: String,
        fields: Vec<ResultSelection>,
    },
    Advance {
        state: State,
    },
    Lease {
        state: State,
        lease_id: String,
    },
    Dispatch {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
        execution: NativeExecutionReference,
    },
    ReleaseLease {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
    },
    RejectReady {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        failure: FailureRecord,
    },
    CompleteChecked {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        execution_id: String,
        outcome: Outcome,
        /// Read and verified by the host from this native execution's history.
        #[serde(default)]
        text: Option<String>,
    },
    CancellationRequests {
        state: State,
    },
    Cancel {
        state: State,
    },
    MarkUncertain {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        identity: UncertainIdentity,
    },
    Restore {
        state: State,
    },
    Reconcile {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        resolution: Resolution,
    },
    RetryUncertain {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
    },
    ControlFlow {
        state: State,
        action: FlowAction,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Outcome {
    Succeeded {
        #[serde(default)]
        result_reference: Option<NativeHistoryReference>,
    },
    Failed {
        failure: FailureRecord,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum UncertainIdentity {
    Execution { id: String },
    Lease { id: String },
}

#[derive(Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Resolution {
    Succeeded {
        #[serde(default)]
        result_reference: Option<NativeHistoryReference>,
    },
    Failed {
        failure: FailureRecord,
    },
    Cancelled {},
}

/// Empty struct variants enforce unknown-field rejection even for pause/resume.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FlowAction {
    Pause {},
    Resume {},
    Decide {
        step_id: String,
        task_revision: Revision,
        approved: bool,
    },
    Repeat {
        step_id: String,
        task_revision: Revision,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Response {
    Ok {
        protocol: u32,
        request_id: String,
        snapshot: String,
        run: RunSummary,
        effect: Box<Effect>,
    },
    Error {
        protocol: u32,
        request_id: Option<String>,
        error: Error,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub revision: Revision,
    pub status: RunStatus,
    pub paused: bool,
    pub needs_restore: bool,
    pub ready_task_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    Created {},
    Observed {},
    Changed {},
    Idle {},
    Leased { lease: Lease },
    Dispatched { launch: Launch },
    Cancellations { requests: Vec<Cancel> },
    Projected { text: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyOutput {
    pub step_id: String,
    pub fields: Vec<ResultSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub member_id: String,
    pub profile: AgentProfile,
    pub task_instructions: String,
    pub dependency_result_references: Vec<NativeHistoryReference>,
    pub dependency_outputs: Vec<DependencyOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub step_id: String,
    pub member_id: String,
    pub profile: AgentProfile,
    pub task_instructions: String,
    pub dependency_result_references: Vec<NativeHistoryReference>,
    pub dependency_outputs: Vec<DependencyOutput>,
    pub execution: NativeExecutionReference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancel {
    pub run_id: String,
    pub step_id: String,
    pub execution: NativeExecutionReference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedProtocol,
    UnsupportedSnapshotVersion,
    InvalidSnapshot,
    InvalidDefinition,
    UnsupportedExecutor,
    UnsupportedCapability,
    MissingCapabilities,
    RevisionConflict,
    StaleExecution,
    LeaseConflict,
    InvalidTransition,
    SerializationFailed,
}

#[derive(Serialize)]
pub struct Error {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl ErrorCode {
    pub fn error(self) -> Error {
        let message = match self {
            Self::InvalidRequest => "The kernel request is invalid or contains unsupported fields.",
            Self::UnsupportedProtocol => "The kernel protocol version is not supported.",
            Self::UnsupportedSnapshotVersion => "The run snapshot version is not supported.",
            Self::InvalidSnapshot => {
                "The run snapshot is invalid; the stored value must be preserved."
            }
            Self::InvalidDefinition => "The frozen graph definition is invalid.",
            Self::UnsupportedExecutor => {
                "This kernel protocol does not support the requested executor."
            }
            Self::UnsupportedCapability => {
                "The graph requires a capability unavailable in this kernel protocol or adapter."
            }
            Self::MissingCapabilities => {
                "Verified adapter capabilities are required for every frozen profile."
            }
            Self::RevisionConflict => "The run or task revision has changed.",
            Self::StaleExecution => {
                "The native execution does not match the recorded task attempt."
            }
            Self::LeaseConflict => "The recorded task lease does not match this command.",
            Self::InvalidTransition => "The coordinator refused this transition.",
            Self::SerializationFailed => "The kernel could not encode the resulting snapshot.",
        };
        Error {
            code: self,
            message,
        }
    }
}
