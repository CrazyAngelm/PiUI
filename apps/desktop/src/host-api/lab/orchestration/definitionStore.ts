import { labIso } from '../labClock';
import type {
  AgentProfile, DefinitionSummary, DeleteDefinitionRequest, LaunchCommandReference, PipelineDefinition,
  SaveDefinitionRequest, SaveGraphRequest, SaveScheduleRequest, ScheduleDefinition, ScheduleSnapshot,
  ScheduleTrigger, SetScheduleEnabledRequest, StoredDefinition, TeamDefinition,
} from '../labContracts';
import { orchestrationFailure } from '../labErrors';
import type { LabOrchestrationWorkspace, LabSchedule } from '../labState';
import {
  definitionIssue, launchCommandValid, normalizePipeline, normalizeProfile, normalizeTeam, pipelineValid, profileValid,
  spawnSubset, teamValid,
} from './definitionRules';

/**
 * Revision-checked definition storage (`save_definition`, `delete_definition`,
 * `save_graph` and the schedule mutations of `orchestration_api.rs`).
 */
export interface DefinitionKind<T extends { readonly id: string; readonly name: string }> {
  values(workspace: LabOrchestrationWorkspace): StoredDefinition<T>[];
  valid(value: T, workspace: LabOrchestrationWorkspace): boolean;
  canDelete(workspace: LabOrchestrationWorkspace, id: string): boolean;
  normalize(value: T): T;
  afterSave?(workspace: LabOrchestrationWorkspace, previous: StoredDefinition<T> | undefined, saved: StoredDefinition<T>): void;
}

export const PROFILES: DefinitionKind<AgentProfile> = {
  values: (workspace) => workspace.profiles,
  valid: profileValid,
  canDelete: (workspace, id) => !workspace.teams.some((team) => team.value.members.some((member) => member.profileId === id))
    && !workspace.profiles.some((profile) => profile.value.allowedSpawnProfileIds.includes(id)),
  normalize: normalizeProfile,
};

export const TEAMS: DefinitionKind<TeamDefinition> = {
  values: (workspace) => workspace.teams,
  valid: teamValid,
  canDelete: (workspace, id) => !workspace.launchCommands.some((command) => command.value.teamId === id),
  normalize: normalizeTeam,
};

export const PIPELINES: DefinitionKind<PipelineDefinition> = {
  values: (workspace) => workspace.pipelines,
  valid: pipelineValid,
  canDelete: (workspace, id) => !workspace.launchCommands.some((command) => command.value.pipelineId === id),
  normalize: normalizePipeline,
};

export const LAUNCH_COMMANDS: DefinitionKind<LaunchCommandReference> = {
  values: (workspace) => workspace.launchCommands,
  valid: launchCommandValid,
  canDelete: (workspace, id) => !workspace.schedules.some((schedule) => schedule.value.launchCommandId === id),
  normalize: (value) => value,
  afterSave: (workspace, previous, saved) => {
    if (previous === undefined) return;
    const changed = previous.value.teamId !== saved.value.teamId || previous.value.pipelineId !== saved.value.pipelineId;
    for (const schedule of workspace.schedules.filter((item) => item.value.launchCommandId === saved.value.id && item.enabled)) {
      if (changed) {
        // Changing what a schedule launches revokes its execution authorization.
        schedule.revision += 1;
        schedule.triggerRevision += 1;
        schedule.enabled = false;
        schedule.enabledLaunchCommandRevision = null;
        schedule.nextDueAt = initialDue(schedule.value.trigger);
      } else {
        schedule.enabledLaunchCommandRevision = saved.revision;
      }
    }
  },
};

