import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrchestrationCatalogV6, OrchestrationRunV6, PipelineDefinition, StoredDefinition, TeamDefinition, UsageReceipt,
  WorkspaceCatalog, WorkspaceResult,
} from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, rejection } from './labTestKit';
import { newRun, restoreInterrupted, completeScript, dispatchTask, leaseTask, type LabRun } from './orchestration/runEngine';
import { RELEASE_METRICS_SOURCE } from './scenarios/demoSystems';

/**
 * Step executors in the UI Lab host (orchestration v6.2): the seeded Release
 * check runs an agent, a host script (deterministic fake) and a single model
 * call with the host's statuses, failure codes and dependency hand-off.
 */
function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
  return host.invoke<T>(route, { request });
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

/** Saves the Release check pipeline with its script step's source replaced. */
async function withScript(host: LabHost, system: Release, source: string): Promise<Release> {
  const value: PipelineDefinition = {
    ...system.pipeline.value,
    steps: system.pipeline.value.steps.map((step) => (step.executor?.type === 'script'
      ? { ...step, executor: { ...step.executor, source } }
      : step)),
  };
  const saved = await call<StoredDefinition<PipelineDefinition>>(host, 'orchestration_save_pipeline_v6', {
    workspaceId: system.workspaceId, expectedRevision: system.pipeline.revision, value,
  });
  return { ...system, pipeline: saved };
}

function start(host: LabHost, system: Release, runId: string): Promise<OrchestrationRunV6> {
  return call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
    workspaceId: system.workspaceId, runId, teamId: system.team.id, pipelineId: system.pipeline.value.id,
  });
}

function stepIds(system: Release): { scout: string; metrics: string; note: string } {
  const [scout, metrics, note] = system.pipeline.value.steps.map((step) => step.id);
  return { scout: scout ?? '', metrics: metrics ?? '', note: note ?? '' };
}

