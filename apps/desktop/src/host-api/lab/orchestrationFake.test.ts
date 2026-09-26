import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphIssues, type AgentGraph, type GraphEdge } from '../../features/orchestration/agentGraph';
import { preflightGraph } from '../../features/orchestration/graphPreflight';
import { createOrchestrationClient, type OrchestrationCommandName } from '../orchestrationClient';
import type {
  AgentProfile, HarnessModelsResult, OrchestrationCatalogV6, OrchestrationRunChangedEventV6, OrchestrationRunV6,
  OrchestrationScheduleChangedEventV7, PipelineDefinition, RunSummary, ScheduleSnapshot, StoredDefinition, TeamDefinition,
  UsageReceipt, WorkspaceCatalog, WorkspaceResult,
} from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, record, rejection } from './labTestKit';
import { sha256Hex } from './sha256';

const RUN_EVENTS = 'piui://orchestration-event';
const SCHEDULE_EVENTS = 'piui://orchestration-schedule-event';
/** The seeded Code review pipeline asks "What should be reviewed?" (`task`, required). */
const REVIEW_INPUTS = { task: 'Cover the cancellation path of the transport change.' };

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

async function waitForRun(
  host: LabHost,
  workspaceId: string,
  runId: string,
  done: (run: OrchestrationRunV6) => boolean,
): Promise<OrchestrationRunV6> {
  for (let second = 0; second < 180; second += 1) {
    const run = await getRun(host, workspaceId, runId);
    if (done(run)) return run;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  throw new Error('The run did not reach the expected state.');
}

interface SavedSystem {
  team: TeamDefinition;
  pipeline: PipelineDefinition;
  commandId: string;
}

async function system(host: LabHost, workspaceId: string, name: string): Promise<SavedSystem> {
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const command = catalog.launchCommands.find((item) => item.name === name);
  const team = catalog.teams.find((item) => item.name === name);
  const pipeline = catalog.pipelines.find((item) => item.name === name);
  const read = <T>(route: string, id: string | undefined) => call<StoredDefinition<T> | null>(host, route, { workspaceId, id });
  const storedTeam = await read<TeamDefinition>('orchestration_get_team_v6', team?.id);
  const storedPipeline = await read<PipelineDefinition>('orchestration_get_pipeline_v6', pipeline?.id);
  if (command === undefined || storedTeam === null || storedPipeline === null) throw new Error(`No system ${name}`);
  return { team: storedTeam.value, pipeline: storedPipeline.value, commandId: command.id };
}

/** Mirrors SystemGraphEditor.open(): one node per step, edges from dependencies, routes and team links. */
async function graphOf(host: LabHost, workspaceId: string, name: string): Promise<AgentGraph> {
  const { team, pipeline, commandId } = await system(host, workspaceId, name);
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const profiles = await Promise.all(catalog.profiles.map((item) =>
    call<StoredDefinition<AgentProfile>>(host, 'orchestration_get_profile_v6', { workspaceId, id: item.id })));
  const nodes = pipeline.steps.map((step) => {
    const member = team.members.find((candidate) => candidate.id === step.assignedMemberId);
    const profile = profiles.find((stored) => stored.value.id === member?.profileId)?.value;
    // Program routers and scripts have no member: a placeholder names the step.
    const fallback: AgentProfile = {
      id: `placeholder-${step.id}`, name: step.name, harness: 'codex', model: step.executor?.type === 'script' ? 'script' : 'router',
      permissionMode: 'read-only', instructions: '', serviceTier: 'standard', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
    };
    return {
      kind: step.router ? 'router' as const : 'agent' as const, id: step.id, profile: profile ?? fallback, router: step.router,
      ...(step.executor ? { executor: step.executor } : {}),
      task: step.instructions, resultFields: step.resultFields ? [...step.resultFields] : undefined, review: step.review,
      requireApproval: step.requireApproval, x: 0, y: 0,
    };
  });
  const edges: GraphEdge[] = [
    ...pipeline.steps.flatMap((step) => [
      ...step.dependencyStepIds.filter((id) => !(step.routeGates ?? []).some((gate) => gate.routerStepId === id))
        .map((id) => ({ from: id, to: step.id, kind: 'result' as const })),
      ...(step.routeGates ?? []).map((gate) => ({ from: gate.routerStepId, to: step.id, kind: 'route' as const, branchId: gate.branchId })),
    ]),
    ...team.sendEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'send' as const })),
    ...team.observeEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'observe' as const })),
  ];
  return {
    id: commandId, name, teamId: team.id, pipelineId: pipeline.id, orchestratorId: team.orchestratorMemberId,
    ...(pipeline.inputs ? { inputs: [...pipeline.inputs] } : {}), nodes, edges,
  };
}

