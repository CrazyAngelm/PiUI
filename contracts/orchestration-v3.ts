/**
 * PiUI harness-neutral orchestration contract v3.
 *
 * Native harnesses still own model/tool loops, credentials, approvals,
 * compaction, transcripts, and processes. This contract contains definition
 * snapshots and a coordination journal only. Trusted host code must reject
 * unknown fields when decoding persisted or IPC data.
 */

export type OrchestrationId = string;
export type Revision = number;
export type Harness = 'pi' | 'prime-agent' | 'codex';
export type PermissionMode = 'native' | 'read-only' | 'workspace-write' | 'full-access';
export type ToolDecision = 'allow' | 'deny';

/** `advisory` is not isolation. `unsupported` cannot satisfy a mandatory rule. */
export type PolicyEnforcement = 'native' | 'coordinator' | 'advisory' | 'unsupported';

export interface AgentOperationCapabilities {
  readonly roster: boolean;
  readonly send: boolean;
  readonly observe: boolean;
  readonly spawn: boolean;
}

export interface NativeBridgeCapabilities {
  readonly permissionModes: readonly PermissionMode[];
  readonly nativeEnforcedTools: readonly string[];
  readonly coordinatorEnforcedTools: readonly string[];
  readonly agentOperations: AgentOperationCapabilities;
}

export interface ToolRule {
  readonly tool: string;
  readonly decision: ToolDecision;
  readonly enforcement: PolicyEnforcement;
  readonly mandatory: boolean;
}

export interface DeclaredToolPolicy {
  readonly rules: readonly ToolRule[];
}

export interface ResourceRule {
  readonly kind: 'skill' | 'mcp';
  /** Codex skill absolute path, Prime skill name, or configured MCP server name. */
  readonly id: string;
  readonly enabled: boolean;
}
export interface AgentProfile {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly harness: Harness;
  readonly modelProvider?: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly instructions: string;
  /** Codex base prompt replacement. Omit to retain the native prompt; an empty string explicitly replaces it with no base text. */
  readonly baseInstructions?: string;
  readonly reasoning?: string;
  readonly resourceRules?: readonly ResourceRule[];
  /** Standard explicitly overrides a global Fast preference. */
  readonly serviceTier?: 'standard' | 'fast';
  readonly toolPolicy: DeclaredToolPolicy;
  /** Exact workspace coordinator templates that may be spawned. This does not restrict native RLM, Python, subprocesses, or OS access. A request cannot override them. */
  readonly allowedSpawnProfileIds: readonly OrchestrationId[];
}

export interface TeamMember {
  readonly id: OrchestrationId;
  readonly profileId: OrchestrationId;
}

export interface DirectedEdge {
  readonly fromMemberId: OrchestrationId;
  readonly toMemberId: OrchestrationId;
}

export interface TeamDefinition {
  /** New agents may inherit parent-authorized team routes; never broader routes. Otherwise parent-only. */
  readonly spawnedAgentsJoinTeam?: boolean;
  readonly id: OrchestrationId;
  readonly name: string;
  readonly members: readonly TeamMember[];
  readonly sendEdges: readonly DirectedEdge[];
  /** Observation is distinct from message delivery and uses separate edges. */
  readonly observeEdges: readonly DirectedEdge[];
  readonly orchestratorMemberId: OrchestrationId;
}

export interface PipelineStep {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly assignedMemberId: OrchestrationId;
  readonly instructions: string;
  readonly dependencyStepIds: readonly OrchestrationId[];
}

export interface PipelineDefinition {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly steps: readonly PipelineStep[];
}

/** Reusable definition references only. This is never a shell command. */
export interface LaunchCommandReference {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly teamId: OrchestrationId;
  readonly pipelineId: OrchestrationId;
}

/** Captured by value. Existing runs never follow later definition edits. */
export interface RunDefinitionSnapshot {
  readonly profiles: readonly AgentProfile[];
  readonly team: TeamDefinition;
  readonly pipeline: PipelineDefinition;
  readonly launchCommand?: LaunchCommandReference;
}

export type TaskStatus =
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export type MessageStatus = 'accepted' | 'delivered';

/** PiUI workspace-session identity bound by the native adapter. It is safe to pass to workspace session-open APIs, but is never a harness-native id, process handle, or path. */
export interface NativeExecutionReference {
  readonly id: OrchestrationId;
}

export interface FailureRecord {
  /** Stable, non-secret application error code. */
  readonly code: string;
}

export interface NativeHistoryReference {
  readonly sessionId: OrchestrationId;
  readonly blockId?: OrchestrationId;
  /** SHA-256 hex of the exact final assistant text. */
  readonly contentHash?: string;
}

export interface TaskRecord {
  readonly stepId: OrchestrationId;
  readonly status: TaskStatus;
  readonly revision: Revision;
  readonly leaseId?: OrchestrationId;
  readonly execution?: NativeExecutionReference;
  readonly resultReference?: NativeHistoryReference;
  readonly failure?: FailureRecord;
}

export interface MessageRecord {
  readonly id: OrchestrationId;
  readonly senderMemberId: OrchestrationId;
  readonly recipientMemberId: OrchestrationId;
  readonly body: string;
  readonly status: MessageStatus;
  readonly revision: Revision;
}

export type AgentRequestKind =
  | { readonly type: 'roster' }
  | { readonly type: 'send'; readonly recipientMemberId: OrchestrationId }
  | { readonly type: 'observe'; readonly targetMemberId: OrchestrationId }
  | { readonly type: 'spawn'; readonly stepId: OrchestrationId }
  | { readonly type: 'spawnAgent'; readonly profileId: OrchestrationId; readonly name: string; readonly instructions: string };

export interface AgentRequestRecord {
  readonly id: OrchestrationId;
  readonly actorWorkspaceSessionId: OrchestrationId;
  readonly actorMemberId: OrchestrationId;
  readonly operation: AgentRequestKind;
}

export interface OrchestrationRunV3 {
  readonly schemaVersion: 3;
  readonly id: OrchestrationId;
  readonly definition: RunDefinitionSnapshot;
  readonly initialDefinition?: RunDefinitionSnapshot;
  readonly status: RunStatus;
  readonly revision: Revision;
  readonly tasks: readonly TaskRecord[];
  readonly messages: readonly MessageRecord[];
  readonly agentRequests: readonly AgentRequestRecord[];
}

/**
 * The sender is intentionally absent. Trusted caller authentication supplies
 * it separately to the coordinator; model-authored message text cannot claim it.
 */
export interface MessageIntent {
  readonly id: OrchestrationId;
  readonly recipientMemberId: OrchestrationId;
  readonly body: string;
}

export interface LaunchRequest {
  readonly runId: OrchestrationId;
  readonly runRevision: Revision;
  readonly taskRevision: Revision;
  readonly stepId: OrchestrationId;
  readonly memberId: OrchestrationId;
  readonly profile: AgentProfile;
  readonly taskInstructions: string;
  readonly dependencyResultReferences: readonly NativeHistoryReference[];
  readonly execution: NativeExecutionReference;
}

export interface CancelRequest {
  readonly runId: OrchestrationId;
  readonly stepId: OrchestrationId;
  readonly execution: NativeExecutionReference;
}

export type CompletionOutcome =
  | { readonly status: 'succeeded'; readonly resultReference?: NativeHistoryReference }
  | { readonly status: 'failed'; readonly failure: FailureRecord };
