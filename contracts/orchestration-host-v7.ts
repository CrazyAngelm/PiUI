/** Calendar schedule extension for the PiUI orchestration host.
 *
 * v6 run and definition commands remain available unchanged. Schedule writes
 * are a distinct v7 contract because saving a definition is not execution
 * authorization. Newly created and execution-affecting edited schedules are
 * disabled until an explicit revision-bound enable request.
 *
 * v7.2 (additive) adds event triggers ("when a pipeline finishes", "when
 * files change"), skip outcomes with a typed reason, a durable "pause all
 * automations" switch with its own invalidation event, and a `chat` trigger
 * a caller may state when it starts a run. Stored v7.0/v7.1 data decodes
 * unchanged; older builds refuse an event trigger instead of misreading it.
 */

import type {
  OrchestrationHostCommandsV6,
  StartRunRequest,
  WorkspaceRequest,
} from './orchestration-host-v6';
import type { OrchestrationId, OrchestrationRunV6, Revision, RunInputValue } from './orchestration-v6';

export * from './orchestration-host-v6';

/** How a watched run ended (v7.2). An uncertain run has not ended yet. */
export type FinishedOutcome = 'succeeded' | 'failed' | 'cancelled';

/** Shortest and longest quiet period of a "files changed" rule (v7.2). */
export const MIN_DEBOUNCE_SECONDS = 2;
export const MAX_DEBOUNCE_SECONDS = 3600;
/** Most include or exclude patterns per rule, and the longest pattern. */
export const MAX_TRIGGER_PATTERNS = 32;
export const MAX_TRIGGER_PATTERN_LENGTH = 256;
/** One event automation starts at most one run in this many seconds. */
export const EVENT_COOLDOWN_SECONDS = 30;

/**
 * What an event automation waits for (v7.2). Patterns are `/`-separated and
 * relative to the project folder: `*` and `?` stay inside a name, `**` spans
 * folders, `[a-z]` and `{ts,svelte}` are allowed. A pattern without a slash
 * matches a name at any depth; a matching folder covers everything inside it.
 * `.git`, `node_modules`, `target`, `dist`, `.pi` and `.piui` are never watched.
 */
export type EventTrigger =
  | {
      readonly kind: 'run-finished';
      readonly launchCommandId: OrchestrationId;
      /** At least one, without repeats. */
      readonly outcomes: readonly FinishedOutcome[];
    }
  | {
      readonly kind: 'files-changed';
      readonly include: readonly string[];
      /** Omitted when empty. */
      readonly exclude?: readonly string[];
      readonly debounceSeconds: number;
    };

export type ScheduleTrigger =
  | { readonly type: 'once'; readonly at: string; readonly timeZone: string }
  | {
      readonly type: 'interval';
      readonly every: number;
      readonly unit: 'minutes' | 'hours';
      readonly anchorAt: string;
      readonly timeZone: string;
    }
  /**
   * Additive (v7.1): local wall-clock `time` (`HH:MM`) on ISO weekdays `days`
   * (1 = Monday ... 7 = Sunday) in the IANA `timeZone`, never before
   * `startsAt`. Clock-change gaps fire at the first valid minute after them;
   * repeated local times fire once, at the first.
   */
  | {
      readonly type: 'calendar';
      readonly time: string;
      readonly days: readonly number[];
      readonly startsAt: string;
      readonly timeZone: string;
    }
  /**
   * Additive (v7.2): fires when the host observes the event while it runs.
   * It has no due time (`nextDueAt` stays null) and its schedule must use
   * `missedRunPolicy: 'skip'`: events are never replayed.
   */
  | { readonly type: 'event'; readonly event: EventTrigger };

export type MissedRunPolicy = 'skip' | 'coalesce';
export type OverlapPolicy = 'allow' | 'skip';
export type ScheduleOccurrenceOutcome =
  | 'started'
  | 'skippedMissed'
  | 'skippedOverlap'
  | 'failed'
  /** Additive (v7.2): the run would exceed the event chain depth limit. */
  | 'skippedChainLimit'
  /** Additive (v7.2): this automation started a run less than the cooldown ago. */
  | 'skippedCooldown'
  /** Additive (v7.2): all automations were paused. */
  | 'skippedPaused';