/** Rust `String` ordering (code-unit order), not locale collation. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function summaries<T extends { readonly id: string; readonly name: string }>(
  values: readonly StoredDefinition<T>[],
): DefinitionSummary[] {
  return values
    .map((stored) => ({ id: stored.value.id, name: stored.value.name, revision: stored.revision }))
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
}

export function getDefinition<T extends { readonly id: string; readonly name: string }>(
  kind: DefinitionKind<T>,
  workspace: LabOrchestrationWorkspace | undefined,
  id: string,
): StoredDefinition<T> | null {
  if (id.trim() === '') throw orchestrationFailure('invalid');
  return workspace === undefined ? null : kind.values(workspace).find((stored) => stored.value.id === id) ?? null;
}

export function saveDefinition<T extends { readonly id: string; readonly name: string }>(
  kind: DefinitionKind<T>,
  workspace: LabOrchestrationWorkspace,
  request: SaveDefinitionRequest<T>,
): StoredDefinition<T> {
  const value = kind.normalize(request.value);
  if (!kind.valid(value, workspace)) throw orchestrationFailure('invalid');
  const values = kind.values(workspace);
  const index = values.findIndex((stored) => stored.value.id === value.id);
  const previous = index >= 0 ? values[index] : undefined;
  const expected = request.expectedRevision ?? undefined;
  let saved: StoredDefinition<T>;
  if (previous === undefined) {
    if (expected !== undefined) throw orchestrationFailure('not-found');
    saved = { revision: 0, value };
    values.push(saved);
  } else {
    if (expected === undefined) throw orchestrationFailure('already-exists');
    if (previous.revision !== expected) throw orchestrationFailure('conflict');
    saved = { revision: expected + 1, value };
    values[index] = saved;
  }
  kind.afterSave?.(workspace, previous, saved);
  return saved;
}

export function deleteDefinition<T extends { readonly id: string; readonly name: string }>(
  kind: DefinitionKind<T>,
  workspace: LabOrchestrationWorkspace | undefined,
  request: DeleteDefinitionRequest,
): void {
  if (workspace === undefined) throw orchestrationFailure('not-found');
  if (!kind.canDelete(workspace, request.id)) throw orchestrationFailure('conflict');
  const values = kind.values(workspace);
  const index = values.findIndex((stored) => stored.value.id === request.id);
  if (index < 0) throw orchestrationFailure('not-found');
  if (values[index]?.revision !== request.expectedRevision) throw orchestrationFailure('conflict');
  values.splice(index, 1);
}

/** `put_graph_definition`: new ids need no revision; existing ids need the current one. */
function putGraphDefinition<T extends { readonly id: string; readonly name: string }>(
  kind: DefinitionKind<T>,
  workspace: LabOrchestrationWorkspace,
  request: SaveDefinitionRequest<T>,
): void {
  if (request.workspaceId !== workspace.workspaceId) throw orchestrationFailure('invalid');
  const value = kind.normalize(request.value);
  const values = kind.values(workspace);
  const index = values.findIndex((stored) => stored.value.id === value.id);
  const previous = index >= 0 ? values[index] : undefined;
  const expected = request.expectedRevision ?? undefined;
  let saved: StoredDefinition<T>;
  if (previous === undefined && expected === undefined) {
    saved = { revision: 0, value };
    values.push(saved);
  } else if (previous !== undefined && expected !== undefined && previous.revision === expected) {
    saved = { revision: expected + 1, value };
    values[index] = saved;
  } else {
    throw orchestrationFailure('conflict');
  }
  kind.afterSave?.(workspace, previous, saved);
}

/**
 * `save_graph`: validates the whole system, applies every definition to a
 * draft and commits only if all of them succeed. Recorded runs are untouched.
 */
export function saveGraph(workspace: LabOrchestrationWorkspace, request: SaveGraphRequest): void {
  const profiles = request.profiles.map((entry) => entry.value);
  const snapshot = { profiles, team: request.team.value, pipeline: request.pipeline.value, launchCommand: request.command.value };
  if (definitionIssue(snapshot) !== undefined) throw orchestrationFailure('invalid');
  for (const parent of profiles) {
    for (const childId of parent.allowedSpawnProfileIds) {
      const child = profiles.find((profile) => profile.id === childId);
      if (child === undefined || !spawnSubset(parent, child)) throw orchestrationFailure('denied');
    }
  }
  const draft: LabOrchestrationWorkspace = {
    ...workspace,
    profiles: structuredClone(workspace.profiles),
    teams: structuredClone(workspace.teams),
    pipelines: structuredClone(workspace.pipelines),
    launchCommands: structuredClone(workspace.launchCommands),
    schedules: structuredClone(workspace.schedules),
  };
  for (const profile of request.profiles) putGraphDefinition(PROFILES, draft, profile);
  putGraphDefinition(TEAMS, draft, request.team);
  putGraphDefinition(PIPELINES, draft, request.pipeline);
  putGraphDefinition(LAUNCH_COMMANDS, draft, request.command);
  if (profiles.some((profile) => !profileValid(normalizeProfile(profile), draft))) throw orchestrationFailure('invalid');
  workspace.profiles = draft.profiles;
  workspace.teams = draft.teams;
  workspace.pipelines = draft.pipelines;
  workspace.launchCommands = draft.launchCommands;
  workspace.schedules = draft.schedules;
}

export function initialDue(trigger: ScheduleTrigger): string {
  return labIso(Date.parse(trigger.type === 'once' ? trigger.at : trigger.anchorAt));
}

/** chrono serializes instants without fractional seconds when they are whole. */
function normalizeSchedule(value: ScheduleDefinition): ScheduleDefinition {
  const trigger: ScheduleTrigger = value.trigger.type === 'once'
    ? { ...value.trigger, at: labIso(Date.parse(value.trigger.at)) }
    : { ...value.trigger, anchorAt: labIso(Date.parse(value.trigger.anchorAt)) };
  return { ...value, trigger };
}

