/** Trusted WebView-to-host orchestration commands v4.
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
  OrchestrationRunV4,
  PipelineDefinition,
  Revision,
  TeamDefinition,
} from './orchestration-v4';

export type OrchestrationDefinitionKind = 'profile' | 'team' | 'pipeline' | 'launch-command';

export interface DefinitionSummary {
  readonly id: OrchestrationId;
  readonly name: string;
  readonly revision: Revision;
}

export interface OrchestrationCatalogV4 {
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
  readonly status: OrchestrationRunV4['status'];
  readonly revision: Revision;
  readonly teamName: string;
  readonly pipelineName: string;
}


export const ORCHESTRATION_EVENT_V4 = 'piui://orchestration-event' as const;

/** Emitted only after the durable generation containing this revision commits. */
export interface OrchestrationRunChangedEventV4 {
  readonly protocol: 4;
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

export interface OrchestrationHostCommandsV4 {
  orchestration_save_graph_v4(request: SaveGraphRequest): Promise<void>;
  orchestration_catalog_v4(request: WorkspaceRequest): Promise<OrchestrationCatalogV4>;

  orchestration_get_profile_v4(request: GetDefinitionRequest): Promise<StoredDefinition<AgentProfile> | null>;
  orchestration_save_profile_v4(request: SaveDefinitionRequest<AgentProfile>): Promise<StoredDefinition<AgentProfile>>;
  orchestration_delete_profile_v4(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_team_v4(request: GetDefinitionRequest): Promise<StoredDefinition<TeamDefinition> | null>;
  orchestration_save_team_v4(request: SaveDefinitionRequest<TeamDefinition>): Promise<StoredDefinition<TeamDefinition>>;
  orchestration_delete_team_v4(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_pipeline_v4(request: GetDefinitionRequest): Promise<StoredDefinition<PipelineDefinition> | null>;
  orchestration_save_pipeline_v4(request: SaveDefinitionRequest<PipelineDefinition>): Promise<StoredDefinition<PipelineDefinition>>;
  orchestration_delete_pipeline_v4(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_get_launch_command_v4(
    request: GetDefinitionRequest,
  ): Promise<StoredDefinition<LaunchCommandReference> | null>;
  orchestration_save_launch_command_v4(
    request: SaveDefinitionRequest<LaunchCommandReference>,
  ): Promise<StoredDefinition<LaunchCommandReference>>;
  orchestration_delete_launch_command_v4(request: DeleteDefinitionRequest): Promise<void>;

  orchestration_list_runs_v4(request: WorkspaceRequest): Promise<readonly RunSummary[]>;
  orchestration_get_run_v4(request: RunRequest): Promise<OrchestrationRunV4 | null>;
  orchestration_start_run_v4(request: StartRunRequest): Promise<OrchestrationRunV4>;
  orchestration_cancel_run_v4(request: RunMutationRequest): Promise<OrchestrationRunV4>;
  orchestration_reconcile_uncertain_task_v4(
    request: ReconcileUncertainTaskRequest,
  ): Promise<OrchestrationRunV4>;
  orchestration_retry_uncertain_task_v4(request: RetryUncertainTaskRequest): Promise<OrchestrationRunV4>;
}
