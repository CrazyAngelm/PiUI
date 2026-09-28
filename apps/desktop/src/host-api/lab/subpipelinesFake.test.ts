import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LaunchCommandReference, OrchestrationCatalogV6, OrchestrationRunV6, PipelineDefinition, PipelineStep, StoredDefinition,
  TeamDefinition,
} from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, rejection } from './labTestKit';
import { MAX_SUBPIPELINE_DEPTH, SUBPIPELINE_FAILURE_CODES } from '../subpipelines';
import { RELEASE_METRICS_SOURCE } from './scenarios/demoSystems';

/**
 * Sub-pipelines in the UI Lab host (orchestration v6.7, ADR-042): a step
 * starts an ordinary child run of a saved launch command, ends with it,
 * cancels it with the parent and is refused for cycles and depth.
 */
function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
  return host.invoke<T>(route, { request });
}

function projectId(host: LabHost): string {
  const project = host.state.projects.find((candidate) => candidate.name === 'piui');
  if (project === undefined) throw new Error('No piui project');
  return project.id;
}

async function getRun(host: LabHost, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  const run = await call<OrchestrationRunV6 | null>(host, 'orchestration_get_run_v6', { workspaceId, runId });
  if (run === null) throw new Error('Run not found.');
  return run;
}

async function settle(host: LabHost, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  for (let second = 0; second < 600; second += 1) {
    const run = await getRun(host, workspaceId, runId);
    if (run.status !== 'running') return run;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  throw new Error('The run did not settle.');
}

interface Release {
  workspaceId: string;
  team: TeamDefinition;
  pipeline: StoredDefinition<PipelineDefinition>;
  command: LaunchCommandReference;
}

async function release(host: LabHost): Promise<Release> {
  const workspaceId = projectId(host);
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const id = (items: readonly { name: string; id: string }[]) => items.find((item) => item.name === 'Release check')?.id;
  const team = await call<StoredDefinition<TeamDefinition> | null>(host, 'orchestration_get_team_v6', { workspaceId, id: id(catalog.teams) });
  const pipeline = await call<StoredDefinition<PipelineDefinition> | null>(host, 'orchestration_get_pipeline_v6', { workspaceId, id: id(catalog.pipelines) });
  const command = await call<StoredDefinition<LaunchCommandReference> | null>(host, 'orchestration_get_launch_command_v6', {
    workspaceId, id: id(catalog.launchCommands),
  });
  if (team === null || pipeline === null || command === null) throw new Error('No Release check system.');
  return { workspaceId, team: team.value, pipeline, command: command.value };
}

/** Saves a new version of the Release check pipeline. */
async function saveRelease(host: LabHost, system: Release, change: (pipeline: PipelineDefinition) => PipelineDefinition): Promise<Release> {
  const saved = await call<StoredDefinition<PipelineDefinition>>(host, 'orchestration_save_pipeline_v6', {
    workspaceId: system.workspaceId, expectedRevision: system.pipeline.revision, value: change(system.pipeline.value),
  });
  return { ...system, pipeline: saved };
}

const metricsId = (system: Release): string => system.pipeline.value.steps[1]?.id ?? '';

function subpipelineStep(launchCommandId: string, patch: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: 'call', name: 'Release check', assignedMemberId: 'call', instructions: '', dependencyStepIds: [],
    executor: { type: 'pipeline', launchCommandId, inputs: {} }, ...patch,
  };
}

/** A new pipeline and launch command on the Release check team whose only step is `step`. */
async function parent(host: LabHost, system: Release, name: string, step: PipelineStep): Promise<LaunchCommandReference> {
  const pipeline: PipelineDefinition = { id: labUuid(`test:pipeline:${name}`), name, steps: [step] };
  await call(host, 'orchestration_save_pipeline_v6', { workspaceId: system.workspaceId, value: pipeline });
  const command: LaunchCommandReference = { id: labUuid(`test:command:${name}`), name, teamId: system.team.id, pipelineId: pipeline.id };
  await call(host, 'orchestration_save_launch_command_v6', { workspaceId: system.workspaceId, value: command });
  return command;
}

