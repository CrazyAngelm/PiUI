/** Graph compile boundary and kernel protocol 2 (ADR-059; protocol 2 added in Stage 5A).
 *
 * A portable system document of version 5 becomes the orchestration v6 run
 * definition or one refusal code. The first part of this file freezes the
 * compile input, output and refusal codes of
 * `piui_orchestration::compile_system_document`
 * (`crates/piui-orchestration/src/compile.rs`).
 *
 * Compiling grants nothing and starts nothing: the definition is a draft
 * until a host freezes it in a run after its own admission checks.
 * Equality vectors generated from the editor's import path are
 * `fixtures/unified-shell/graph/compile-vectors-v1.json`.
 *
 * The second part is protocol 2 of the private host <-> Rust graph kernel
 * pipe (`crates/piui-graph-kernel/src/v2`), not a WebView API. Protocol 1
 * (`nano-graph-kernel-v1.ts`) is unchanged beside it and still refuses
 * scripts, plugin nodes, sub-pipelines, callable roles, delegation and team
 * messaging; the kernel selects protocol 2 only for one JSON object whose
 * `protocol` is exactly 2. Fixtures: `fixtures/unified-shell/graph/kernel-v2/`.
 */
import type {
  AgentProfile, CompletionOutcome, FailureRecord, Harness, LaunchRequest,
  NativeBridgeCapabilities, NativeExecutionReference, NativeHistoryReference,
  PipelineDefinition, Revision, RunDefinitionSnapshot, RunInputValue, RunStatus,
  RunTrigger, ScriptRuntime,
} from './orchestration-v6';
import type { KernelFlowActionV1, KernelLeaseV1 } from './nano-graph-kernel-v1';
import type { WorkLocationV1 } from './work-location-v1';

/** The only document version compiled. The editor's import parser upgrades versions 1-4. */
export const GRAPH_COMPILE_DOCUMENT_VERSION_V2 = 5;

/**
 * Identifiers chosen by the host, never by the document. The profile and the
 * team member of an agent both take the agent's local id.
 */
export interface GraphCompileIdentityV2 {
  readonly teamId: string;
  readonly pipelineId: string;
  /**
   * With an id the definition carries the launch command
   * `{id, name: <document name>, teamId, pipelineId}`, as the Desktop editor
   * saves a graph. Without one it carries none, as the server's drafts do.
   */
  readonly launchCommandId?: string;
}

/**
 * A saved launch command that a sub-pipeline step's pipeline NAME resolves
 * against: the exact name, else a unique case-insensitive match. A missing or
 * ambiguous name is refused, never replaced.
 */
export interface GraphPipelineNameV2 {
  readonly id: string;
  readonly name: string;
}

export interface GraphCompileInputV2 {
  /** The exact document text: repeated member names and number spelling are checked on it. */
  readonly document: string;
  readonly identity: GraphCompileIdentityV2;
  readonly pipelines: readonly GraphPipelineNameV2[];
}

/** Stable refusal codes, in the order the compiler checks them. */
export const GRAPH_COMPILE_REFUSALS_V2 = [
  /** Not one JSON value the parser reads (syntax, or nesting beyond serde_json's recursion limit). */
  'invalidJson',
  /** Not an object with `format: "piui-system"` and a numeric `version`. */
  'notSystemFile',
  /** A version other than 5. */
  'unsupportedVersion',
  /** Not system file v5: unknown, missing, null or mistyped member, schema pattern or range, or a repeated member name. */
  'invalidDocument',
  /** Agents and connections the mapping cannot represent without dropping or replacing a member. */
  'invalidStructure',
  /** A sub-pipeline names a pipeline missing or ambiguous among the supplied ones. */
  'unresolvedPipeline',
  /** A sub-pipeline names the launch command being compiled. */
  'selfReferencingPipeline',
  /** The definition fails `validate_definition` or an editor graph rule. */
  'invalidDefinition',
  /** A delegation grant fails `authorize_spawn` (same-or-less authority). */
  'delegationDenied',
] as const;

export type GraphCompileRefusalV2 = (typeof GRAPH_COMPILE_REFUSALS_V2)[number];

export type GraphCompileResultV2 =
  | { readonly outcome: 'compiled'; readonly definition: RunDefinitionSnapshot }
  | { readonly outcome: 'refused'; readonly refusal: GraphCompileRefusalV2 };

