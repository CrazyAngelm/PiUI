import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrchestrationCatalogV6, OrchestrationRunV6, PipelineDefinition, RunSummary, StoredDefinition, TeamDefinition, UsageReceipt,
  WorkspaceCatalog, WorkspaceResult,
} from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost } from './labTestKit';
import type {
  PinStepOutputResultV1, RunOutputsResultV1, SetRunArchivedResultV1,
} from '../../../../../contracts/orchestration-run-debugging-v1';

/**
 * Run debugging v1 in the UI Lab: pinning a finished step's output, a run
 * with pinned data (no session for the pinned step, downstream receives its
 * output), archive and delete with the host's refusals.
 */
function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
  return host.invoke<T>(route, { request });
}

/** The rejection value, so a refusal's exact shape can be compared. */
function caught(error: unknown): unknown {
  return error;
}

async function getRun(host: LabHost, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  const run = await call<OrchestrationRunV6 | null>(host, 'orchestration_get_run_v6', { workspaceId, runId });
  if (run === null) throw new Error('Run not found.');
  return run;
}

async function settle(host: LabHost, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  for (let second = 0; second < 240; second += 1) {
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
}

async function release(host: LabHost): Promise<Release> {
  const workspaceId = projectId(host, 'piui');
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const id = (items: readonly { name: string; id: string }[]) => items.find((item) => item.name === 'Release check')?.id;
  const team = await call<StoredDefinition<TeamDefinition> | null>(host, 'orchestration_get_team_v6', { workspaceId, id: id(catalog.teams) });
  const pipeline = await call<StoredDefinition<PipelineDefinition> | null>(host, 'orchestration_get_pipeline_v6', {
    workspaceId, id: id(catalog.pipelines),
  });
  if (team === null || pipeline === null) throw new Error('No Release check system.');
  return { workspaceId, team: team.value, pipeline };
}

function start(host: LabHost, system: Release, runId: string, usePinnedData = false): Promise<OrchestrationRunV6> {
  return call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
    workspaceId: system.workspaceId, runId, teamId: system.team.id, pipelineId: system.pipeline.value.id,
    ...(usePinnedData ? { usePinnedData } : {}),
  });
}

async function sessionIds(host: LabHost): Promise<Set<string>> {
  const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
  const catalog: WorkspaceCatalog | undefined = result.type === 'catalog' ? result.catalog : undefined;
  return new Set(catalog?.sessions.map((session) => session.id));
}

