/**
 * Single import point for the contract types the UI Lab host fakes. Keeping
 * the long relative paths here lets every lab module type itself against the
 * exact frozen host contracts without repeating them.
 */
export type {
  ApprovalDecision,
  Capability,
  HarnessCapabilities,
  HarnessKind,
  HarnessSummary,
  PermissionMode,
  SessionSnapshot,
  SessionStatus,
  WorkspaceApproval,
  WorkspaceCatalog,
  WorkspaceCommand,
  WorkspaceEvent,
  WorkspaceEventPayload,
  WorkspaceModel,
  WorkspaceResult,
  WorkspaceSession,
  WorkspaceSummary,
} from '../../../../../contracts/workspace-v15';
export type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
export type { RuntimeSettings, RuntimeSettingsCommand } from '../../../../../contracts/workspace-settings-v16';
export type { WorkspaceLifecycleCommand, WorkspaceLifecycleResult } from '../../../../../contracts/workspace-lifecycle-v17';
export type {
  ComposerCommand,
  ComposerSnapshot,
  Delivery,
  QueuedMessage,
} from '../../../../../contracts/workspace-composer-v19';
export type {
  HarnessCatalogModel,
  HarnessModelsRequest,
  HarnessModelsResult,
  HarnessResource,
} from '../../../../../contracts/harness-models-v18';
export type { WorkspaceHistoryRequestV1, WorkspaceHistoryResultV1 } from '../../../../../contracts/workspace-history-v1';
export type {
  AgentProfile,
  AgentRequestRecord,
  FailureRecord,
  InputBinding,
  LaunchCommandReference,
  MessageRecord,
  NativeExecutionReference,
  NativeHistoryReference,
  OrchestrationRunV6,
  PipelineDefinition,
  PipelineInput,
  PipelineStep,
  ResultField,
  RouterConfig,
  RouterPredicate,
  RunDefinitionSnapshot,
  RunInputValue,
  RunStatus,
  ScriptRuntime,
  StepExecutor,
  TaskOutput,
  TaskRecord,
  TaskStatus,
  TeamDefinition,
} from '../../../../../contracts/orchestration-v6';
export type {
  CancelTaskRequest,
  DefinitionSummary,
  DeleteDefinitionRequest,
  FlowAction,
  FlowControlRequest,
  GetDefinitionRequest,
  OrchestrationCatalogV6,
  OrchestrationHostErrorCode,
  OrchestrationRunChangedEventV6,
  OrchestrationScheduleChangedEventV7,
  ReconcileUncertainTaskRequest,
  RetryUncertainTaskRequest,
  RunMutationRequest,
  RunRequest,
  RunSummary,
  SaveDefinitionRequest,
  SaveGraphRequest,
  SaveScheduleRequest,
  ScheduleDefinition,
  ScheduleMutationRequest,
  ScheduleOccurrence,
  ScheduleSnapshot,
  ScheduleTrigger,
  SetScheduleEnabledRequest,
  StartRunRequest,
  StoredDefinition,
  UsageReceipt,
  WorkspaceRequest,
} from '../../../../../contracts/orchestration-host-v7';
export {
  ORCHESTRATION_EVENT_V6,
  ORCHESTRATION_SCHEDULE_EVENT_V7,
} from '../../../../../contracts/orchestration-host-v7';
export type {
  AgentKind,
  AppSnapshot,
  Preferences,
  ProjectSummary,
  ProjectTrustState,
} from '../types';

/** Event channels emitted by the Rust host outside the orchestration contract files. */
export const WORKSPACE_EVENT_CHANNEL = 'piui://workspace-event';
export const COMPOSER_EVENT_CHANNEL = 'piui://composer-v19';