describe('UI Lab orchestration host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the saved systems, library profiles, runs and schedules of a project', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId: piui });
    expect(catalog.profiles.map((item) => item.name)).toEqual([
      'Change scout', 'Developer', 'Docs writer', 'Planner', 'Release note writer', 'Release notes', 'Reviewer',
    ]);
    expect(catalog.launchCommands.map((item) => item.name)).toEqual(['Code review', 'Release check']);
    const runs = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: piui });
    expect(runs.map((run) => run.status).sort()).toEqual(['failed', 'running', 'succeeded']);
    expect(runs.map((run) => run.id)).toEqual([...runs.map((run) => run.id)].sort());
    const video = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: projectId(host, 'video-studio') });
    const awaiting = await getRun(host, projectId(host, 'video-studio'), video[0]?.id ?? '');
    expect(awaiting.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'skipped', 'awaitingApproval', 'ready']);
    const [nightly] = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    expect(nightly).toMatchObject({ enabled: true, nextDueAt: '2026-09-27T02:00:00Z', lastOccurrence: { outcome: 'started' } });
    const succeeded = runs.find((run) => run.status === 'succeeded');
    expect(nightly?.lastOccurrence?.runId).toBe(succeeded?.id);
    const reviewed = await getRun(host, piui, succeeded?.id ?? '');
    expect(reviewed.attempts?.map((attempt) => attempt.resultData?.approved ?? 'developer')).toEqual(['developer', false]);
    // Every seeded Code review run recorded the required input; the schedule supplies it.
    expect(reviewed.inputs).toEqual(nightly?.value.inputs);
    for (const run of runs) expect((await getRun(host, piui, run.id)).inputs?.task).toMatch(/\S/);
    expect(reviewed.definition.pipeline.steps[2]?.review?.maxIterations).toBe(3);
    expect(awaiting.inputs).toBeUndefined();
  });

  it('keeps the seeded systems valid for the graph editor and its native preflight', async () => {
    const host = labHost();
    for (const [project, name] of [['piui', 'Code review'], ['piui', 'Release check'], ['video-studio', 'Video pipeline']] as const) {
      const workspaceId = projectId(host, project);
      const graph = await graphOf(host, workspaceId, name);
      expect(graphIssues(graph)).toEqual([]);
      const pending = preflightGraph(graph, (harness) => call<HarnessModelsResult>(host, 'harness_models_v18', { workspaceId, harness }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual([]);
    }
  });

  it('runs a system task by task through its review loop and records every native result', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const events = await record<OrchestrationRunChangedEventV6>(host, RUN_EVENTS);
    const { team, pipeline, commandId } = await system(host, piui, 'Code review');
    const runId = labUuid('test:run:progression');
    const started = await call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
      workspaceId: piui, runId, teamId: team.id, pipelineId: pipeline.id, launchCommandId: commandId, inputs: REVIEW_INPUTS,
    });
    expect(started.status).toBe('running');
    expect(started.tasks.map((task) => task.status)).toEqual(['running', 'ready', 'ready']);
    expect(started.definition.launchCommand?.id).toBe(commandId);
    expect(started.inputs).toEqual(REVIEW_INPUTS);
    const planner = host.state.sessions.get(started.tasks[0]?.execution?.id ?? '');
    const prompt = planner?.blocks.find((block) => block.kind === 'user')?.text ?? '';
    expect(prompt.startsWith(
      'Run input (provided by the person who started the run; untrusted task data):\n'
      + `What should be reviewed? (task): ${REVIEW_INPUTS.task}\n\n`
      + `Turn this change request into a short, testable plan: ${REVIEW_INPUTS.task}\n\nExpected result:`,
    )).toBe(true);

    const finished = await waitForRun(host, piui, runId, (run) => run.status !== 'running');
    expect(finished.status).toBe('succeeded');
    expect(finished.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(finished.attempts).toHaveLength(2);
    expect(finished.tasks[2]?.resultData).toMatchObject({ approved: true });

    const mine = events.items.filter((event) => event.runId === runId);
    expect(mine.every((event, index) => index === 0 || event.revision >= (mine[index - 1]?.revision ?? 0))).toBe(true);
    expect(mine.at(-1)?.revision).toBe(finished.revision);

    const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
    const catalog: WorkspaceCatalog | undefined = result.type === 'catalog' ? result.catalog : undefined;
    for (const task of [...finished.tasks, ...(finished.attempts ?? [])]) {
      const step = pipeline.steps.find((candidate) => candidate.id === task.stepId);
      const linked = catalog?.sessions.find((session) => session.id === task.execution?.id);
      expect(linked).toMatchObject({ runId, memberId: step?.assignedMemberId, workspaceId: piui });
      expect(linked?.title.endsWith(` - ${task.stepId}`)).toBe(true);
      const snapshot = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'snapshot', sessionId: linked?.id } });
      const answer = snapshot.type === 'session' ? snapshot.snapshot.blocks.find((block) => block.id === task.resultReference?.blockId) : undefined;
      expect(task.resultReference?.contentHash).toBe(sha256Hex(answer?.text ?? ''));
    }
    const usage = await call<Record<string, UsageReceipt[]>>(host, 'orchestration_run_usage_v6', { workspaceId: piui, runId });
    expect(Object.keys(usage)).toHaveLength(5);
    expect(Object.values(usage).every((receipts) => receipts.length > 0)).toBe(true);
  });

  it('continues an approval-gated run when the operator approves the step', async () => {
    const host = labHost();
    const studio = projectId(host, 'video-studio');
    const [summary] = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: studio });
    const run = await getRun(host, studio, summary?.id ?? '');
    const gate = run.tasks.find((task) => task.status === 'awaitingApproval');
    const decide = (revision: number, taskRevision: number) => call<OrchestrationRunV6>(host, 'orchestration_control_flow_v6', {
      workspaceId: studio, runId: run.id, expectedRunRevision: revision,
      action: { type: 'decide', stepId: gate?.stepId, taskRevision, approved: true },
    });
    expect(await rejection(decide(run.revision - 1, gate?.revision ?? 0))).toMatchObject({ code: 'conflict' });
    expect(await rejection(decide(run.revision, (gate?.revision ?? 0) + 1))).toMatchObject({ code: 'invalid' });
    const approved = await decide(run.revision, gate?.revision ?? 0);
    expect(approved.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'skipped', 'succeeded', 'running']);
    const finished = await waitForRun(host, studio, run.id, (current) => current.status !== 'running');
    expect(finished.status).toBe('succeeded');
  });

  it('pauses admissions, resumes them and cancels runs with revision checks', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { team, pipeline } = await system(host, piui, 'Code review');
    const runId = labUuid('test:run:paused');
    const started = await call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
      workspaceId: piui, runId, teamId: team.id, pipelineId: pipeline.id, inputs: REVIEW_INPUTS,
    });
    const flow = (revision: number, type: 'pause' | 'resume') => call<OrchestrationRunV6>(host, 'orchestration_control_flow_v6', {
      workspaceId: piui, runId, expectedRunRevision: revision, action: { type },
    });
    const paused = await flow(started.revision, 'pause');
    expect(paused.paused).toBe(true);
    const idle = await waitForRun(host, piui, runId, (run) => run.tasks[0]?.status === 'succeeded');
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await getRun(host, piui, runId)).tasks[1]?.status).toBe('ready');
    const resumed = await flow((await getRun(host, piui, runId)).revision, 'resume');
    expect(resumed.paused).toBeUndefined();
    expect(resumed.tasks[1]?.status).toBe('running');
    expect(idle.revision).toBeLessThan(resumed.revision);

    const cancel = (revision: number) => call<OrchestrationRunV6>(host, 'orchestration_cancel_run_v6', {
      workspaceId: piui, runId, expectedRunRevision: revision,
    });
    expect(await rejection(cancel(resumed.revision - 1))).toMatchObject({ code: 'conflict' });
    const cancelled = await cancel(resumed.revision);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks.map((task) => task.status)).toEqual(['succeeded', 'cancelled', 'cancelled']);
    const developer = host.state.sessions.get(cancelled.tasks[1]?.execution?.id ?? '');
    expect(developer?.live?.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await getRun(host, piui, runId)).revision).toBe(cancelled.revision);
  });

  it('saves whole graphs atomically with revision checks, validation and spawn authority', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const profile = (id: string, patch: Partial<AgentProfile> = {}): AgentProfile => ({
      id, name: `Agent ${id}`, harness: 'codex', modelProvider: 'openai-lab', model: 'gpt-lab-5-mini', permissionMode: 'read-only',
      instructions: 'Lab agent', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [], ...patch,
    });
    const graph = (revision: number | undefined, profiles: AgentProfile[], dependencies: string[] = []) => {
      const save = <T>(value: T) => ({ workspaceId: piui, value, ...(revision === undefined ? {} : { expectedRevision: revision }) });
      const step = { id: 'g-node', name: 'Node', assignedMemberId: 'g-node', instructions: 'Do it', dependencyStepIds: dependencies };
      return {
        workspaceId: piui,
        profiles: profiles.map(save),
        team: save({
          id: 'g-team', name: 'Graph', members: [{ id: 'g-node', profileId: 'g-a' }],
          sendEdges: [], observeEdges: [], orchestratorMemberId: 'g-node',
        }),
        pipeline: save({ id: 'g-pipeline', name: 'Graph', steps: [step] }),
        command: save({ id: 'g-command', name: 'Graph', teamId: 'g-team', pipelineId: 'g-pipeline' }),
      };
    };
    expect(await call(host, 'orchestration_save_graph_v6', graph(undefined, [profile('g-a')]))).toBeNull();
    expect(await call(host, 'orchestration_save_graph_v6', graph(0, [profile('g-a', { name: 'Renamed' })]))).toBeNull();
    expect(await rejection(call(host, 'orchestration_save_graph_v6', graph(0, [profile('g-a')])))).toMatchObject({ code: 'conflict' });
    expect(await rejection(call(host, 'orchestration_save_graph_v6', graph(1, [profile('g-a')], ['g-node'])))).toMatchObject({ code: 'invalid' });
    const escalation = [profile('g-a', { allowedSpawnProfileIds: ['g-b'] }), profile('g-b', { permissionMode: 'full-access' })];
    expect(await rejection(call(host, 'orchestration_save_graph_v6', graph(1, escalation)))).toMatchObject({ code: 'denied' });
    const stored = await call<StoredDefinition<AgentProfile>>(host, 'orchestration_get_profile_v6', { workspaceId: piui, id: 'g-a' });
    expect(stored).toMatchObject({ revision: 1, value: { name: 'Renamed' } });
  });

  it('enforces definition revisions and references on single saves and deletes', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId: piui });
    const docs = catalog.profiles.find((item) => item.name === 'Docs writer');
    const planner = catalog.profiles.find((item) => item.name === 'Planner');
    const stored = await call<StoredDefinition<AgentProfile>>(host, 'orchestration_get_profile_v6', { workspaceId: piui, id: docs?.id });
    const save = (value: AgentProfile, expectedRevision?: number) => call<StoredDefinition<AgentProfile>>(host, 'orchestration_save_profile_v6', {
      workspaceId: piui, value, ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    expect(await rejection(save(stored.value))).toMatchObject({ code: 'already-exists' });
    expect(await rejection(save(stored.value, 7))).toMatchObject({ code: 'conflict' });
    expect(await rejection(save({ ...stored.value, id: 'fresh' }, 0))).toMatchObject({ code: 'not-found' });
    expect(await rejection(save({ ...stored.value, serviceTier: 'fast' }, 0))).toMatchObject({ code: 'invalid' });
    expect(await save({ ...stored.value, name: 'Docs editor' }, 0)).toMatchObject({ revision: 1, value: { name: 'Docs editor' } });
    const remove = (id: string | undefined, expectedRevision: number) =>
      call(host, 'orchestration_delete_profile_v6', { workspaceId: piui, id, expectedRevision });
    expect(await rejection(remove(planner?.id, 0))).toMatchObject({ code: 'conflict' });
    expect(await rejection(remove(docs?.id, 0))).toMatchObject({ code: 'conflict' });
    expect(await remove(docs?.id, 1)).toBeNull();
    expect(await call(host, 'orchestration_get_profile_v6', { workspaceId: piui, id: docs?.id })).toBeNull();
  });

  it('creates, enables and deletes schedules with change events', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const events = await record<OrchestrationScheduleChangedEventV7>(host, SCHEDULE_EVENTS);
    const [nightly] = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    const value = {
      id: 'lab-hourly', name: 'Hourly smoke', launchCommandId: nightly?.value.launchCommandId,
      trigger: { type: 'interval', every: 1, unit: 'hours', anchorAt: '2026-09-26T10:00:00.000Z', timeZone: 'UTC' },
      missedRunPolicy: 'coalesce', overlapPolicy: 'skip', inputs: REVIEW_INPUTS,
    };
    // The Code review pipeline requires `task`: missing, mistyped or unknown values are refused.
    for (const inputs of [{}, { task: 7 }, { ...REVIEW_INPUTS, owner: 'me' }]) {
      expect(await rejection(call(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value: { ...value, inputs } })))
        .toMatchObject({ code: 'invalid' });
    }
    expect(await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui })).toHaveLength(1);
    const created = await call<ScheduleSnapshot>(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value });
    expect(created).toMatchObject({ revision: 0, enabled: false, nextDueAt: '2026-09-26T10:00:00Z', lastOccurrence: null });
    expect(created.value.trigger).toMatchObject({ anchorAt: '2026-09-26T10:00:00Z' });
    expect(created.value.inputs).toEqual(REVIEW_INPUTS);
    const enabled = await call<ScheduleSnapshot>(host, 'orchestration_set_schedule_enabled_v7', {
      workspaceId: piui, id: 'lab-hourly', expectedRevision: 0, enabled: true,
    });
    expect(enabled).toMatchObject({ revision: 1, enabled: true });
    const zero = { ...value, trigger: { ...value.trigger, every: 0 } };
    expect(await rejection(call(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value: zero }))).toMatchObject({ code: 'invalid' });
    expect(await call(host, 'orchestration_delete_schedule_v7', { workspaceId: piui, id: 'lab-hourly', expectedRevision: 1 })).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.items.map((event) => [event.scheduleId, event.revision])).toEqual([['lab-hourly', 0], ['lab-hourly', 1], ['lab-hourly', 2]]);
    expect(await rejection(call(host, 'orchestration_set_schedule_enabled_v7', {
      workspaceId: projectId(host, 'legacy-repo'), id: 'any', expectedRevision: 0, enabled: true,
    }))).toMatchObject({ code: 'runtime-unavailable' });
  });

  it('saves day-of-week schedules at local wall time and refuses malformed rules', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const [nightly] = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    const value = {
      id: 'lab-weekdays', name: 'Weekday review', launchCommandId: nightly?.value.launchCommandId,
      trigger: { type: 'calendar', time: '09:00', days: [1, 2, 3, 4, 5], startsAt: '2026-09-25T10:00:00.000Z', timeZone: 'Europe/Moscow' },
      missedRunPolicy: 'skip', overlapPolicy: 'skip', inputs: REVIEW_INPUTS,
    };
    const created = await call<ScheduleSnapshot>(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value });
    // Friday 13:00 Moscow time: the next weekday 09:00 is Monday, 06:00 UTC.
    expect(created).toMatchObject({ enabled: false, nextDueAt: '2026-09-28T06:00:00Z' });
    expect(created.value.trigger).toMatchObject({ startsAt: '2026-09-25T10:00:00Z' });
    for (const trigger of [{ ...value.trigger, days: [] }, { ...value.trigger, time: '9:00' }, { ...value.trigger, timeZone: 'Mars/Olympus' }]) {
      expect(await rejection(call(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value: { ...value, id: 'lab-bad', trigger } })))
        .toMatchObject({ code: 'invalid' });
    }
  });

  it('keeps safe mode read-only: recorded runs are visible, interrupted ones need reconciliation', async () => {
    const host = labHost('safe');
    const piui = projectId(host, 'piui');
    const runs = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: piui });
    expect(runs.map((run) => run.status).sort()).toEqual(['failed', 'succeeded', 'uncertain']);
    const uncertain = await getRun(host, piui, runs.find((run) => run.status === 'uncertain')?.id ?? '');
    expect(uncertain.tasks.map((task) => task.status)).toEqual(['succeeded', 'uncertain', 'ready']);
    const { team, pipeline } = await system(host, piui, 'Code review');
    const mutation = { workspaceId: piui, runId: uncertain.id, expectedRunRevision: uncertain.revision };
    const task = uncertain.tasks[1];
    const refused = [
      call(host, 'orchestration_start_run_v6', { workspaceId: piui, runId: 'safe-run', teamId: team.id, pipelineId: pipeline.id }),
      call(host, 'orchestration_cancel_run_v6', mutation),
      call(host, 'orchestration_control_flow_v6', { ...mutation, action: { type: 'pause' } }),
      call(host, 'orchestration_retry_uncertain_task_v6', { ...mutation, stepId: task?.stepId, expectedTaskRevision: task?.revision }),
    ];
    for (const attempt of refused) expect(await rejection(attempt)).toMatchObject({ code: 'runtime-unavailable' });
  });

  it('works through the production orchestration client, including its event validation', async () => {
    const host = labHost();
    const client = createOrchestrationClient(
      <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
      (handler) => host.listen('piui://orchestration-event', handler),
      (handler) => host.listen('piui://orchestration-schedule-event', handler),
    );
    const piui = projectId(host, 'piui');
    const changes: OrchestrationRunChangedEventV6[] = [];
    await client.listen((event) => changes.push(event));
    const catalog = await client.orchestration_catalog_v6({ workspaceId: piui });
    expect(catalog.teams.map((team) => team.name).sort()).toEqual(['Code review', 'Release check']);
    const named = <T extends { readonly name: string; readonly id: string }>(items: readonly T[]) =>
      items.find((item) => item.name === 'Code review')?.id ?? '';
    const request = {
      workspaceId: piui, runId: labUuid('test:client'), teamId: named(catalog.teams), pipelineId: named(catalog.pipelines),
      inputs: REVIEW_INPUTS,
    };
    const run = await client.orchestration_start_run_v6(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.some((event) => event.runId === run.id)).toBe(true);
    await expect(client.orchestration_start_run_v6(request)).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('refuses run inputs the pipeline does not accept and freezes accepted ones', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { team, pipeline } = await system(host, piui, 'Code review');
    const start = (runId: string, inputs: unknown) => call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
      workspaceId: piui, runId, teamId: team.id, pipelineId: pipeline.id, ...(inputs === undefined ? {} : { inputs }),
    });
    for (const [index, inputs] of [undefined, {}, { task: '  ' }, { task: 42 }, { task: null }, { ...REVIEW_INPUTS, extra: true }].entries()) {
      expect(await rejection(start(`refused-${index}`, inputs))).toMatchObject({ code: 'invalid' });
    }
    // A map is required when `inputs` is present, exactly like serde.
    expect(await rejection(start('refused-null', null))).toMatch(/invalid type: null, expected a map/);
    const runs = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId: piui });
    expect(runs.some((run) => run.id.startsWith('refused'))).toBe(false);

    const started = await start('accepted', REVIEW_INPUTS);
    expect(started.inputs).toEqual(REVIEW_INPUTS);
    // Later definition edits never reach a run's frozen inputs.
    const stored = await call<StoredDefinition<PipelineDefinition>>(host, 'orchestration_get_pipeline_v6', { workspaceId: piui, id: pipeline.id });
    const edited = { ...stored.value, inputs: [{ name: 'task', label: 'Change request', kind: 'text' as const, defaultValue: 'Anything' }] };
    await call(host, 'orchestration_save_pipeline_v6', { workspaceId: piui, expectedRevision: stored.revision, value: edited });
    const current = await getRun(host, piui, 'accepted');
    expect(current.inputs).toEqual(REVIEW_INPUTS);
    expect(current.definition.pipeline.inputs?.[0]?.label).toBe('What should be reviewed?');
    const invalidDeclaration = { ...edited, inputs: [{ name: 'Task', label: 'Task', kind: 'text' }] };
    expect(await rejection(call(host, 'orchestration_save_pipeline_v6', {
      workspaceId: piui, expectedRevision: stored.revision + 1, value: invalidDeclaration,
    }))).toMatchObject({ code: 'invalid' });
  });

  it('waits for a person when a review loop reaches its limit, then continues on approval', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { team, pipeline } = await system(host, piui, 'Code review');
    const stored = await call<StoredDefinition<PipelineDefinition>>(host, 'orchestration_get_pipeline_v6', { workspaceId: piui, id: pipeline.id });
    const reviewer = stored.value.steps[2]!;
    const bounded = {
      ...stored.value,
      steps: [...stored.value.steps.slice(0, 2), { ...reviewer, review: { ...reviewer.review!, maxIterations: 1 } }],
    };
    expect(await rejection(call(host, 'orchestration_save_pipeline_v6', {
      workspaceId: piui, expectedRevision: stored.revision,
      value: { ...bounded, steps: [...bounded.steps.slice(0, 2), { ...reviewer, review: { ...reviewer.review!, maxIterations: 0 } }] },
    }))).toMatchObject({ code: 'invalid' });
    await call(host, 'orchestration_save_pipeline_v6', { workspaceId: piui, expectedRevision: stored.revision, value: bounded });
    const runId = labUuid('test:run:review-limit');
    await call(host, 'orchestration_start_run_v6', { workspaceId: piui, runId, teamId: team.id, pipelineId: pipeline.id, inputs: REVIEW_INPUTS });

    const waiting = await waitForRun(host, piui, runId, (run) => run.tasks[2]?.status === 'awaitingApproval');
    expect(waiting.status).toBe('running');
    expect(waiting.tasks[2]).toMatchObject({ failure: { code: 'review-limit-reached' }, resultData: { approved: false } });
    expect(waiting.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'awaitingApproval']);
    expect(waiting.attempts).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await getRun(host, piui, runId)).revision).toBe(waiting.revision);

    const approved = await call<OrchestrationRunV6>(host, 'orchestration_control_flow_v6', {
      workspaceId: piui, runId, expectedRunRevision: waiting.revision,
      action: { type: 'decide', stepId: waiting.tasks[2]?.stepId, taskRevision: waiting.tasks[2]?.revision, approved: true },
    });
    expect(approved.status).toBe('succeeded');
    expect(approved.tasks[2]?.status).toBe('succeeded');
    expect(approved.tasks[2]?.failure).toBeUndefined();
  });
});
