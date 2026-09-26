use serde::{Deserialize, Serialize};

pub const ORCHESTRATION_SCHEMA_VERSION: u32 = 6;

pub type Revision = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    Pi,
    PrimeAgent,
    Codex,
    Hermes,
    /// The user's own Claude Code CLI, on the user's Claude subscription only.
    /// Additive within schema v6: stored definitions without it are unchanged.
    ClaudeCode,
}

/// Native bridge permission preset. It is a runtime request, not a claim that
/// the coordinator itself provides an OS sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Native,
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolDecision {
    Allow,
    Deny,
}

/// Describes where a tool rule is actually enforced. `Advisory` is a declared
/// preference, not a sandbox. `Unsupported` cannot satisfy a mandatory rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyEnforcement {
    Native,
    Coordinator,
    Advisory,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOperationCapabilities {
    pub roster: bool,
    pub send: bool,
    pub observe: bool,
    pub spawn: bool,
}

/// Capabilities proven by the selected native bridge/coordinator combination.
/// Launch validation compares mandatory rules against exact tool names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeBridgeCapabilities {
    pub permission_modes: Vec<PermissionMode>,
    pub native_enforced_tools: Vec<String>,
    pub coordinator_enforced_tools: Vec<String>,
    pub agent_operations: AgentOperationCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolRule {
    pub tool: String,
    pub decision: ToolDecision,
    pub enforcement: PolicyEnforcement,
    pub mandatory: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredToolPolicy {
    pub rules: Vec<ToolRule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRule {
    pub kind: ResourceKind,
    pub id: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceKind {
    Skill,
    Mcp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_call: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_result: Option<String>,
    pub id: String,
    pub name: String,
    pub harness: Harness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    pub model: String,
    pub permission_mode: PermissionMode,
    /// Explicit native Codex network capability. Disabled by default and
    /// valid only with read-only or workspace-write permissions.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub network_access: bool,
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_rules: Vec<ResourceRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    pub tool_policy: DeclaredToolPolicy,
    /// Workspace coordinator templates this profile may request dynamically.
    /// This does not restrict native RLM, Python, subprocesses, or OS access.
    /// A launch uses the immutable snapshot; callers cannot supply overrides.
    pub allowed_spawn_profile_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMember {
    pub id: String,
    pub profile_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectedEdge {
    pub from_member_id: String,
    pub to_member_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamDefinition {
    /// Grant new agents only the parent-authorized directions of team messaging.
    /// Older definitions keep parent-only communication.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub spawned_agents_join_team: bool,
    pub id: String,
    pub name: String,
    pub members: Vec<TeamMember>,
    pub send_edges: Vec<DirectedEdge>,
    pub observe_edges: Vec<DirectedEdge>,
    pub orchestrator_member_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionMode {
    Scheduled,
    Callable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineStep {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_bindings: Vec<crate::InputBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<crate::ResultCondition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub route_gates: Vec<crate::RouteGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub router: Option<crate::RouterConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<crate::ReviewRule>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub require_approval: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub result_fields: Vec<crate::ResultField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ExecutionMode>,
    /// How the step runs (v6.2, additive). `None` is a native agent turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<crate::StepExecutor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_instructions: Option<String>,
    pub id: String,
    pub name: String,
    pub assigned_member_id: String,
    pub instructions: String,
    pub dependency_step_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineDefinition {
    pub id: String,
    pub name: String,
    pub steps: Vec<PipelineStep>,
    /// Values requested when a run starts (v6.1, additive).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<crate::PipelineInput>,
}

/// A reusable reference to definitions. It is not an executable shell string.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchCommandReference {
    pub id: String,
    pub name: String,
    pub team_id: String,
    pub pipeline_id: String,
}

/// Definition data captured by value at run creation. A run never follows
/// later edits to user-authored profiles, teams, pipelines, or launch actions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunDefinitionSnapshot {
    pub profiles: Vec<AgentProfile>,
    pub team: TeamDefinition,
    pub pipeline: PipelineDefinition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_command: Option<LaunchCommandReference>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    AwaitingApproval,
    Skipped,
    Ready,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

/// PiUI workspace-session identity bound by the native adapter. Never a native
/// harness id, process handle, or filesystem path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeExecutionReference {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureRecord {
    pub code: String,
    /// Bounded, non-secret human detail such as the tail of a script's
    /// stderr (v6.2, additive). Host-recorded only; never an IPC input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl FailureRecord {
    /// A failure with a stable code and no detail.
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: None,
        }
    }

    /// A failure whose detail keeps at most the last
    /// [`crate::MAX_FAILURE_DETAIL_BYTES`] bytes of whole lines of `detail`.
    /// Blank detail is omitted.
    pub fn with_detail(code: impl Into<String>, detail: &str) -> Self {
        let detail = crate::failure_detail(detail);
        Self {
            code: code.into(),
            detail: (!detail.is_empty()).then_some(detail),
        }
    }
}

/// Safe PiUI reference to output in a workspace session history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeHistoryReference {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<crate::ResultSelection>,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Lowercase or uppercase hexadecimal SHA-256 of exact final assistant text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result_data: Option<serde_json::Value>,
    pub(crate) step_id: String,
    pub(crate) status: TaskStatus,
    pub(crate) revision: Revision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution: Option<NativeExecutionReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result_reference: Option<NativeHistoryReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<FailureRecord>,
    /// Bounded text result of a host-executed (script) step that did not
    /// print a JSON object (v6.2, additive). Native results stay in history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output: Option<crate::TaskOutput>,
}

impl TaskRecord {
    pub fn step_id(&self) -> &str {
        &self.step_id
    }
    pub fn output(&self) -> Option<&crate::TaskOutput> {
        self.output.as_ref()
    }
    pub fn result_data(&self) -> Option<&serde_json::Value> {
        self.result_data.as_ref()
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn revision(&self) -> Revision {
        self.revision
    }
    pub fn lease_id(&self) -> Option<&str> {
        self.lease_id.as_deref()
    }
    pub fn execution(&self) -> Option<&NativeExecutionReference> {
        self.execution.as_ref()
    }
    pub fn result_reference(&self) -> Option<&NativeHistoryReference> {
        self.result_reference.as_ref()
    }
    pub fn failure(&self) -> Option<&FailureRecord> {
        self.failure.as_ref()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageStatus {
    Accepted,
    Delivered,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRecord {
    pub(crate) id: String,
    pub(crate) sender_member_id: String,
    pub(crate) recipient_member_id: String,
    pub(crate) body: String,
    pub(crate) status: MessageStatus,
    pub(crate) revision: Revision,
}

impl MessageRecord {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn sender_member_id(&self) -> &str {
        &self.sender_member_id
    }
    pub fn recipient_member_id(&self) -> &str {
        &self.recipient_member_id
    }
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn status(&self) -> MessageStatus {
        self.status
    }
    pub fn revision(&self) -> Revision {
        self.revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentRequestKind {
    Roster,
    Send {
        recipient_member_id: String,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequestRecord {
    pub(crate) id: String,
    pub(crate) actor_workspace_session_id: String,
    pub(crate) actor_member_id: String,
    pub(crate) operation: AgentRequestKind,
}

impl AgentRequestRecord {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn actor_workspace_session_id(&self) -> &str {
        &self.actor_workspace_session_id
    }
    pub fn actor_member_id(&self) -> &str {
        &self.actor_member_id
    }
    pub fn operation(&self) -> &AgentRequestKind {
        &self.operation
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    /// Validated run inputs frozen at creation (v6.1, additive). Task data only.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub(crate) inputs: std::collections::BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) paused: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) attempts: Vec<TaskRecord>,
    pub(crate) schema_version: u32,
    pub(crate) id: String,
    pub(crate) definition: RunDefinitionSnapshot,
    /// Original user definitions retained before runtime graph expansion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) initial_definition: Option<RunDefinitionSnapshot>,
    pub(crate) status: RunStatus,
    pub(crate) revision: Revision,
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) messages: Vec<MessageRecord>,
    pub(crate) agent_requests: Vec<AgentRequestRecord>,
}

impl Run {
    pub fn inputs(&self) -> &std::collections::BTreeMap<String, serde_json::Value> {
        &self.inputs
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn attempts(&self) -> &[TaskRecord] {
        &self.attempts
    }
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn definition(&self) -> &RunDefinitionSnapshot {
        &self.definition
    }
    pub fn status(&self) -> RunStatus {
        self.status
    }
    pub fn revision(&self) -> Revision {
        self.revision
    }
    pub fn tasks(&self) -> &[TaskRecord] {
        &self.tasks
    }
    pub fn messages(&self) -> &[MessageRecord] {
        &self.messages
    }
    pub fn agent_requests(&self) -> &[AgentRequestRecord] {
        &self.agent_requests
    }
}

/// Authenticated identity established by the trusted host. Message text never
/// supplies or overrides this identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedSender {
    pub member_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageIntent {
    pub id: String,
    pub recipient_member_id: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchRequest {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub step_id: String,
    pub member_id: String,
    pub profile: AgentProfile,
    pub task_instructions: String,
    /// Opaque native history/result references from completed dependencies.
    pub dependency_result_references: Vec<NativeHistoryReference>,
    /// Recorded results of completed host-executed dependencies (v6.2),
    /// used where a native history reference would be.
    pub dependency_outputs: Vec<crate::DependencyOutput>,
    pub execution: NativeExecutionReference,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlledSpawnLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub member_id: String,
    pub profile: AgentProfile,
    pub task_instructions: String,
    pub dependency_result_references: Vec<NativeHistoryReference>,
    pub dependency_outputs: Vec<crate::DependencyOutput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelRequest {
    pub run_id: String,
    pub step_id: String,
    pub execution: NativeExecutionReference,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UncertaintyIdentity {
    Execution(String),
    Lease(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompletionOutcome {
    Succeeded {
        result_reference: Option<NativeHistoryReference>,
    },
    Failed {
        failure: FailureRecord,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UncertainResolution {
    Succeeded {
        result_reference: Option<NativeHistoryReference>,
    },
    Failed {
        failure: FailureRecord,
    },
    Cancelled,
}