describe('UI Lab run debugging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins a finished step, then a run with pinned data skips it and passes its output on', async () => {
    const host = labHost();
    const system = await release(host);
    const [scout, metrics, note] = system.pipeline.value.steps.map((step) => step.id) as [string, string, string];
    const first = labUuid('test:pin-source');
    await start(host, system, first);
    const finished = await settle(host, system.workspaceId, first);
    expect(finished.status).toBe('succeeded');

    const outputs = await call<RunOutputsResultV1>(host, 'orchestration_run_outputs_v1', { workspaceId: system.workspaceId, runId: first });
    const scoutOutput = outputs.outputs.find((item) => item.stepId === scout);
    expect(scoutOutput?.text?.length).toBeGreaterThan(0);
    expect(outputs.outputs.find((item) => item.stepId === metrics)?.data).toBeDefined();

    const pinned = await call<PinStepOutputResultV1>(host, 'orchestration_pin_step_output_v1', {
      workspaceId: system.workspaceId, runId: first, stepId: scout, pipelineId: system.pipeline.value.id,
      expectedRevision: system.pipeline.revision,
    });
    expect(pinned.revision).toBe(system.pipeline.revision + 1);
    expect(pinned.pinnedOutput).toMatchObject({ text: scoutOutput?.text, sourceRunId: first });
    expect(pinned.pinnedOutput.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // A stale revision is refused and changes nothing.
    await expect(call(host, 'orchestration_pin_step_output_v1', {
      workspaceId: system.workspaceId, runId: first, stepId: scout, pipelineId: system.pipeline.value.id,
      expectedRevision: system.pipeline.revision,
    }).catch(caught)).resolves.toEqual({ code: 'conflict' });

    const second = labUuid('test:pinned-run');
    const started = await start(host, system, second, true);
    expect(started.usePinnedData).toBe(true);
    const scoutTask = started.tasks.find((task) => task.stepId === scout);
    expect(scoutTask).toMatchObject({ status: 'succeeded', pinned: true, output: { text: scoutOutput?.text } });
    expect(scoutTask?.execution).toBeUndefined();
    const run = await settle(host, system.workspaceId, second);
    expect(run.status).toBe('succeeded');
    const task = (id: string) => run.tasks.find((item) => item.stepId === id);
    // The script received the pinned text as its dependency.
    expect(task(metrics)?.resultData).toMatchObject({ dependencies: [scout] });
    expect(task(metrics)?.resultData?.characters).toBe(scoutOutput?.text?.length);
    // Only the model call opened a session: the pinned agent never ran.
    const usage = await call<Record<string, UsageReceipt[]>>(host, 'orchestration_run_usage_v6', { workspaceId: system.workspaceId, runId: second });
    expect(Object.keys(usage)).toEqual([task(note)?.execution?.id]);

    // Without the option the same pipeline runs every step and freezes no pins.
    const plain = await start(host, system, labUuid('test:plain-run'));
    expect(plain.usePinnedData).toBeUndefined();
    expect(plain.definition.pipeline.steps.every((step) => step.pinnedOutput === undefined)).toBe(true);
    expect(plain.tasks.find((item) => item.stepId === scout)?.status).toBe('running');
  });

  it('refuses a run with pinned data when nothing is pinned', async () => {
    const host = labHost();
    const system = await release(host);
    await expect(start(host, system, labUuid('test:no-pins'), true).catch(caught)).resolves.toEqual({ code: 'conflict' });
  });

  it('archives finished runs and deletes only their PiUI record', async () => {
    const host = labHost();
    const system = await release(host);
    const running = labUuid('test:active');
    const active = await start(host, system, running);
    expect(active.status).toBe('running');
    const request = (runId: string, archived: boolean) => ({ workspaceId: system.workspaceId, runId, archived });
    await expect(call(host, 'orchestration_set_run_archived_v1', request(running, true)).catch(caught)).resolves.toEqual({ code: 'run-active' });
    await expect(call(host, 'orchestration_delete_run_v1', {
      workspaceId: system.workspaceId, runId: running, expectedRunRevision: active.revision,
    }).catch(caught)).resolves.toEqual({ code: 'run-active' });

    const done = await settle(host, system.workspaceId, running);
    const archived = await call<SetRunArchivedResultV1>(host, 'orchestration_set_run_archived_v1', request(running, true));
    expect(archived).toEqual({ protocol: 1, runId: running, archived: true });
    const listed = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: system.workspaceId });
    expect(listed.find((item) => item.id === running)?.archived).toBe(true);
    expect((await getRun(host, system.workspaceId, running)).revision).toBe(done.revision);

    const before = await sessionIds(host);
    const linked = done.tasks.flatMap((task) => (task.execution ? [task.execution.id] : [])).filter((id) => before.has(id));
    expect(linked.length).toBeGreaterThan(0);
    await expect(call(host, 'orchestration_delete_run_v1', {
      workspaceId: system.workspaceId, runId: running, expectedRunRevision: done.revision - 1,
    }).catch(caught)).resolves.toEqual({ code: 'conflict' });
    await expect(call(host, 'orchestration_delete_run_v1', {
      workspaceId: system.workspaceId, runId: running, expectedRunRevision: done.revision,
    })).resolves.toEqual({ protocol: 1, runId: running });
    expect(await call(host, 'orchestration_get_run_v6', { workspaceId: system.workspaceId, runId: running })).toBeNull();
    const after = await sessionIds(host);
    expect(linked.every((id) => after.has(id))).toBe(true);
    const relisted = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: system.workspaceId });
    expect(relisted.some((item) => item.id === running)).toBe(false);
  });

  it('keeps runs read-only in safe mode', async () => {
    const host = labHost('safe');
    const workspaceId = host.state.projects[0]?.id ?? '';
    for (const [route, request] of [
      ['orchestration_set_run_archived_v1', { workspaceId, runId: 'run', archived: true }],
      ['orchestration_delete_run_v1', { workspaceId, runId: 'run', expectedRunRevision: 0 }],
      ['orchestration_pin_step_output_v1', { workspaceId, runId: 'run', stepId: 'step', pipelineId: 'pipeline', expectedRevision: 0 }],
    ] as const) {
      await expect(call(host, route, request).catch(caught)).resolves.toEqual({ code: 'safe-mode' });
    }
  });

  it('decodes requests like the host: unknown fields are refused', async () => {
    const host = labHost();
    const system = await release(host);
    await expect(call(host, 'orchestration_run_outputs_v1', { workspaceId: system.workspaceId, runId: 'x', path: 'C:/' }).catch(caught))
      .resolves.toMatch(/unknown field `path`/);
    await expect(call(host, 'orchestration_run_outputs_v1', { workspaceId: system.workspaceId, runId: 'missing' }).catch(caught))
      .resolves.toEqual({ code: 'not-found' });
  });
});
