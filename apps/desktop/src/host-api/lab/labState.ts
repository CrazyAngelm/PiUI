import type {
  AgentKind, AgentProfile, DesktopTimelineBlock, HarnessKind, HarnessSummary, LaunchCommandReference,
  PermissionMode, PipelineDefinition, Preferences, ProjectSummary, ProjectTrustState, QueuedMessage,
  ScheduleDefinition, ScheduleOccurrence, ScriptRuntime, SessionStatus, StoredDefinition, TeamDefinition, UsageReceipt,
  WorkspaceApproval, WorkspaceModel, WorkspaceSession, WorkspaceSummary,
} from './labContracts';
import type { LabRun } from './orchestration/runEngine';
import { apiFailure } from './labErrors';
import type { LabIdSource } from './labRandom';

export type LabScenarioName = 'demo' | 'empty' | 'safe' | 'long';
export const LAB_SCENARIOS: readonly LabScenarioName[] = ['demo', 'empty', 'safe', 'long'];

/** A registered folder. The personal Chats workspace is host-owned and always trusted. */
export interface LabProject {
  id: string;
  name: string;
  displayPath: string;
  agentKind: AgentKind;
  trustState: ProjectTrustState;
  pinned: boolean;
  missing: boolean;
  personal: boolean;
  lastOpenedAt?: string;
}

export interface LabQueue {
  revision: number;
  paused: boolean;
  items: QueuedMessage[];
}

/** Present while a native runtime is "open" for the session. */
export interface LabLiveState {
  status: SessionStatus;
  approvals: WorkspaceApproval[];
  /** Set by the first composer command, like the host's composer notifier. */
  composerNotify: boolean;
  /** Runtime-level outbox pause (interrupt, failure); distinct from the durable `queue.paused`. */
  composerPaused: boolean;
  /** A drained outbox message whose turn has not reached its terminal outcome yet. */
  composerWaiting: boolean;
  /** Plain `send` prompts accepted while a turn is active (native follow-up queue). */
  pendingPrompts: string[];
}

/** The host registry row plus the native history the fake harness owns. */
export interface LabSessionRecord {
  id: string;
  workspaceId: string;
  harness: HarnessKind;
  title: string;
  updatedAt: string;
  model?: WorkspaceModel;
  thinkingLevel?: string;
  serviceTier?: 'standard' | 'fast';
  permissionMode: PermissionMode;
  /** The agent-advertised session mode of a live ACP session (`workspace_session_mode_v1`). */
  mode?: string;
  profileId?: string;
  runId?: string;
  memberId?: string;
  /** Persisted event watermark; advanced by every published event and by close. */
  revision: number;
  /** Native history with full text and harness labels. */
  blocks: DesktopTimelineBlock[];
  usage: UsageReceipt[];
  composer: LabQueue;
  turnSerial: number;
  live?: LabLiveState;
}

export interface LabSchedule {
  revision: number;
  triggerRevision: number;
  value: ScheduleDefinition;
  enabled: boolean;
  enabledLaunchCommandRevision: number | null;
  nextDueAt: string | null;
  occurrences: ScheduleOccurrence[];
}

export interface LabOrchestrationWorkspace {
  workspaceId: string;
  profiles: StoredDefinition<AgentProfile>[];
  teams: StoredDefinition<TeamDefinition>[];
  pipelines: StoredDefinition<PipelineDefinition>[];
  launchCommands: StoredDefinition<LaunchCommandReference>[];
  schedules: LabSchedule[];
  runs: LabRun[];
}

export interface LabState {
  scenario: LabScenarioName;
  safeMode: boolean;
  appVersion: string;
  preferences: Preferences;
  projects: LabProject[];
  harnesses: HarnessSummary[];
  /** Script interpreters this fake machine lacks (v6.2); all are present unless listed. */
  missingScriptRuntimes?: ScriptRuntime[];
  /** Insertion order is the host registry order. */
  sessions: Map<string, LabSessionRecord>;
  orchestration: Map<string, LabOrchestrationWorkspace>;
  ids: LabIdSource;
}

/** IPC boundary: JSON round-trip drops `undefined` exactly like serde `skip_serializing_if`. */
export function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function newQueue(): LabQueue {
  return { revision: 0, paused: false, items: [] };
}

export function newLiveState(status: SessionStatus): LabLiveState {
  return { status, approvals: [], composerNotify: false, composerPaused: false, composerWaiting: false, pendingPrompts: [] };
}

/** Queued, sending and uncertain messages still need a decision. */
export function queuePending(queue: LabQueue): boolean {
  return queue.items.some((item) => item.status === 'queued' || item.status === 'sending' || item.status === 'uncertain');
}

export function emptyOrchestration(workspaceId: string): LabOrchestrationWorkspace {
  return { workspaceId, profiles: [], teams: [], pipelines: [], launchCommands: [], schedules: [], runs: [] };
}

export function sessionStatus(record: LabSessionRecord): SessionStatus {
  return record.live?.status ?? 'closed';
}

export function workspaceSummary(project: LabProject): WorkspaceSummary {
  return {
    id: project.id,
    name: project.name,
    trust: project.trustState === 'trusted' ? 'trusted' : 'restricted',
    missing: project.missing,
    personal: project.personal,
  };
}

export function projectSummary(project: LabProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    displayPath: project.displayPath,
    agentKind: project.agentKind,
    trustState: project.trustState,
    pinned: project.pinned,
    missing: project.missing,
    ...(project.lastOpenedAt === undefined ? {} : { lastOpenedAt: project.lastOpenedAt }),
  };
}

export function sessionSummary(record: LabSessionRecord): WorkspaceSession {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    harness: record.harness,
    title: record.title,
    status: sessionStatus(record),
    updatedAt: record.updatedAt,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.profileId === undefined ? {} : { profileId: record.profileId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.memberId === undefined ? {} : { memberId: record.memberId }),
  };
}

/**
 * Mirrors `verified_project_directory`: unknown projects are NOT_FOUND, missing
 * folders PROJECT_UNAVAILABLE and, when required, untrusted ones NOT_TRUSTED.
 */
export function verifiedProject(state: LabState, projectId: string, requireTrusted: boolean): LabProject {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw apiFailure('NOT_FOUND');
  if (requireTrusted && project.trustState !== 'trusted') throw apiFailure('NOT_TRUSTED');
  if (project.missing) throw apiFailure('PROJECT_UNAVAILABLE');
  return project;
}
