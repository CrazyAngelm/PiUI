/** Private .NET host <-> Rust graph kernel protocol, not exposed to the WebView.
 * Every request and nested definition rejects unknown fields in Rust. A response
 * effect becomes executable only after the host's snapshot/outbox transaction.
 */
import type {
  AgentProfile, CancelRequest, CompletionOutcome, FailureRecord, LaunchRequest,
  NativeBridgeCapabilities, NativeExecutionReference, NativeHistoryReference,
  Revision, RunDefinitionSnapshot, RunInputValue, RunStatus, RunTrigger,
} from './orchestration-v6';

export interface KernelStateV1 {
  readonly snapshot: string;
  readonly expectedRunRevision: Revision;
}

export type KernelFlowActionV1 =
  | { readonly type: 'pause' | 'resume' }
  | { readonly type: 'decide'; readonly stepId: string; readonly taskRevision: Revision; readonly approved: boolean }
  | { readonly type: 'repeat'; readonly stepId: string; readonly taskRevision: Revision };

export type KernelCommandV1 =
  | { readonly type: 'projectResult'; readonly state: KernelStateV1; readonly text: string;
      readonly fields: NonNullable<NativeHistoryReference['fields']> }
  | { readonly type: 'create'; readonly runId: string; readonly definition: RunDefinitionSnapshot;
      readonly profileCapabilities: Readonly<Record<string, NativeBridgeCapabilities>>;
      readonly inputs: Readonly<Record<string, RunInputValue>>; readonly trigger?: RunTrigger; readonly usePinnedData: boolean }
  | { readonly type: 'inspect' | 'advance' | 'cancellationRequests' | 'cancel' | 'restore'; readonly state: KernelStateV1 }
  | { readonly type: 'lease'; readonly state: KernelStateV1; readonly leaseId: string }
  | { readonly type: 'dispatch'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision;
      readonly leaseId: string; readonly execution: NativeExecutionReference }
  | { readonly type: 'releaseLease'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision; readonly leaseId: string }
  | { readonly type: 'rejectReady'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision; readonly failure: FailureRecord }
  | { readonly type: 'completeChecked'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision;
      readonly executionId: string; readonly outcome: CompletionOutcome; readonly text?: string }
  | { readonly type: 'markUncertain'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision;
      readonly identity: { readonly type: 'execution' | 'lease'; readonly id: string } }
  | { readonly type: 'reconcile'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision;
      readonly resolution: CompletionOutcome | { readonly status: 'cancelled' } }
  | { readonly type: 'retryUncertain'; readonly state: KernelStateV1; readonly stepId: string; readonly expectedTaskRevision: Revision }
  | { readonly type: 'controlFlow'; readonly state: KernelStateV1; readonly action: KernelFlowActionV1 };

export interface KernelRequestV1 {
  readonly protocol: 1;
  /** Correlation only: the host durably deduplicates command identities. */
  readonly requestId: string;
  readonly command: KernelCommandV1;
}

export interface KernelLeaseV1 {
  readonly runId: string;
  readonly runRevision: Revision;
  readonly taskRevision: Revision;
  readonly leaseId: string;
  readonly stepId: string;
  readonly memberId: string;
  readonly profile: AgentProfile;
  readonly taskInstructions: string;
  readonly dependencyResultReferences: readonly NativeHistoryReference[];
  readonly dependencyOutputs: readonly {
    readonly stepId: string;
    readonly fields: NonNullable<NativeHistoryReference['fields']>;
    readonly text?: string;
    readonly data?: unknown;
  }[];
}

export type KernelEffectV1 =
  | { readonly type: 'projected'; readonly text: string }
  | { readonly type: 'created' | 'observed' | 'changed' | 'idle' }
  | { readonly type: 'leased'; readonly lease: KernelLeaseV1 }
  | { readonly type: 'dispatched'; readonly launch: LaunchRequest }
  | { readonly type: 'cancellations'; readonly requests: readonly CancelRequest[] };

export type KernelErrorCodeV1 =
  | 'invalidRequest' | 'unsupportedProtocol' | 'unsupportedSnapshotVersion'
  | 'invalidSnapshot' | 'invalidDefinition' | 'unsupportedExecutor'
  | 'unsupportedCapability' | 'missingCapabilities' | 'revisionConflict'
  | 'staleExecution' | 'leaseConflict' | 'invalidTransition' | 'serializationFailed';

export type KernelResponseV1 =
  | { readonly protocol: 1; readonly requestId: string; readonly status: 'ok'; readonly snapshot: string;
      readonly run: { readonly id: string; readonly revision: Revision; readonly status: RunStatus; readonly paused: boolean;
        readonly needsRestore: boolean; readonly readyTaskIds: readonly string[] }; readonly effect: KernelEffectV1 }
  | { readonly protocol: 1; readonly requestId: string | null; readonly status: 'error';
      readonly error: { readonly code: KernelErrorCodeV1; readonly message: string } };