export interface ScheduleDefinition {
  readonly id: string;
  readonly name: string;
  readonly launchCommandId: string;
  readonly trigger: ScheduleTrigger;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly overlapPolicy: OverlapPolicy;
  /** Additive: input values for every run this schedule starts. */
  readonly inputs?: Readonly<Record<string, RunInputValue>>;
}

export interface ScheduleOccurrence {
  readonly id: string;
  readonly nominalAt: string;
  readonly recordedAt: string;
  readonly outcome: ScheduleOccurrenceOutcome;
  readonly runId?: string;
  readonly failureCode?: string;
  /** Additive (v7.2): the finished run a "pipeline finished" rule reacted to. */
  readonly sourceRunId?: string;
  /** Additive (v7.2): event hops the started (or refused) run would have. */
  readonly chainDepth?: number;
}

export interface ScheduleSnapshot {
  readonly revision: Revision;
  readonly triggerRevision: Revision;
  readonly value: ScheduleDefinition;
  readonly enabled: boolean;
  readonly nextDueAt?: string | null;
  readonly lastOccurrence?: ScheduleOccurrence | null;
}

export interface SaveScheduleRequest extends WorkspaceRequest {
  readonly expectedRevision?: Revision;
  readonly value: ScheduleDefinition;
}

export interface ScheduleMutationRequest extends WorkspaceRequest {
  readonly id: string;
  readonly expectedRevision: Revision;
}

export interface SetScheduleEnabledRequest extends ScheduleMutationRequest {
  readonly enabled: boolean;
}

/** Additive (v7.2): the only run origin a caller may state; the host records automations itself. */
export interface ChatRunTrigger {
  readonly kind: 'chat';
  /** The chat's workspace session id, at most 128 characters. */
  readonly sessionId?: OrchestrationId;
}

/** `orchestration_start_run_v6` request as of host v7.2. */
export interface StartRunRequestV7 extends StartRunRequest {
  readonly trigger?: ChatRunTrigger;
}

/** Additive (v7.2): whether automations may start runs. */
export interface AutomationsStateV7 {
  readonly paused: boolean;
}

export type AutomationsStateRequest = Readonly<Record<string, never>>;

export interface SetAutomationsPausedRequest {
  readonly paused: boolean;
}

export const ORCHESTRATION_SCHEDULE_EVENT_V7 = 'piui://orchestration-schedule-event' as const;

export interface OrchestrationScheduleChangedEventV7 {
  readonly protocol: 7;
  readonly type: 'scheduleChanged';
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly revision: Revision;
}

/** Additive (v7.2): emitted after automations were paused or resumed (UI or tray). */
export const ORCHESTRATION_AUTOMATIONS_EVENT_V7 = 'piui://orchestration-automations-event' as const;

export interface OrchestrationAutomationsChangedEventV7 {
  readonly protocol: 7;
  readonly type: 'automationsChanged';
  readonly paused: boolean;
}

export interface OrchestrationHostCommandsV7 extends Omit<OrchestrationHostCommandsV6, 'orchestration_start_run_v6'> {
  orchestration_start_run_v6(request: StartRunRequestV7): Promise<OrchestrationRunV6>;
  orchestration_list_schedules_v7(request: WorkspaceRequest): Promise<readonly ScheduleSnapshot[]>;
  orchestration_save_schedule_v7(request: SaveScheduleRequest): Promise<ScheduleSnapshot>;
  orchestration_set_schedule_enabled_v7(request: SetScheduleEnabledRequest): Promise<ScheduleSnapshot>;
  orchestration_delete_schedule_v7(request: ScheduleMutationRequest): Promise<void>;
}

/**
 * Additive (v7.2): the global automation switch. It is not scoped to a
 * workspace, so it is a separate command set from the workspace commands.
 */
export interface OrchestrationAutomationCommandsV7 {
  /** Reads the durable pause switch. */
  orchestration_automations_v7(request: AutomationsStateRequest): Promise<AutomationsStateV7>;
  /** Pauses or resumes every automation; refused in safe mode (`runtime-unavailable`). */
  orchestration_set_automations_paused_v7(request: SetAutomationsPausedRequest): Promise<AutomationsStateV7>;
}