describe('UI Lab step executors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs an agent, a host script and a single model call through the dependency path', async () => {
    const host = labHost();
    const system = await release(host);
    const ids = stepIds(system);
    const runId = labUuid('test:release');
    const started = await start(host, system, runId);
    expect(started.inputs).toEqual({ since: 'the last release' });
    const run = await settle(host, system.workspaceId, runId);
    expect(run.status).toBe('succeeded');
    const task = (id: string) => run.tasks.find((item) => item.stepId === id);

    // The script printed a JSON summary of its stdin: it became checked result data.
    expect(task(ids.metrics)?.resultData).toMatchObject({
      step: ids.metrics, inputs: ['since'], dependencies: [ids.scout],
    });
    expect(task(ids.metrics)?.resultData?.characters).toBeGreaterThan(0);
    expect(task(ids.metrics)?.output).toBeUndefined();
    expect(task(ids.metrics)?.resultReference).toBeUndefined();

    // A script execution is host work: no linked session and no usage.
    const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
    const catalog: WorkspaceCatalog | undefined = result.type === 'catalog' ? result.catalog : undefined;
    const sessionIds = new Set(catalog?.sessions.map((session) => session.id));
    expect(sessionIds.has(task(ids.metrics)?.execution?.id ?? '')).toBe(false);
    const usage = await call<Record<string, UsageReceipt[]>>(host, 'orchestration_run_usage_v6', { workspaceId: system.workspaceId, runId });
    expect(Object.keys(usage).sort()).toEqual([task(ids.scout)?.execution?.id, task(ids.note)?.execution?.id].sort());

    // The model call received both results and answered in one reply without tools.
    const note = host.state.sessions.get(task(ids.note)?.execution?.id ?? '');
    expect(note?.permissionMode).toBe('read-only');
    expect(note?.harness).toBe('pi');
    const prompt = note?.blocks.find((block) => block.kind === 'user')?.text ?? '';
    expect(prompt).toContain('--- dependency 1 ---\n{');
    expect(prompt).toContain(`--- dependency 2 ---\n${JSON.stringify(task(ids.metrics)?.resultData)}`);
    expect(prompt).toContain('This step is a single model call: answer in one reply');
    expect(note?.blocks.map((block) => block.kind)).toEqual(['user', 'assistant']);
    expect(note?.blocks.at(-1)?.text).toMatch(/^Release note: /);
  });

  it('records script failures, timeouts and text output with the host codes', async () => {
    const cases = [
      ['lab:fail', 'failed', { code: 'script-failed', detail: 'Error: the check failed (lab:fail)' }],
      ['lab:timeout', 'failed', { code: 'script-timeout', detail: 'still waiting (lab:timeout)' }],
    ] as const;
    for (const [marker, status, failure] of cases) {
      const host = labHost();
      const system = await withScript(host, await release(host), `// ${marker}\n${RELEASE_METRICS_SOURCE}`);
      const ids = stepIds(system);
      await start(host, system, labUuid(`test:${marker}`));
      const run = await settle(host, system.workspaceId, labUuid(`test:${marker}`));
      const metrics = run.tasks.find((item) => item.stepId === ids.metrics);
      expect(run.status).toBe(status);
      expect(metrics?.failure).toEqual(failure);
      expect(run.tasks.find((item) => item.stepId === ids.note)?.status).toBe('cancelled');
    }

    // Plain text is the recorded output; declared fields then fail like native results.
    const host = labHost();
    const system = await withScript(host, await release(host), `// lab:text\n${RELEASE_METRICS_SOURCE}`);
    await start(host, system, labUuid('test:text'));
    const run = await settle(host, system.workspaceId, labUuid('test:text'));
    expect(run.tasks.find((item) => item.stepId === stepIds(system).metrics)?.failure).toEqual({ code: 'result-invalid-json' });
  });

  it('fails a script whose interpreter is missing before anything runs', async () => {
    const host = labHost();
    host.state.missingScriptRuntimes = ['node'];
    const system = await release(host);
    const runId = labUuid('test:no-node');
    // The script becomes ready after the agent step; its admission then fails.
    await start(host, system, runId);
    const run = await settle(host, system.workspaceId, runId);
    const metrics = run.tasks.find((item) => item.stepId === stepIds(system).metrics);
    expect(metrics?.failure).toEqual({ code: 'script-runtime-unavailable' });
    expect(metrics?.execution).toBeUndefined();
    expect(run.status).toBe('failed');
  });

  it('cancels a running script and never replays it after a restart', async () => {
    const host = labHost();
    const system = await withScript(host, await release(host), `// lab:timeout\n${RELEASE_METRICS_SOURCE}`);
    const ids = stepIds(system);
    const runId = labUuid('test:cancel');
    await start(host, system, runId);
    let run = await getRun(host, system.workspaceId, runId);
    for (let second = 0; second < 120 && run.tasks.find((item) => item.stepId === ids.metrics)?.status !== 'running'; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      run = await getRun(host, system.workspaceId, runId);
    }
    expect(run.tasks.find((item) => item.stepId === ids.metrics)?.status).toBe('running');
    const cancelled = await call<OrchestrationRunV6>(host, 'orchestration_cancel_run_v6', {
      workspaceId: system.workspaceId, runId, expectedRunRevision: run.revision,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks.find((item) => item.stepId === ids.metrics)?.status).toBe('cancelled');
    // The stopped script never completes afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await getRun(host, system.workspaceId, runId)).status).toBe('cancelled');

    // A script that may have started is uncertain on restart, like native work.
    const lab: LabRun = newRun('restart', structuredClone(cancelled.definition));
    leaseTask(lab, ids.scout, 'scout');
    dispatchTask(lab, ids.scout, 'scout');
    lab.tasks[0]!.status = 'succeeded';
    leaseTask(lab, ids.metrics, 'script');
    dispatchTask(lab, ids.metrics, 'script');
    restoreInterrupted(lab);
    expect(lab.tasks.find((item) => item.stepId === ids.metrics)?.status).toBe('uncertain');
    expect(lab.status).toBe('uncertain');
    // Only a script completion may record it, and only for its execution.
    expect(() => completeScript(lab, ids.scout, 'scout', { status: 'exited', stdout: '{}' })).toThrow();
  });

  it('refuses executor definitions the host refuses', async () => {
    const host = labHost();
    const system = await release(host);
    const { workspaceId } = system;
    const save = (steps: PipelineDefinition['steps']) => call(host, 'orchestration_save_pipeline_v6', {
      workspaceId, expectedRevision: system.pipeline.revision, value: { ...system.pipeline.value, steps },
    });
    const [scout, metrics, note] = system.pipeline.value.steps;
    if (scout === undefined || metrics === undefined || note === undefined || metrics.executor?.type !== 'script') {
      throw new Error('Unexpected Release check shape.');
    }
    for (const broken of [
      { ...metrics, executor: { ...metrics.executor, source: '   ' } },
      { ...metrics, executor: { ...metrics.executor, timeoutSeconds: 0 } },
      { ...metrics, executor: { ...metrics.executor, timeoutSeconds: 3601 } },
      { ...metrics, executor: { ...metrics.executor, source: 'x'.repeat(64 * 1024 + 1) } },
      { ...metrics, executionMode: 'callable' as const, dependencyStepIds: [] },
    ]) {
      expect(await rejection(save([scout, broken, note]))).toMatchObject({ code: 'invalid' });
    }
    // An unknown runtime or executor field fails decoding like serde.
    expect(await rejection(save([scout, { ...metrics, executor: { ...metrics.executor, runtime: 'bash' as never } }, note])))
      .toMatch(/unknown variant string "bash", expected one of `node`, `python`, `powershell`/);
    expect(await rejection(save([scout, metrics, { ...note, executor: { type: 'llm', model: 'other' } as never }])))
      .toMatch(/unknown field `model`/);
    // A single model call joins no message route.
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
    const teamId = catalog.teams.find((item) => item.name === 'Release check')?.id;
    const team = await call<StoredDefinition<TeamDefinition>>(host, 'orchestration_get_team_v6', { workspaceId, id: teamId });
    await call(host, 'orchestration_save_team_v6', {
      workspaceId, expectedRevision: team.revision,
      value: { ...team.value, sendEdges: [{ fromMemberId: scout.assignedMemberId, toMemberId: note.assignedMemberId }] },
    });
    expect(await rejection(start(host, system, labUuid('test:routes')))).toMatchObject({ code: 'invalid' });
  });
});