function start(host: LabHost, system: Release, command: LaunchCommandReference, runId: string): Promise<OrchestrationRunV6> {
  return call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
    workspaceId: system.workspaceId, runId, teamId: command.teamId, pipelineId: command.pipelineId, launchCommandId: command.id,
  });
}

describe('UI Lab sub-pipelines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a child run and records its declared outputs as the step result', async () => {
    const host = labHost();
    let system = await release(host);
    system = await saveRelease(host, system, (pipeline) => ({
      ...pipeline,
      outputs: [{ name: 'characters', kind: 'number', sourceStepId: metricsId(system), field: 'characters' }],
    }));
    const command = await parent(host, system, 'Ship', subpipelineStep(system.command.id, {
      executor: { type: 'pipeline', launchCommandId: system.command.id, inputs: { since: { kind: 'value', value: 'yesterday' } } },
      resultFields: [{ name: 'characters', kind: 'number' }],
    }));
    const runId = labUuid('test:ship');
    await start(host, system, command, runId);
    const run = await settle(host, system.workspaceId, runId);
    expect(run.status).toBe('succeeded');
    const task = run.tasks.find((item) => item.stepId === 'call');
    expect(task?.resultData?.characters).toBeTypeOf('number');
    expect(task?.resultReference).toBeUndefined();

    // The execution id is the child run: an ordinary run with the pipeline trigger.
    const child = await getRun(host, system.workspaceId, task?.execution?.id ?? '');
    expect(child.status).toBe('succeeded');
    expect(child.trigger).toEqual({ kind: 'pipeline', parentRunId: runId, parentStepId: 'call', launchCommandId: system.command.id, depth: 1 });
    expect(child.inputs).toEqual({ since: 'yesterday' });
    expect(child.definition.launchCommand?.id).toBe(system.command.id);
    expect(child.usePinnedData).toBeUndefined();
  });

  it('records the last step text without outputs and fails with a failed child', async () => {
    const host = labHost();
    const system = await release(host);
    const command = await parent(host, system, 'Ship text', subpipelineStep(system.command.id));
    const runId = labUuid('test:ship-text');
    await start(host, system, command, runId);
    const run = await settle(host, system.workspaceId, runId);
    expect(run.status).toBe('succeeded');
    expect(run.tasks[0]?.output?.text).toMatch(/^Release note: /);

    const failing = await saveRelease(host, system, (pipeline) => ({
      ...pipeline,
      steps: pipeline.steps.map((step) => (step.executor?.type === 'script' ? { ...step, executor: { ...step.executor, source: `// lab:fail\n${RELEASE_METRICS_SOURCE}` } } : step)),
    }));
    const failedId = labUuid('test:ship-failed');
    await start(host, failing, command, failedId);
    const failed = await settle(host, system.workspaceId, failedId);
    expect(failed.status).toBe('failed');
    expect(failed.tasks[0]?.failure).toEqual({ code: SUBPIPELINE_FAILURE_CODES.failed });
    const child = await getRun(host, system.workspaceId, failed.tasks[0]?.execution?.id ?? '');
    expect(child.status).toBe('failed');
  });

  it('cancels the child run first when the parent run is cancelled', async () => {
    const host = labHost();
    const system = await release(host);
    const command = await parent(host, system, 'Ship cancel', subpipelineStep(system.command.id));
    const runId = labUuid('test:ship-cancel');
    const started = await start(host, system, command, runId);
    const childId = started.tasks[0]?.execution?.id ?? '';
    expect(started.tasks[0]?.status).toBe('running');
    expect((await getRun(host, system.workspaceId, childId)).status).toBe('running');

    const current = await getRun(host, system.workspaceId, runId);
    const cancelled = await call<OrchestrationRunV6>(host, 'orchestration_cancel_run_v6', {
      workspaceId: system.workspaceId, runId, expectedRunRevision: current.revision,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks[0]?.status).toBe('cancelled');
    const child = await getRun(host, system.workspaceId, childId);
    expect(child.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await getRun(host, system.workspaceId, runId)).status).toBe('cancelled');
  });

  it('fails the parent step with subpipeline-cancelled when the child run is cancelled', async () => {
    const host = labHost();
    const system = await release(host);
    const command = await parent(host, system, 'Ship child cancel', subpipelineStep(system.command.id));
    const runId = labUuid('test:ship-child-cancel');
    const started = await start(host, system, command, runId);
    const childId = started.tasks[0]?.execution?.id ?? '';
    const child = await getRun(host, system.workspaceId, childId);
    await call(host, 'orchestration_cancel_run_v6', { workspaceId: system.workspaceId, runId: childId, expectedRunRevision: child.revision });
    const run = await getRun(host, system.workspaceId, runId);
    expect(run.status).toBe('failed');
    expect(run.tasks[0]?.failure).toEqual({ code: SUBPIPELINE_FAILURE_CODES.cancelled });
  });

  it('refuses a child deeper than the maximum depth', async () => {
    const host = labHost();
    const system = await release(host);
    // Level k runs level k+1; the deepest runs the Release check.
    let next = system.command;
    const levels: LaunchCommandReference[] = [];
    for (let level = MAX_SUBPIPELINE_DEPTH + 1; level >= 1; level -= 1) {
      next = await parent(host, system, `Level ${level}`, subpipelineStep(next.id));
      levels.unshift(next);
    }
    const runId = labUuid('test:deep');
    await start(host, system, levels[0] as LaunchCommandReference, runId);
    const run = await settle(host, system.workspaceId, runId);
    expect(run.status).toBe('failed');
    const runs = host.state.orchestration.get(system.workspaceId)?.runs ?? [];
    const deepest = runs.find((item) => item.trigger?.kind === 'pipeline' && item.trigger.depth === MAX_SUBPIPELINE_DEPTH);
    expect(deepest?.tasks[0]?.failure).toEqual({ code: SUBPIPELINE_FAILURE_CODES.depth });
    expect(runs.some((item) => item.trigger?.kind === 'pipeline' && item.trigger.depth > MAX_SUBPIPELINE_DEPTH)).toBe(false);
  });

  it('refuses saves with a missing launch command, a bad mapping or a cycle, and keeps referenced commands', async () => {
    const host = labHost();
    const system = await release(host);
    const missing: PipelineDefinition = { id: labUuid('test:missing'), name: 'Missing', steps: [subpipelineStep('no-such-command')] };
    expect(await rejection(call(host, 'orchestration_save_pipeline_v6', { workspaceId: system.workspaceId, value: missing }))).toMatchObject({ code: 'invalid' });

    const unknownInput: PipelineDefinition = {
      id: labUuid('test:unknown'), name: 'Unknown input',
      steps: [subpipelineStep(system.command.id, { executor: { type: 'pipeline', launchCommandId: system.command.id, inputs: { nope: { kind: 'value', value: 'x' } } } })],
    };
    expect(await rejection(call(host, 'orchestration_save_pipeline_v6', { workspaceId: system.workspaceId, value: unknownInput }))).toMatchObject({ code: 'invalid' });

    const command = await parent(host, system, 'Outer', subpipelineStep(system.command.id));
    // Release check running Outer would run itself again.
    const cycle = await rejection(saveRelease(host, system, (pipeline) => ({
      ...pipeline,
      steps: [...pipeline.steps, subpipelineStep(command.id, { id: 'loop', assignedMemberId: 'loop', dependencyStepIds: [pipeline.steps[2]?.id ?? ''] })],
    })));
    expect(cycle).toMatchObject({ code: 'invalid' });

    expect(await rejection(call(host, 'orchestration_delete_launch_command_v6', {
      workspaceId: system.workspaceId, id: system.command.id, expectedRevision: 0,
    }))).toMatchObject({ code: 'conflict' });
  });
});