// ---------------------------------------------------------------------------
// Kernel protocol 2. Every request and nested definition rejects unknown
// fields in Rust. The kernel performs no effect: it returns typed intents that
// become executable only after the host persisted the returned state (and a
// child run) in one transaction. The host owns identifiers, history reads,
// approvals, pipeline-name resolution, run inputs, persistence, processes,
// inference and every timeout or quota; the kernel adds none.

export const GRAPH_KERNEL_PROTOCOL_V2 = 2;
/** Version of the persisted {@link KernelBindingV2} document. */
export const GRAPH_KERNEL_BINDING_VERSION_V2 = 1;

/**
 * The authenticated owner of a run. The trusted host establishes it from its
 * own session (Desktop: `local` and its project; a Nano server: the cloud
 * account, workspace and profile with its own scope), never from a portable
 * document. A connected device is not a location in work-location v1.
 */
export interface KernelOwnerV2 {
  readonly location: WorkLocationV1;
  /** Opaque host scope, compared exactly and never parsed. */
  readonly scopeId: string;
}

/**
 * Executors the host itself runs at the bound location. Every entry is
 * explicit. A host advertises only what it executes there today: a cloud host
 * without a script, llm, plugin or sub-pipeline executor binds them `false`.
 */
export interface KernelExecutorSupportV2 {
  readonly agent: boolean;
  readonly llm: boolean;
  readonly script: boolean;
  readonly plugin: boolean;
  readonly pipeline: boolean;
}

/** What the host chooses for a new run; the kernel freezes it with the run. */
export interface KernelBindingFactsV2 {
  readonly owner: KernelOwnerV2;
  readonly executors: KernelExecutorSupportV2;
  /** Adapter capabilities the host proved for frozen profiles, keyed by profile id; no other key. */
  readonly profileCapabilities: Readonly<Record<string, NativeBridgeCapabilities>>;
}

/**
 * The frozen binding, returned as `state.binding` text with the snapshot and
 * persisted next to it byte for byte. It never changes: every command reads
 * it again and admits the frozen definition against it before a transition.
 * The kernel cannot detect an edit that only adds authority; the host keeps
 * the stored pair intact like the snapshot itself.
 */
export interface KernelBindingV2 extends KernelBindingFactsV2 {
  readonly bindingVersion: typeof GRAPH_KERNEL_BINDING_VERSION_V2;
  readonly runId: string;
  /** Launch commands of the runs above a sub-pipeline child, nearest first; empty for a run the host created. */
  readonly ancestry: readonly string[];
}

export interface KernelStateV2 {
  /**
   * Exact `state.snapshot` text the kernel returned. Every returned state
   * loads again: a transition that cancels ready work (a failure's fail-fast,
   * a rejection, a reconciliation, a failed pinned step) releases the lease of
   * every task it cancelled, and a state that could not be loaded is refused
   * as `invalidTransition` with nothing returned. A stored request record
   * that does not decode exactly as returned is `invalidSnapshot`.
   */
  readonly snapshot: string;
  /** Exact `state.binding` text returned with that snapshot. */
  readonly binding: string;
  readonly expectedRunRevision: Revision;
  /** The owner the host authenticated for this command. */
  readonly owner: KernelOwnerV2;
}

/** Every operation, `roster` included, refuses an unknown member as `invalidRequest`. */
export type KernelAgentOperationV2 =
  | { readonly type: 'roster' }
  | { readonly type: 'send'; readonly recipientMemberId: string; readonly body: string }
  | { readonly type: 'observe'; readonly targetMemberId: string }
  | { readonly type: 'spawn'; readonly stepId: string }
  | { readonly type: 'spawnAgent'; readonly profileId: string; readonly name: string; readonly instructions: string };

/**
 * A coordinator tool call of a running native agent; `requestId` is its
 * durable identity. A spawn is leased under its `requestId`: one that
 * another task's reservation holds is refused (`conflict`,
 * `spawnLeaseRefused` or `spawnAgentLeaseRefused`), while an identical retry
 * returns the same lease. The spawned step is admitted with the frozen
 * capabilities of its own profile, not the caller's.
 */
export interface KernelAgentRequestV2 {
  readonly requestId: string;
  readonly operation: KernelAgentOperationV2;
}

export type KernelHostCompletionV2 =
  | { readonly status: 'exited'; readonly stdout: string; readonly truncated: boolean }
  | { readonly status: 'failed'; readonly failure: FailureRecord };

