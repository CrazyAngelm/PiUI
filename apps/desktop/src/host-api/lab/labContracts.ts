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
  RunTrigger,
  ScriptRuntime,
  StepExecutor,
  TaskOutput,
  TaskRecord,
  TaskStatus,
  TeamDefinition,
} from '../../../../../contracts/orchestration-v6';
export type {
  AutomationsStateV7,
  CancelTaskRequest,
  ChatRunTrigger,
  DefinitionSummary,
  DeleteDefinitionRequest,
  EventTrigger,
  FinishedOutcome,
  FlowAction,
  FlowControlRequest,
  GetDefinitionRequest,
  OrchestrationCatalogV6,
  OrchestrationAutomationsChangedEventV7,
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
  SetAutomationsPausedRequest,
  SetScheduleEnabledRequest,
  StartRunRequest,
  StartRunRequestV7,
  StoredDefinition,
  UsageReceipt,
  WorkspaceRequest,
} from '../../../../../contracts/orchestration-host-v7';
export {
  EVENT_COOLDOWN_SECONDS,
  MAX_DEBOUNCE_SECONDS,
  MAX_TRIGGER_PATTERNS,
  MIN_DEBOUNCE_SECONDS,
  ORCHESTRATION_AUTOMATIONS_EVENT_V7,
  ORCHESTRATION_EVENT_V6,
  ORCHESTRATION_SCHEDULE_EVENT_V7,
} from '../../../../../contracts/orchestration-host-v7';
export { MAX_TRIGGER_CHAIN_DEPTH } from '../../../../../contracts/orchestration-v6';
export type {
  BackgroundSettingsV1,
  BackgroundUpdateRequest,
  TrayLabelsV1,
} from '../../../../../contracts/background-v1';
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
