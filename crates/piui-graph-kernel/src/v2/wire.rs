//! Protocol 2 of the private host-to-kernel pipe. These DTOs are not a
//! browser API and protocol 1 (`crate::wire`) is unchanged beside them.
//!
//! Request types deliberately do not implement Debug, like protocol 1.

use std::collections::BTreeMap;

use piui_orchestration::{
    AdmissionRefusal, AgentProfile, AgentRequestDisposition, AgentToolOperation, AgentToolRequest,
    CompileIdentity, CompileRefusal, ExecutorKind, ExecutorSupport, FailureRecord, Harness,
    NativeBridgeCapabilities, NativeExecutionReference, NativeHistoryReference, PipelineDefinition,
    PipelineName, ResultSelection, Revision, RunDefinitionSnapshot, RunTrigger, ScriptRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::wire::{FlowAction, Launch, Lease, Outcome, Resolution, RunSummary, UncertainIdentity};

pub const PROTOCOL: u32 = 2;
/// Version of the persisted [`Binding`] document.
pub const BINDING_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol: u32,
    pub request_id: String,
    pub command: Command,
}

/// Where a run executes: `WorkLocationV1` (contracts/work-location-v1.ts).
/// There is no device location in version 1.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Location {
    Local {},
    Cloud {
        account_id: String,
        workspace_id: String,
        profile_id: String,
    },
}

/// The authenticated owner of a run, established by the trusted host from
/// its own session, never from a portable document.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub location: Location,
    /// Opaque host scope the run belongs to (Desktop: its project; a cloud
    /// host: its own scope in the workspace). Compared exactly, never parsed.
    pub scope_id: String,
}

/// Facts a trusted host chooses for a new run: its owner, the executors it
/// runs there and the capabilities its adapters proved for every profile.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingFacts {
    pub owner: Owner,
    pub executors: ExecutorSupport,
    pub profile_capabilities: BTreeMap<String, NativeBridgeCapabilities>,
}

/// Frozen with the snapshot at creation and persisted next to it exactly as
/// returned. It never changes: every later command is admitted against it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub binding_version: u32,
    pub run_id: String,
    pub owner: Owner,
    pub executors: ExecutorSupport,
    pub profile_capabilities: BTreeMap<String, NativeBridgeCapabilities>,
    /// Launch commands of the runs above a sub-pipeline child, nearest
    /// first; empty for a run the host created.
    pub ancestry: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    /// Exact serialized Run returned by the kernel and persisted by the host.
    pub snapshot: String,
    /// Exact serialized [`Binding`] returned with that snapshot.
    pub binding: String,
    pub expected_run_revision: Revision,
    /// The owner the host authenticated for this command.
    pub owner: Owner,
}

#[derive(Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostCompletion {
    /// Exit status 0 of a script, or the result of a plugin node.
    Exited {
        stdout: String,
        truncated: bool,
    },
    Failed {
        failure: FailureRecord,
    },
}

/// A coordinator tool call of a running native agent; `request_id` is its
/// durable identity. It has no actor field: the host authenticates the caller.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequest {
    pub request_id: String,
    pub operation: AgentOperation,
}

/// The shared [`AgentToolOperation`] keeps native Desktop's decoding, whose
/// `roster` is a unit variant: serde ignores every other member of such an
/// internally tagged operation. Protocol 2 decodes an empty `roster {}`
/// instead, so an unsupported member is refused rather than dropped.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentOperation {
    Roster {},
    Send {
        recipient_member_id: String,
        body: String,
    },
    Observe {
        target_member_id: String,
    },
    Spawn {
        step_id: String,
    },
    SpawnAgent {
        profile_id: String,
        name: String,
        instructions: String,
    },
}

impl From<AgentRequest> for AgentToolRequest {
    fn from(value: AgentRequest) -> Self {
        let operation = match value.operation {
            AgentOperation::Roster {} => AgentToolOperation::Roster,
            AgentOperation::Send {
                recipient_member_id,
                body,
            } => AgentToolOperation::Send {
                recipient_member_id,
                body,
            },
            AgentOperation::Observe { target_member_id } => {
                AgentToolOperation::Observe { target_member_id }
            }
            AgentOperation::Spawn { step_id } => AgentToolOperation::Spawn { step_id },
            AgentOperation::SpawnAgent {
                profile_id,
                name,
                instructions,
            } => AgentToolOperation::SpawnAgent {
                profile_id,
                name,
                instructions,
            },
        };
        Self {
            request_id: value.request_id,
            operation,
        }
    }
}