/** A sub-pipeline child the host resolved from the leased launch command. */
export interface KernelChildDefinitionV2 {
  /** Must carry `launchCommand.id` equal to the lease's `launchCommandId`. */
  readonly definition: RunDefinitionSnapshot;
  readonly profileCapabilities: Readonly<Record<string, NativeBridgeCapabilities>>;
  /**
   * Pipelines of the further launch commands the child reaches, resolved by
   * the host, for the reference-cycle check before the child starts. The
   * frozen ancestry refuses a cycle at the latest when it would start.
   */
  readonly pipelines?: readonly { readonly launchCommandId: string; readonly pipeline: PipelineDefinition }[];
}

type WithStateV2<T> = T & { readonly state: KernelStateV2 };
type TaskCommandV2<T> = WithStateV2<T & { readonly stepId: string; readonly expectedTaskRevision: Revision }>;

export type KernelCommandV2 =
  | ({ readonly type: 'compile' } & GraphCompileInputV2)
  | { readonly type: 'create'; readonly runId: string; readonly definition: RunDefinitionSnapshot;
      readonly binding: KernelBindingFactsV2; readonly inputs: Readonly<Record<string, RunInputValue>>;
      /** Never a `pipeline` trigger: a child exists only through `startPipelineChild`. */
      readonly trigger?: RunTrigger; readonly usePinnedData: boolean }
  /** The admission of `create` alone, before a launch: no run, run id or run inputs. */
  | { readonly type: 'validate'; readonly definition: RunDefinitionSnapshot; readonly binding: KernelBindingFactsV2 }
  | WithStateV2<{ readonly type: 'inspect' | 'advance' | 'cancellationRequests' | 'cancel' | 'restore' }>
  | WithStateV2<{ readonly type: 'projectResult'; readonly text: string;
      readonly fields: NonNullable<NativeHistoryReference['fields']> }>
  /** A `leaseId` that a task of the run already holds is `leaseConflict`. */
  | WithStateV2<{ readonly type: 'lease'; readonly leaseId: string }>
  | TaskCommandV2<{ readonly type: 'dispatch' | 'dispatchHostStep'; readonly leaseId: string;
      readonly execution: NativeExecutionReference }>
  | TaskCommandV2<{ readonly type: 'completeHostStep'; readonly executionId: string;
      readonly completion: KernelHostCompletionV2 }>
  | TaskCommandV2<{ readonly type: 'releaseLease'; readonly leaseId: string }>
  | TaskCommandV2<{ readonly type: 'rejectLeased'; readonly leaseId: string; readonly failure: FailureRecord }>
  | TaskCommandV2<{ readonly type: 'rejectReady'; readonly failure: FailureRecord }>
  | TaskCommandV2<{ readonly type: 'completeChecked'; readonly executionId: string;
      /** A `resultReference` names this execution's own session. */
      readonly outcome: CompletionOutcome;
      /** Read and hash-verified by the host from this execution's history. */
      readonly text?: string }>
  | TaskCommandV2<{ readonly type: 'markUncertain';
      readonly identity: { readonly type: 'execution' | 'lease'; readonly id: string } }>
  | TaskCommandV2<{ readonly type: 'reconcile';
      readonly resolution: CompletionOutcome | { readonly status: 'cancelled' } }>
  | TaskCommandV2<{ readonly type: 'retryUncertain' }>
  | WithStateV2<{ readonly type: 'controlFlow'; readonly action: KernelFlowActionV1 }>
  | WithStateV2<{ readonly type: 'agentRequest';
      /** The running native execution the host authenticated as the caller. */
      readonly actorExecutionId: string; readonly request: KernelAgentRequestV2 }>
  | WithStateV2<{ readonly type: 'markMessageDelivered'; readonly messageId: string }>
  | TaskCommandV2<{ readonly type: 'startPipelineChild'; readonly leaseId: string;
      /** Chosen by the host; the child's execution id on the parent step. */
      readonly childRunId: string; readonly child: KernelChildDefinitionV2;
      /** Hash-verified whole texts of exactly the lease's `requiredTexts`, keyed by step id. */
      readonly resolvedTexts?: Readonly<Record<string, string>> }>
  | { readonly type: 'childOutputReferences'; readonly child: KernelStateV2 }
  | TaskCommandV2<{ readonly type: 'completePipelineChild'; readonly child: KernelStateV2;
      /** Hash-verified texts of the child's `childOutputReferences`; an unread one is left out. */
      readonly nativeTexts?: Readonly<Record<string, string>> }>;

