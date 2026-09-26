/** Calendar schedule extension for the PiUI orchestration host.
 *
 * v6 run and definition commands remain available unchanged. Schedule writes
 * are a distinct v7 contract because saving a definition is not execution
 * authorization. Newly created and execution-affecting edited schedules are
 * disabled until an explicit revision-bound enable request.
 */

import type {
  OrchestrationHostCommandsV6,
  WorkspaceRequest,
} from './orchestration-host-v6';
import type { Revision, RunInputValue } from './orchestration-v6';

export * from './orchestration-host-v6';

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
    };

export type MissedRunPolicy = 'skip' | 'coalesce';
export type OverlapPolicy = 'allow' | 'skip';
export type ScheduleOccurrenceOutcome = 'started' | 'skippedMissed' | 'skippedOverlap' | 'failed';

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

export const ORCHESTRATION_SCHEDULE_EVENT_V7 = 'piui://orchestration-schedule-event' as const;

export interface OrchestrationScheduleChangedEventV7 {
  readonly protocol: 7;
  readonly type: 'scheduleChanged';
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly revision: Revision;
}

export interface OrchestrationHostCommandsV7 extends OrchestrationHostCommandsV6 {
  orchestration_list_schedules_v7(request: WorkspaceRequest): Promise<readonly ScheduleSnapshot[]>;
  orchestration_save_schedule_v7(request: SaveScheduleRequest): Promise<ScheduleSnapshot>;
  orchestration_set_schedule_enabled_v7(request: SetScheduleEnabledRequest): Promise<ScheduleSnapshot>;
  orchestration_delete_schedule_v7(request: ScheduleMutationRequest): Promise<void>;
}
