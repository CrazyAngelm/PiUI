/**
 * PiUI harness-neutral orchestration contract v6.
 *
 * Native harnesses still own model/tool loops, credentials, approvals,
 * compaction, transcripts, and processes. This contract contains definition
 * snapshots and a coordination journal only. Trusted host code must reject
 * unknown fields when decoding persisted or IPC data.
 *
 * v6.1 (additive) added run inputs and review loop bounds. v6.2 (additive)
 * adds step executors: `PipelineStep.executor` (`agent` | `llm` | `script`),
 * `TaskRecord.output` for script results and `FailureRecord.detail`. Stored
 * v6.0/v6.1 data decodes unchanged and is re-encoded without the new fields.
 */

export type OrchestrationId = string;
export type Revision = number;
export type Harness = 'pi' | 'prime-agent' | 'codex' | 'hermes';
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
  readonly whenToCall?: string;
  readonly inputInstructions?: string;
  readonly expectedResult?: string;
  readonly id: OrchestrationId;
  readonly name: string;
  readonly harness: Harness;
  readonly modelProvider?: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  /** Explicit native Codex network access. Omitted/false remains network-denied. */
  readonly networkAccess?: boolean;
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

export interface ResultField { readonly name: string; readonly kind: 'text' | 'number' | 'boolean' | 'text-list' | 'artifact'; }

export interface ResultCondition { readonly sourceStepId: string; readonly field: string; readonly equals: string | number | boolean; }
export interface ReviewRule {
  readonly field: string;
  readonly retryFromStepId: string;
  /**
   * Upper bound on review rounds (1-20). When a rejection would start another
   * round beyond it, the reviewer's task waits for a person instead of
   * looping again. Absent means no bound (pre-v6.1 definitions).
   */
  readonly maxIterations?: number;
}
export interface InputBinding { readonly sourceStepId: string; readonly field: string; readonly name: string; }

/** Declarative routing predicates. These are evaluated by the trusted coordinator; they are never executable code. */
export type RouterPredicate =
  | { readonly op: 'equals'; readonly field: string; readonly value: string | number | boolean | null }
  | { readonly op: 'exists'; readonly field: string }
  | { readonly op: 'all'; readonly predicates: readonly RouterPredicate[] }
  | { readonly op: 'any'; readonly predicates: readonly RouterPredicate[] }
  | { readonly op: 'not'; readonly predicate: RouterPredicate };

export interface RouterBranch {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Required for program routers and intentionally absent for agent routers. */
  readonly predicate?: RouterPredicate;
}

export type RouterMode = 'program' | 'agent';

export interface RouterConfig {
  readonly mode: RouterMode;
  /** Exactly one direct result dependency supplies the structured input. */
  readonly inputStepId: string;
  readonly branches: readonly RouterBranch[];
  /** Agent routers must return an array of branch ids under this field. */
  readonly selectionField?: string;
}

export interface RouteGate {
  readonly routerStepId: string;
  readonly branchId: string;
}

/** Interpreter of a script step (v6.2). The host resolves it; a definition never names an executable. */
export type ScriptRuntime = 'node' | 'python' | 'powershell';

/**
 * How a step runs (v6.2, additive; absent means `agent`).
 * - `agent`: a native harness turn with the profile's tools and team routes.
 * - `llm`: exactly one native turn of the step's profile with no follow-ups and
 *   no collaboration (no send/observe/spawn routes, never callable, never a
 *   router). Its profile must be read-only, network-denied, allow no tools,
 *   enable no skills/MCP and hold no spawn templates. The adapter requests an
 *   empty native tool allowlist where the harness enforces one; otherwise the
 *   read-only sandbox is the only boundary and native tools remain available.
 * - `script`: user code the trusted host runs in the project folder under
 *   process containment with a required timeout (1-3600 s). It is not a
 *   sandbox. stdin is one JSON document
 *   `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}`;
 *   stdout that is one JSON object becomes `resultData`, other stdout becomes
 *   `TaskRecord.output`. `source` is at most 64 KiB and is frozen in the run.
 *   A script step is host work, not a team member, and has no profile.
 */
export type StepExecutor =
  | { readonly type: 'agent' }
  | { readonly type: 'llm' }
  | { readonly type: 'script'; readonly runtime: ScriptRuntime; readonly source: string; readonly timeoutSeconds: number };