export interface KernelRequestV2 {
  readonly protocol: typeof GRAPH_KERNEL_PROTOCOL_V2;
  /** Correlation only: the host durably deduplicates command identities. */
  readonly requestId: string;
  readonly command: KernelCommandV2;
}

export type KernelExecutorV2 = keyof KernelExecutorSupportV2;

export interface KernelHostDependencyV2 {
  readonly stepId: string;
  readonly reference?: NativeHistoryReference;
  readonly text?: string;
  readonly data?: unknown;
}

interface KernelHostLeaseV2 {
  readonly runId: string;
  readonly runRevision: Revision;
  readonly taskRevision: Revision;
  readonly leaseId: string;
  readonly stepId: string;
  readonly stepName: string;
}

export interface KernelScriptLeaseV2 extends KernelHostLeaseV2 {
  readonly runtime: ScriptRuntime;
  readonly source: string;
  readonly timeoutSeconds: number;
  readonly inputs: Readonly<Record<string, RunInputValue>>;
  readonly dependencies: readonly KernelHostDependencyV2[];
}

export interface KernelPluginLeaseV2 extends KernelHostLeaseV2 {
  readonly pluginId: string;
  readonly nodeType: string;
  readonly config: Readonly<Record<string, string | number | boolean>>;
  readonly inputs: Readonly<Record<string, RunInputValue>>;
  readonly dependencies: readonly KernelHostDependencyV2[];
}

export interface KernelChildReferenceV2 {
  readonly stepId: string;
  readonly reference: NativeHistoryReference;
}

export interface KernelPipelineLeaseV2 extends KernelHostLeaseV2 {
  /** The saved launch command the host resolves to the child definition. */
  readonly launchCommandId: string;
  /** Native dependency texts the child's inputs read whole; returned as `resolvedTexts`. */
  readonly requiredTexts: readonly KernelChildReferenceV2[];
}

export interface KernelReachableMemberV2 {
  readonly memberId: string;
  readonly profileId: string;
  readonly harness: Harness;
  readonly canSend: boolean;
  readonly canObserve: boolean;
}

export type KernelAgentAdmissionV2 =
  | { readonly type: 'roster'; readonly members: readonly KernelReachableMemberV2[];
      readonly spawnProfiles: readonly AgentProfile[] }
  /** Deliver once, then `markMessageDelivered`; a retry of the request names the same message. */
  | { readonly type: 'send'; readonly messageId: string; readonly recipientMemberId: string;
      readonly body: string; readonly alreadyDelivered: boolean }
  /** References only: the host reads and verifies the histories. */
  | { readonly type: 'observe'; readonly memberId: string;
      readonly historyReferences: readonly NativeHistoryReference[] }
  /** Start this lease, then `dispatch` it with the new native execution. */
  | { readonly type: 'spawn'; readonly lease: KernelLeaseV1 }
  /** The same request already started this execution; nothing to start. */
  | { readonly type: 'spawnCommitted'; readonly stepId: string; readonly memberId: string;
      readonly execution: NativeExecutionReference };

export type KernelEffectV2 =
  | { readonly type: 'compiled'; readonly result: GraphCompileResultV2 }
  /** Exactly the refusals `create` would return as `admissionRefused`; empty when admitted. */
  | { readonly type: 'validated'; readonly refusals: readonly KernelAdmissionRefusalV2[] }
  | { readonly type: 'created' | 'observed' | 'changed' | 'idle' }
  | { readonly type: 'projected'; readonly text: string }
  /** A native turn: `agent` with its tools and team, `llm` as one least-authority turn. */
  | { readonly type: 'leased'; readonly executor: 'agent' | 'llm'; readonly lease: KernelLeaseV1 }
  | { readonly type: 'scriptLeased'; readonly lease: KernelScriptLeaseV2 }
  | { readonly type: 'pluginLeased'; readonly lease: KernelPluginLeaseV2 }
  | { readonly type: 'pipelineLeased'; readonly lease: KernelPipelineLeaseV2 }
  | { readonly type: 'dispatched'; readonly launch: LaunchRequest }
  | { readonly type: 'hostDispatched'; readonly stepId: string; readonly executor: 'script' | 'plugin';
      readonly execution: NativeExecutionReference }
  /** For `pipeline` the execution is the child run to cancel. */
  | { readonly type: 'cancellations'; readonly requests: readonly {
      readonly runId: string; readonly stepId: string; readonly executor: KernelExecutorV2;
      readonly execution: NativeExecutionReference }[] }
  | { readonly type: 'agentAdmission'; readonly admission: KernelAgentAdmissionV2 }
  | { readonly type: 'childStarted'; readonly stepId: string; readonly childRunId: string }
  | { readonly type: 'childOutputReferences'; readonly references: readonly KernelChildReferenceV2[] };