/// A sub-pipeline child the host resolved from the leased launch command.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildDefinition {
    pub definition: Box<RunDefinitionSnapshot>,
    pub profile_capabilities: BTreeMap<String, NativeBridgeCapabilities>,
    /// Pipelines of further launch commands the child reaches, for the
    /// reference-cycle check.
    #[serde(default)]
    pub pipelines: Vec<LaunchCommandPipeline>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchCommandPipeline {
    pub launch_command_id: String,
    pub pipeline: PipelineDefinition,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Compile {
        document: String,
        identity: CompileIdentity,
        pipelines: Vec<PipelineName>,
    },
    Create {
        run_id: String,
        definition: Box<RunDefinitionSnapshot>,
        binding: BindingFacts,
        inputs: BTreeMap<String, Value>,
        #[serde(default)]
        trigger: Option<RunTrigger>,
        use_pinned_data: bool,
    },
    /// The admission of `create` alone: no run, run id or run inputs.
    Validate {
        definition: Box<RunDefinitionSnapshot>,
        binding: BindingFacts,
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
    DispatchHostStep {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
        execution: NativeExecutionReference,
    },
    CompleteHostStep {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        execution_id: String,
        completion: HostCompletion,
    },
    ReleaseLease {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
    },
    RejectLeased {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
        failure: FailureRecord,
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
    MarkUncertain {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        identity: UncertainIdentity,
    },
    CancellationRequests {
        state: State,
    },
    Cancel {
        state: State,
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
    AgentRequest {
        state: State,
        /// The running native execution the host authenticated as the caller.
        actor_execution_id: String,
        request: AgentRequest,
    },
    MarkMessageDelivered {
        state: State,
        message_id: String,
    },
    StartPipelineChild {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        lease_id: String,
        child_run_id: String,
        child: ChildDefinition,
        /// Hash-verified whole texts of the native dependencies the
        /// `pipelineLeased` effect listed in `requiredTexts`.
        #[serde(default)]
        resolved_texts: BTreeMap<String, String>,
    },
    ChildOutputReferences {
        child: State,
    },
    CompletePipelineChild {
        state: State,
        step_id: String,
        expected_task_revision: Revision,
        child: State,
        /// Hash-verified texts of the child's `childOutputReferences`; a text
        /// the host could not read is left out.
        #[serde(default)]
        native_texts: BTreeMap<String, String>,
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
        /// Persist atomically before acting on the effect.
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<PersistedState>,
        #[serde(skip_serializing_if = "Option::is_none")]
        run: Option<RunSummary>,
        /// A new sub-pipeline child run, persisted in the same transaction.
        #[serde(skip_serializing_if = "Option::is_none")]
        child: Option<ChildRun>,
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
pub struct PersistedState {
    pub snapshot: String,
    pub binding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRun {
    pub state: PersistedState,
    pub run: RunSummary,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Executor {
    Agent,
    Llm,
    Script,
    Plugin,
    Pipeline,
}

impl From<ExecutorKind> for Executor {
    fn from(value: ExecutorKind) -> Self {
        match value {
            ExecutorKind::Agent => Self::Agent,
            ExecutorKind::Llm => Self::Llm,
            ExecutorKind::Script => Self::Script,
            ExecutorKind::Plugin => Self::Plugin,
            ExecutorKind::Pipeline => Self::Pipeline,
        }
    }
}

#[derive(Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompileResult {
    Compiled {
        definition: Box<RunDefinitionSnapshot>,
    },
    Refused {
        refusal: CompileRefusal,
    },
}

/// Typed intents. The host performs every effect; the kernel performs none.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Effect {
    Compiled {
        result: CompileResult,
    },
    /// Every part of the definition the bound location or adapters cannot
    /// run, exactly as `create` would refuse it; empty when admitted.
    Validated {
        refusals: Vec<AdmissionRefusal>,
    },
    Created {},
    Observed {},
    Changed {},
    Idle {},
    Projected {
        text: String,
    },
    /// A native turn: `agent` with its tools and team, `llm` as exactly one
    /// least-authority turn of the profile.
    Leased {
        executor: Executor,
        lease: Lease,
    },
    ScriptLeased {
        lease: ScriptLease,
    },
    PluginLeased {
        lease: PluginLease,
    },
    PipelineLeased {
        lease: PipelineLease,
    },
    Dispatched {
        launch: Launch,
    },
    HostDispatched {
        step_id: String,
        executor: Executor,
        execution: NativeExecutionReference,
    },
    Cancellations {
        requests: Vec<Cancel>,
    },
    AgentAdmission {
        admission: AgentAdmission,
    },
    ChildStarted {
        step_id: String,
        child_run_id: String,
    },
    ChildOutputReferences {
        references: Vec<ChildReference>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDependency {
    pub step_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<NativeHistoryReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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
    pub dependencies: Vec<HostDependency>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub step_name: String,
    pub plugin_id: String,
    pub node_type: String,
    pub config: Map<String, Value>,
    pub inputs: BTreeMap<String, Value>,
    pub dependencies: Vec<HostDependency>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub step_name: String,
    /// The saved launch command the host resolves to the child definition.
    pub launch_command_id: String,
    /// Native dependency texts the child inputs read; the host returns them
    /// hash-verified as `resolvedTexts`.
    pub required_texts: Vec<ChildReference>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildReference {
    pub step_id: String,
    pub reference: NativeHistoryReference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancel {
    pub run_id: String,
    pub step_id: String,
    /// How the host stops it: a native session, a host process, a plugin
    /// node, or (for `pipeline`) the child run named by `execution`.
    pub executor: Executor,
    pub execution: NativeExecutionReference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachableMember {
    pub member_id: String,
    pub profile_id: String,
    pub harness: Harness,
    pub can_send: bool,
    pub can_observe: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentAdmission {
    Roster {
        members: Vec<ReachableMember>,
        spawn_profiles: Vec<AgentProfile>,
    },
    Send {
        message_id: String,
        recipient_member_id: String,
        body: String,
        already_delivered: bool,
    },
    Observe {
        member_id: String,
        history_references: Vec<NativeHistoryReference>,
    },
    /// Start this lease, then `dispatch` it with the new native execution.
    Spawn { lease: Box<Lease> },
    /// The same request already started this execution; nothing to start.
    SpawnCommitted {
        step_id: String,
        member_id: String,
        execution: NativeExecutionReference,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedProtocol,
    UnsupportedSnapshotVersion,
    InvalidSnapshot,
    UnsupportedBindingVersion,
    InvalidBinding,
    OwnerMismatch,
    InvalidDefinition,
    AdmissionRefused,
    UnsupportedExecutor,
    ExecutorMismatch,
    UnsupportedCapability,
    RevisionConflict,
    StaleExecution,
    LeaseConflict,
    ForeignExecution,
    ForeignHistoryReference,
    AgentRequestRefused,
    ChildRefused,
    ChildNotEnded,
    InvalidTransition,
    SerializationFailed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestRefusal {
    pub disposition: AgentRequestDisposition,
    pub reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: ErrorCode,
    pub message: &'static str,
    /// Every unsupported part of a definition (`admissionRefused`, or a
    /// `childRefused` child definition).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refusals: Vec<AdmissionRefusal>,
    /// The certain task failure a `childRefused` host records with
    /// `rejectLeased`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_request: Option<AgentRequestRefusal>,
}

impl ErrorCode {
    pub const fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "The kernel request is invalid or contains unsupported fields.",
            Self::UnsupportedProtocol => "The kernel protocol version is not supported.",
            Self::UnsupportedSnapshotVersion => "The run snapshot version is not supported.",
            Self::InvalidSnapshot => {
                "The run snapshot is invalid; the stored value must be preserved."
            }
            Self::UnsupportedBindingVersion => "The run binding version is not supported.",
            Self::InvalidBinding => {
                "The run binding is invalid or does not belong to this snapshot; the stored value must be preserved."
            }
            Self::OwnerMismatch => "The run belongs to another owner or execution location.",
            Self::InvalidDefinition => "The frozen graph definition is invalid.",
            Self::AdmissionRefused => {
                "The bound location or adapters cannot run every part of this graph."
            }
            Self::UnsupportedExecutor => "The bound location does not run this executor.",
            Self::ExecutorMismatch => "This command does not apply to the step's executor.",
            Self::UnsupportedCapability => {
                "The bound adapter does not provide a capability this profile requires."
            }
            Self::RevisionConflict => "The run or task revision has changed.",
            Self::StaleExecution => {
                "The native execution does not match the recorded task attempt."
            }
            Self::LeaseConflict => "The recorded task lease does not match this command.",
            Self::ForeignExecution => "The execution does not belong to this task attempt.",
            Self::ForeignHistoryReference => {
                "The history reference does not belong to this task's native execution."
            }
            Self::AgentRequestRefused => "The coordinator refused this agent request.",
            Self::ChildRefused => {
                "The sub-pipeline child cannot start; record the certain failure on the leased step."
            }
            Self::ChildNotEnded => "The sub-pipeline child run has not ended.",
            Self::InvalidTransition => "The coordinator refused this transition.",
            Self::SerializationFailed => "The kernel could not encode the resulting state.",
        }
    }
}