function scheduleValid(value: ScheduleDefinition): boolean {
  const blank = (text: string): boolean => text.trim() === '';
  return !blank(value.id) && !blank(value.name) && !blank(value.launchCommandId) && !blank(value.trigger.timeZone)
    && (value.trigger.type === 'once' || value.trigger.every > 0);
}

function executionEquals(left: ScheduleDefinition, right: ScheduleDefinition): boolean {
  return left.launchCommandId === right.launchCommandId
    && JSON.stringify(left.trigger) === JSON.stringify(right.trigger)
    && left.missedRunPolicy === right.missedRunPolicy
    && left.overlapPolicy === right.overlapPolicy;
}

export function scheduleSnapshot(schedule: LabSchedule): ScheduleSnapshot {
  return {
    revision: schedule.revision,
    triggerRevision: schedule.triggerRevision,
    value: schedule.value,
    enabled: schedule.enabled,
    nextDueAt: schedule.nextDueAt,
    lastOccurrence: schedule.occurrences.at(-1) ?? null,
  };
}

export function listSchedules(workspace: LabOrchestrationWorkspace | undefined): ScheduleSnapshot[] {
  return (workspace?.schedules ?? [])
    .map(scheduleSnapshot)
    .sort((left, right) => compareText(left.value.name, right.value.name) || compareText(left.value.id, right.value.id));
}

export function saveSchedule(workspace: LabOrchestrationWorkspace | undefined, request: SaveScheduleRequest): ScheduleSnapshot {
  if (!scheduleValid(request.value)) throw orchestrationFailure('invalid');
  if (workspace === undefined) throw orchestrationFailure('not-found');
  const launches = workspace.launchCommands.some((command) => command.value.id === request.value.launchCommandId);
  if (!launches) throw orchestrationFailure('invalid');
  const value = normalizeSchedule(request.value);
  const index = workspace.schedules.findIndex((schedule) => schedule.value.id === value.id);
  const current = index >= 0 ? workspace.schedules[index] : undefined;
  const expected = request.expectedRevision ?? undefined;
  if (current === undefined) {
    if (expected !== undefined) throw orchestrationFailure('not-found');
    const created: LabSchedule = {
      revision: 0, triggerRevision: 0, value, enabled: false, enabledLaunchCommandRevision: null,
      nextDueAt: initialDue(value.trigger), occurrences: [],
    };
    workspace.schedules.push(created);
    return scheduleSnapshot(created);
  }
  if (expected === undefined) throw orchestrationFailure('already-exists');
  if (current.revision !== expected) throw orchestrationFailure('conflict');
  const updated: LabSchedule = { ...current, revision: current.revision + 1, value };
  if (!executionEquals(current.value, value)) {
    updated.triggerRevision += 1;
    updated.enabled = false;
    updated.enabledLaunchCommandRevision = null;
    updated.nextDueAt = initialDue(value.trigger);
  }
  workspace.schedules[index] = updated;
  return scheduleSnapshot(updated);
}

export function setScheduleEnabled(workspace: LabOrchestrationWorkspace | undefined, request: SetScheduleEnabledRequest): ScheduleSnapshot {
  if (workspace === undefined) throw orchestrationFailure('not-found');
  const schedule = workspace.schedules.find((item) => item.value.id === request.id);
  if (schedule === undefined) throw orchestrationFailure('not-found');
  if (schedule.revision !== request.expectedRevision) throw orchestrationFailure('conflict');
  const command = workspace.launchCommands.find((item) => item.value.id === schedule.value.launchCommandId
    && workspace.teams.some((team) => team.value.id === item.value.teamId)
    && workspace.pipelines.some((pipeline) => pipeline.value.id === item.value.pipelineId));
  if (request.enabled && (schedule.nextDueAt === null || command === undefined)) throw orchestrationFailure('invalid');
  const commandRevision = request.enabled ? command?.revision ?? null : null;
  if (schedule.enabled !== request.enabled || schedule.enabledLaunchCommandRevision !== commandRevision) {
    schedule.revision += 1;
    schedule.enabled = request.enabled;
    schedule.enabledLaunchCommandRevision = commandRevision;
  }
  return scheduleSnapshot(schedule);
}

export function deleteSchedule(workspace: LabOrchestrationWorkspace | undefined, id: string, expectedRevision: number): void {
  if (workspace === undefined) throw orchestrationFailure('not-found');
  const index = workspace.schedules.findIndex((schedule) => schedule.value.id === id);
  if (index < 0) throw orchestrationFailure('not-found');
  if (workspace.schedules[index]?.revision !== expectedRevision) throw orchestrationFailure('conflict');
  workspace.schedules.splice(index, 1);
}