/** Typed, never guessed: why a bound location or adapter cannot run part of a graph. */
export const KERNEL_ADMISSION_REFUSALS_V2 = [
  /** The binding has no adapter capabilities for a frozen profile. */
  'missingCapabilities',
  /** The graph needs an adapter capability or coordinator operation the bound adapter does not offer. */
  'unsupportedCapability',
  /** The bound location does not run this step's executor. */
  'unsupportedExecutor',
  /** A spawn grant is not same-or-less authority (native defaults of unlike harnesses are incomparable). */
  'delegationDenied',
] as const;

export type KernelAdmissionRefusalCodeV2 = (typeof KERNEL_ADMISSION_REFUSALS_V2)[number];

export type KernelAdmissionSubjectV2 =
  | { readonly kind: 'profile' | 'step' | 'team'; readonly id: string }
  | { readonly kind: 'sendEdge' | 'observeEdge'; readonly fromMemberId: string; readonly toMemberId: string };

export interface KernelAdmissionRefusalV2 {
  readonly code: KernelAdmissionRefusalCodeV2;
  readonly subject: KernelAdmissionSubjectV2;
}

export type KernelErrorCodeV2 =
  | 'invalidRequest' | 'unsupportedProtocol' | 'unsupportedSnapshotVersion' | 'invalidSnapshot'
  | 'unsupportedBindingVersion' | 'invalidBinding' | 'ownerMismatch' | 'invalidDefinition'
  | 'admissionRefused' | 'unsupportedExecutor' | 'executorMismatch' | 'unsupportedCapability'
  | 'revisionConflict' | 'staleExecution' | 'leaseConflict' | 'foreignExecution'
  | 'foreignHistoryReference' | 'agentRequestRefused' | 'childRefused' | 'childNotEnded'
  | 'invalidTransition' | 'serializationFailed';

/** The shared admission boundary's refusal of an agent request (`piui_orchestration::AgentRequestError`). */
export interface KernelAgentRequestRefusalV2 {
  readonly disposition: 'invalid' | 'denied' | 'conflict' | 'notFound';
  readonly reason:
    | 'emptyRequestId' | 'operationUnavailable' | 'unknownActor' | 'toolDenied' | 'routeDenied'
    | 'recordRefused' | 'messageConflict' | 'messageRefused' | 'spawnAgentRefused'
    | 'spawnAgentLeaseRefused' | 'spawnLeaseRefused';
}

export interface KernelErrorV2 {
  readonly code: KernelErrorCodeV2;
  readonly message: string;
  /** Every unsupported part (`admissionRefused`, or the child of a `childRefused`). */
  readonly refusals?: readonly KernelAdmissionRefusalV2[];
  /** `childRefused`: the certain failure the host records with `rejectLeased`. */
  readonly failure?: FailureRecord;
  /** `agentRequestRefused` only. */
  readonly agentRequest?: KernelAgentRequestRefusalV2;
}

export interface KernelRunSummaryV2 {
  readonly id: string;
  readonly revision: Revision;
  readonly status: RunStatus;
  readonly paused: boolean;
  readonly needsRestore: boolean;
  readonly readyTaskIds: readonly string[];
}

export interface KernelPersistedStateV2 {
  readonly snapshot: string;
  readonly binding: string;
}

export type KernelResponseV2 =
  | { readonly protocol: 2; readonly requestId: string; readonly status: 'ok';
      /** Absent only for `compile` and `validate`. Persist atomically before acting on the effect. */
      readonly state?: KernelPersistedStateV2; readonly run?: KernelRunSummaryV2;
      /** `startPipelineChild`: the new child run, persisted in the same transaction. */
      readonly child?: { readonly state: KernelPersistedStateV2; readonly run: KernelRunSummaryV2 };
      readonly effect: KernelEffectV2 }
  | { readonly protocol: 2; readonly requestId: string | null; readonly status: 'error';
      readonly error: KernelErrorV2 };
