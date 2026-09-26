import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_SIGN_IN_MESSAGE, harnessCapabilities } from './catalogFake';
import type { AgentProfile, OrchestrationCatalogV6, OrchestrationRunV6 } from './labContracts';
import { claudeSignedOutFromSearch, type LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, rejection } from './labTestKit';

/**
 * Claude Code sign-in in the UI Lab host, as the Rust host does it: a cached
 * signed-out verdict never blocks admission, the start's login check refuses
 * before any task text with `harness-sign-in-required`, and the same step
 * starts once the user has signed in.
 */
function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
  return host.invoke<T>(route, { request });
}

function signIn(host: LabHost, signedIn: boolean): void {
  host.state.harnesses = host.state.harnesses.map((summary) => {
    if (summary.kind !== 'claude-code') return summary;
    const { reason: _reason, ...rest } = summary;
    return signedIn ? rest : { ...rest, reason: CLAUDE_SIGN_IN_MESSAGE };
  });
}

async function claudePipeline(host: LabHost): Promise<string> {
  const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
  const profile: AgentProfile = {
    id: 'writer', name: 'Writer', harness: 'claude-code', modelProvider: 'anthropic', model: 'lab-sonnet',
    permissionMode: 'read-only', instructions: 'Write it', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
  };
  const save = <T>(value: T) => ({ workspaceId, value });
  expect(await call(host, 'orchestration_save_graph_v6', {
    workspaceId,
    profiles: [save(profile)],
    team: save({
      id: 'writers', name: 'Writers', members: [{ id: 'write', profileId: 'writer' }, { id: 'review', profileId: 'writer' }],
      sendEdges: [], observeEdges: [], orchestratorMemberId: 'write',
    }),
    pipeline: save({ id: 'writing', name: 'Writing', steps: [
      { id: 'write', name: 'Write', assignedMemberId: 'write', instructions: 'Write the note', dependencyStepIds: [] },
      { id: 'review', name: 'Review', assignedMemberId: 'review', instructions: 'Review the note', dependencyStepIds: ['write'] },
    ] }),
    command: save({ id: 'writing-command', name: 'Writing', teamId: 'writers', pipelineId: 'writing' }),
  })).toBeNull();
  return workspaceId;
}

async function getRun(host: LabHost, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  const run = await call<OrchestrationRunV6 | null>(host, 'orchestration_get_run_v6', { workspaceId, runId });
  if (run === null) throw new Error('Run not found.');
  return run;
}

describe('UI Lab Claude Code sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds ?claude=signed-out with a Claude check system whose run fails with the typed code', async () => {
    expect(claudeSignedOutFromSearch('?lab=demo&claude=signed-out')).toBe(true);
    expect(claudeSignedOutFromSearch('?lab=demo')).toBe(false);
    const host = labHost('demo', { claudeSignedOut: true });
    expect(host.state.harnesses.find((summary) => summary.kind === 'claude-code')?.reason).toBe(CLAUDE_SIGN_IN_MESSAGE);
    const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
    const command = catalog.launchCommands.find((item) => item.name === 'Claude check');
    const team = catalog.teams.find((item) => item.name === 'Claude check');
    const pipeline = catalog.pipelines.find((item) => item.name === 'Claude check');
    expect(command).toBeDefined();
    const runId = labUuid('test:claude-check');
    expect(await rejection(call(host, 'orchestration_start_run_v6', { workspaceId, runId, teamId: team?.id, pipelineId: pipeline?.id })))
      .toMatchObject({ code: 'runtime-unavailable' });
    const run = await getRun(host, workspaceId, runId);
    expect(run.tasks[0]?.failure).toEqual({ code: 'harness-sign-in-required' });
    // The default demo is unchanged.
    expect(labHost('demo').state.harnesses.find((summary) => summary.kind === 'claude-code')?.reason).toBeUndefined();
  });

  it('keeps a signed-out verdict out of the offline capabilities', () => {
    const summary = { kind: 'claude-code' as const, name: 'Claude Code', installed: true, status: 'available' as const, reason: CLAUDE_SIGN_IN_MESSAGE };
    expect(harnessCapabilities('claude-code', summary).prompt.supported).toBe(true);
  });

  it('fails a signed-out Claude Code step before it starts and runs it again after sign-in', async () => {
    const host = labHost();
    const workspaceId = await claudePipeline(host);
    signIn(host, false);
    const runId = labUuid('test:signed-out');
    const sessionsBefore = host.state.sessions.size;
    // The start command keeps its established error code; the task has the typed one.
    expect(await rejection(call(host, 'orchestration_start_run_v6', { workspaceId, runId, teamId: 'writers', pipelineId: 'writing' })))
      .toMatchObject({ code: 'runtime-unavailable' });
    const failed = await getRun(host, workspaceId, runId);
    expect(failed.status).toBe('failed');
    const write = failed.tasks.find((task) => task.stepId === 'write');
    expect(write).toMatchObject({ status: 'failed', failure: { code: 'harness-sign-in-required' } });
    expect(write?.execution).toBeUndefined();
    expect(failed.tasks.find((task) => task.stepId === 'review')?.status).toBe('cancelled');
    expect(host.state.sessions.size).toBe(sessionsBefore);

    // The user runs `claude` → /login; "Run again from here" starts the same step.
    signIn(host, true);
    const repeated = await call<OrchestrationRunV6>(host, 'orchestration_control_flow_v6', {
      workspaceId, runId, expectedRunRevision: failed.revision,
      action: { type: 'repeat', stepId: 'write', taskRevision: write?.revision },
    });
    expect(repeated.status).toBe('running');
    let run = repeated;
    for (let second = 0; second < 240 && run.status === 'running'; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      run = await getRun(host, workspaceId, runId);
    }
    expect(run.status).toBe('succeeded');
    expect(run.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded']);
    expect(host.state.sessions.get(run.tasks[0]?.execution?.id ?? '')?.harness).toBe('claude-code');
  });
});
