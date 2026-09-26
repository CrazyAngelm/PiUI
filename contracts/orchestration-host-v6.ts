/** Trusted WebView-to-host orchestration commands v6.
 *
 * Command arguments contain opaque workspace/definition ids only. There is no
 * shell, filesystem, credential, native session, sender, or process surface.
 * Agent-to-agent sender identity is established inside the trusted scheduler
 * and is deliberately not an IPC field.
 */

import type {
  AgentProfile,
  LaunchCommandReference,
  NativeHistoryReference,
  OrchestrationId,
  OrchestrationRunV6,
  PipelineDefinition,
  Revision,
  RunInputValue,
  TeamDefinition,
} from './orchestration-v6';

export type OrchestrationDefinitionKind = 'profile' | 'team' | 'pipeline' | 'launch-command';

export interface DefinitionSummary {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly revision: Revision;
}

export interface OrchestrationCatalogV6 {
  readonly profiles: readonly DefinitionSummary[];
  readonly teams: readonly DefinitionSummary[];
  readonly pipelines: readonly DefinitionSummary[];
  readonly launchCommands: readonly DefinitionSummary[];
}

export interface StoredDefinition<T> {
  readonly revision: Revision;
  readonly value: T;
}

export interface WorkspaceRequest {
  readonly workspaceId: OrchestrationId;
}

export interface GetDefinitionRequest extends WorkspaceRequest {
  readonly id: OrchestrationId;
}

/** Omit expectedRevision only when creating a new id. */
export interface SaveDefinitionRequest<T> extends WorkspaceRequest {
  readonly expectedRevision?: Revision;
  readonly value: T;
}

export interface DeleteDefinitionRequest extends WorkspaceRequest {
  readonly id: OrchestrationId;
  readonly expectedRevision: Revision;
}

export interface StartRunRequest extends WorkspaceRequest {
  readonly runId: OrchestrationId;
  readonly teamId: OrchestrationId;
  readonly pipelineId: OrchestrationId;
  readonly launchCommandId?: OrchestrationId;
  /** Additive (v6.1): values for the pipeline's declared inputs. */
  readonly inputs?: Readonly<Record<string, RunInputValue>>;
  /**
   * Additive (v6.3): admit pinned steps from their pinned data instead of
   * running them. Refused with `conflict` when the saved pipeline has no
   * pinned step. Absent or false runs every step and freezes no pins.
   */
  readonly usePinnedData?: boolean;
}

export interface RunRequest extends WorkspaceRequest {
  readonly runId: OrchestrationId;
}

export interface RunMutationRequest extends RunRequest {
  readonly expectedRunRevision: Revision;
}

export interface ReconcileUncertainTaskRequest extends RunMutationRequest {
  readonly stepId: OrchestrationId;
  readonly expectedTaskRevision: Revision;
  readonly resolution:
    | { readonly status: 'succeeded'; readonly resultReference?: NativeHistoryReference }
    | { readonly status: 'failed'; readonly failureCode: string }
    | { readonly status: 'cancelled' };
}

export interface RetryUncertainTaskRequest extends RunMutationRequest {
  readonly stepId: OrchestrationId;
  readonly expectedTaskRevision: Revision;
}

export interface RunSummary {
  readonly id: OrchestrationId;
  readonly status: OrchestrationRunV6['status'];
  readonly revision: Revision;
  readonly teamName: string;
  readonly pipelineName: string;
  /** Additive (v6.3): hidden from the default run list (run debugging v1). */
  readonly archived?: boolean;
}


export const ORCHESTRATION_EVENT_V6 = 'piui://orchestration-event' as const;

/** Emitted only after the durable generation containing this revision commits. */
export interface OrchestrationRunChangedEventV6 {
  readonly protocol: 6;
  readonly type: 'runChanged';
  readonly workspaceId: OrchestrationId;
  readonly runId: OrchestrationId;
  readonly revision: Revision;
}

export type OrchestrationHostErrorCode =
  | 'invalid'
  | 'conflict'
  | 'not-found'
  | 'already-exists'
  | 'io'
  | 'runtime-unavailable'
  | 'unsupported-policy'
  | 'native-outcome-uncertain'
  | 'denied';

export interface SaveGraphRequest extends WorkspaceRequest {
  readonly profiles: readonly SaveDefinitionRequest<AgentProfile>[];
  readonly team: SaveDefinitionRequest<TeamDefinition>;
  readonly pipeline: SaveDefinitionRequest<PipelineDefinition>;
  readonly command: SaveDefinitionRequest<LaunchCommandReference>;
}

export interface UsageReceipt { readonly id: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly totalTokens?: number; }
export type FlowAction = { readonly type: 'pause' | 'resume' } | { readonly type: 'decide'; readonly stepId: string; readonly taskRevision: number; readonly approved: boolean } | { readonly type: 'repeat'; readonly stepId: string; readonly taskRevision: number };
export interface FlowControlRequest extends RunMutationRequest { readonly action: FlowAction; }
export interface CancelTaskRequest extends RunMutationRequest { readonly stepId: string; }
export interface OrchestrationHostCommandsV6 {
  orchestration_cancel_task_v6(request: CancelTaskRequest): Promise<OrchestrationRunV6>;
  orchestration_control_flow_v6(request: FlowControlRequest): Promise<OrchestrationRunV6>;
  orchestration_run_usage_v6(request: RunRequest): Promise<Record<string, UsageReceipt[]>>;
  orchestration_save_graph_v6(request: SaveGraphRequest): Promise<void>;
  orchestration_catalog_v6(request: WorkspaceRequest): Promise<OrchestrationCatalogV6>;

  orchestration_get_profile_v6(request: GetDefinitionRequest): Promise<StoredDefinition<AgentProfile> | null>;
  orchestration_save_profile_v6(request: SaveDefinitionRequest<AgentProfile>): Promise<StoredDefinition<AgentProfile>>;
  orchestration_delete_profile_v6(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_team_v6(request: GetDefinitionRequest): Promise<StoredDefinition<TeamDefinition> | null>;
  orchestration_save_team_v6(request: SaveDefinitionRequest<TeamDefinition>): Promise<StoredDefinition<TeamDefinition>>;
  orchestration_delete_team_v6(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_pipeline_v6(request: GetDefinitionRequest): Promise<StoredDefinition<PipelineDefinition> | null>;
  orchestration_save_pipeline_v6(request: SaveDefinitionRequest<PipelineDefinition>): Promise<StoredDefinition<PipelineDefinition>>;
  orchestration_delete_pipeline_v6(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_launch_command_v6(
    request: GetDefinitionRequest,
  ): Promise<StoredDefinition<LaunchCommandReference> | null>;
  orchestration_save_launch_command_v6(
    request: SaveDefinitionRequest<LaunchCommandReference>,
  ): Promise<StoredDefinition<LaunchCommandReference>>;
  orchestration_delete_launch_command_v6(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_list_runs_v6(request: WorkspaceRequest): Promise<readonly RunSummary[]>;
  orchestration_get_run_v6(request: RunRequest): Promise<OrchestrationRunV6 | null>;
  orchestration_start_run_v6(request: StartRunRequest): Promise<OrchestrationRunV6>;
  orchestration_cancel_run_v6(request: RunMutationRequest): Promise<OrchestrationRunV6>;
  orchestration_reconcile_uncertain_task_v6(
    request: ReconcileUncertainTaskRequest,
  ): Promise<OrchestrationRunV6>;
  orchestration_retry_uncertain_task_v6(request: RetryUncertainTaskRequest): Promise<OrchestrationRunV6>;
}
