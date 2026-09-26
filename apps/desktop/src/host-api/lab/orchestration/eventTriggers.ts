import type { LabClock } from '../labClock';
import { labIso } from '../labClock';
import {
  EVENT_COOLDOWN_SECONDS, MAX_TRIGGER_CHAIN_DEPTH,
  type FinishedOutcome, type RunStatus, type RunTrigger, type ScheduleOccurrence,
} from '../labContracts';
import type { LabOrchestrationWorkspace, LabSchedule, LabState } from '../labState';
import { sha256Hex } from '../sha256';
import { resolveRunInputs } from '../../runInputs';
import { newRun, type LabRun } from './runEngine';

/** Recorded outcomes kept per automation (`MAX_STORED_OCCURRENCES`). */
const MAX_STORED_OCCURRENCES = 200;

function active(status: RunStatus): boolean {
  return status === 'running' || status === 'uncertain';
}

function finishedOutcome(status: RunStatus): FinishedOutcome | undefined {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' ? status : undefined;
}

function chainDepth(run: LabRun): number {
  return run.trigger?.kind === 'event' ? run.trigger.chainDepth : 0;
}

/** `trigger_label`: one line, at most 256 bytes. */
function triggerLabel(name: string): string {
  let label = [...name.trim()].map((character) => (/\p{Cc}/u.test(character) ? ' ' : character)).join('');
  while (new TextEncoder().encode(label).length > 256) label = [...label].slice(0, -1).join('');
  return label.trimEnd();
}

/**
 * The lab counterpart of the host's event automations
 * (`orchestration_triggers.rs` and `claim_event_occurrence`). A run that
 * ends fires every enabled "pipeline finished" rule watching its launch
 * command and outcome; each firing is recorded with the same outcomes and
 * loop protection as the host: pause, chain depth limit, launch-command
 * change, admission, cooldown, then overlap. The lab has no project folders,
 * so "files changed" rules are saved and validated but never fire here.
 */
export class LabEventTriggers {
  private readonly known = new Map<string, RunStatus>();

  constructor(
    private readonly state: LabState,
    private readonly clock: LabClock,
    private readonly admits: (workspaceId: string) => boolean,
    private readonly start: (workspaceId: string, run: LabRun) => void,
    private readonly changed: (workspaceId: string, schedule: LabSchedule) => void,
  ) {
    // Runs that exist already ended (or will end) without this observer.
    for (const [workspaceId, workspace] of state.orchestration) {
      for (const run of workspace.runs) this.known.set(`${workspaceId}\u0000${run.id}`, run.status);
    }
  }

  /** Called after every committed run change (`runChanged`). */
  observe(workspaceId: string, run: LabRun): void {
    const key = `${workspaceId}\u0000${run.id}`;
    const previous = this.known.get(key);
    this.known.set(key, run.status);
    const outcome = finishedOutcome(run.status);
    if (outcome === undefined || (previous !== undefined && !active(previous))) return;
    const workspace = this.state.orchestration.get(workspaceId);
    const source = run.definition.launchCommand?.id;
    if (workspace === undefined || source === undefined) return;
    for (const schedule of workspace.schedules) {
      const trigger = schedule.value.trigger;
      if (!schedule.enabled || trigger.type !== 'event' || trigger.event.kind !== 'run-finished') continue;
      if (trigger.event.launchCommandId !== source || !trigger.event.outcomes.includes(outcome)) continue;
      this.claim(workspaceId, workspace, schedule, run, chainDepth(run) + 1);
    }
  }

  private claim(workspaceId: string, workspace: LabOrchestrationWorkspace, schedule: LabSchedule, source: LabRun, depth: number): void {
    const id = `event-${sha256Hex(`${schedule.value.id}\u0000${schedule.triggerRevision}\u0000run:${source.id}`)}`;
    if (schedule.occurrences.some((occurrence) => occurrence.id === id) || workspace.runs.some((run) => run.id === id)) return;
    const now = this.clock.now();
    const occurrence: ScheduleOccurrence = {
      id, nominalAt: labIso(now), recordedAt: labIso(now), outcome: 'failed', sourceRunId: source.id, chainDepth: depth,
    };
    const record = (value: ScheduleOccurrence): void => {
      schedule.revision += 1;
      schedule.occurrences.push(value);
      while (schedule.occurrences.length > MAX_STORED_OCCURRENCES) {
        const index = schedule.occurrences.findIndex((item) =>
          item.runId === undefined || !workspace.runs.some((run) => run.id === item.runId && active(run.status)));
        if (index < 0) break;
        schedule.occurrences.splice(index, 1);
      }
      this.changed(workspaceId, schedule);
    };
    const command = workspace.launchCommands.find((item) => item.value.id === schedule.value.launchCommandId);
    const started = [...schedule.occurrences].reverse().find((item) => item.outcome === 'started');
    const cooling = started !== undefined && now < Date.parse(started.recordedAt) + EVENT_COOLDOWN_SECONDS * 1_000;
    const overlapping = schedule.value.overlapPolicy === 'skip'
      && schedule.occurrences.some((item) => item.runId !== undefined && workspace.runs.some((run) => run.id === item.runId && active(run.status)));
    if (this.state.automationsPaused === true) {
      record({ ...occurrence, outcome: 'skippedPaused' });
      return;
    }
    if (depth > MAX_TRIGGER_CHAIN_DEPTH) {
      record({ ...occurrence, outcome: 'skippedChainLimit' });
      return;
    }
    if (schedule.enabledLaunchCommandRevision !== (command?.revision ?? null)) {
      schedule.enabled = false;
      schedule.enabledLaunchCommandRevision = null;
      record({ ...occurrence, failureCode: 'launch-command-changed' });
      return;
    }
    if (!this.admits(workspaceId)) {
      record({ ...occurrence, failureCode: 'runtime-unavailable' });
      return;
    }
    if (cooling) {
      record({ ...occurrence, outcome: 'skippedCooldown' });
      return;
    }
    if (overlapping) {
      record({ ...occurrence, outcome: 'skippedOverlap' });
      return;
    }
    const team = workspace.teams.find((item) => item.value.id === command?.value.teamId)?.value;
    const pipeline = workspace.pipelines.find((item) => item.value.id === command?.value.pipelineId)?.value;
    const inputs = pipeline === undefined ? undefined : resolveRunInputs(pipeline.inputs, schedule.value.inputs);
    if (command === undefined || team === undefined || pipeline === undefined || inputs?.ok !== true) {
      record({ ...occurrence, failureCode: command === undefined ? 'not-found' : 'invalid' });
      return;
    }
    const trigger: RunTrigger = {
      kind: 'event', scheduleId: schedule.value.id, scheduleName: triggerLabel(schedule.value.name), occurrenceId: id,
      event: 'run-finished', sourceRunId: source.id, chainDepth: depth,
    };
    const definition = structuredClone({
      profiles: workspace.profiles.map((stored) => stored.value), team, pipeline, launchCommand: command.value,
    });
    const run = newRun(id, definition, inputs.values, trigger);
    workspace.runs.push(run);
    record({ ...occurrence, outcome: 'started', runId: id });
    this.known.set(`${workspaceId}\u0000${id}`, run.status);
    this.start(workspaceId, run);
  }
}