export interface PipelineStep {
  readonly inputBindings?: readonly InputBinding[];
  readonly condition?: ResultCondition;
  readonly routeGates?: readonly RouteGate[];
  readonly router?: RouterConfig;
  readonly review?: ReviewRule;
  readonly requireApproval?: boolean;
  readonly resultFields?: readonly ResultField[];
  /** Callable templates are never admitted by the automatic scheduler. */
  readonly executionMode?: 'scheduled' | 'callable';
  /** Additive (v6.2): how the step runs; absent is a native agent turn. */
  readonly executor?: StepExecutor;
  /** Expected input supplied by upstream agents. */
  readonly inputInstructions?: string;
  readonly id: OrchestrationId;
  readonly name: string;
  readonly assignedMemberId: OrchestrationId;
  readonly instructions: string;
  readonly dependencyStepIds: readonly OrchestrationId[];
}

export type RunInputValue = string | number | boolean;
export type PipelineInputKind = 'text' | 'long-text' | 'number' | 'boolean' | 'choice';

/**
 * A value supplied by the person (or schedule) that starts a run. Inputs are
 * task data: agents receive them as untrusted context, never as policy.
 */
export interface PipelineInput {
  /** Identifier used in `{{input.name}}` templates: [a-z][A-Za-z0-9_]{0,63}. */
  readonly name: string;
  readonly label: string;
  readonly kind: PipelineInputKind;
  readonly required?: boolean;
  readonly description?: string;
  /** Allowed values for `choice`. */
  readonly options?: readonly string[];
  readonly defaultValue?: RunInputValue;
}

export interface PipelineDefinition {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly steps: readonly PipelineStep[];
  /** Additive (v6.1): values requested when a run starts. */
  readonly inputs?: readonly PipelineInput[];
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
  | 'awaitingApproval'
  | 'skipped'
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
  /**
   * Stable, non-secret application error code. Script codes (v6.2):
   * `script-failed` (non-zero exit), `script-timeout` (tree killed),
   * `script-runtime-unavailable`, `script-input-unavailable` and
   * `script-start-failed` (nothing was executed). Declared-result failures use
   * the same `result-*` codes as native results.
   */
  readonly code: string;
  /**
   * Additive (v6.2): bounded (2 KiB), non-secret human detail recorded by the
   * host, such as the last lines of a script's stderr. Never an IPC input.
   */
  readonly detail?: string;
}

/** Additive (v6.2): bounded text result of a host-executed (script) step. */
export interface TaskOutput {
  /** At most 256 KiB of stdout. */
  readonly text: string;
  /** The text is the first part of a longer output. */
  readonly truncated?: boolean;
}

export interface NativeHistoryReference {
  readonly fields?: readonly { readonly field: string; readonly name: string }[];
  readonly sessionId: OrchestrationId;
  readonly blockId?: OrchestrationId;
  /** SHA-256 hex of the exact final assistant text. */
  readonly contentHash?: string;
}

export interface TaskRecord {
  readonly resultData?: Record<string, unknown>;
  readonly stepId: OrchestrationId;
  readonly status: TaskStatus;
  readonly revision: Revision;
  readonly leaseId?: OrchestrationId;
  /** For a script step this is an opaque host execution id, not a workspace session. */
  readonly execution?: NativeExecutionReference;
  readonly resultReference?: NativeHistoryReference;
  readonly failure?: FailureRecord;
  /** Additive (v6.2): recorded text of a script that did not print a JSON object. */
  readonly output?: TaskOutput;
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

export interface OrchestrationRunV6 {
  /** Additive (v6.1): validated run inputs, frozen when the run starts. */
  readonly inputs?: Readonly<Record<string, RunInputValue>>;
  readonly paused?: boolean;
  readonly attempts?: readonly TaskRecord[];
  readonly schemaVersion: 6;
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
  /** Additive (v6.2): recorded results of script dependencies, used where a native reference would be. */
  readonly dependencyOutputs?: readonly {
    readonly stepId: OrchestrationId;
    readonly fields: readonly { readonly field: string; readonly name: string }[];
    readonly text?: string;
    readonly data?: Record<string, unknown>;
  }[];
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
