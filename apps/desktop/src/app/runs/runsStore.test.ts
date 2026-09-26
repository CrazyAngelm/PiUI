import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationClient, ORCHESTRATION_EVENT_V6, type OrchestrationClient } from '../../host-api/orchestrationClient';
import type { LabHost } from '../../host-api/lab/labHost';
import { labHost } from '../../host-api/lab/labTestKit';
import { RunsStore } from './runsStore.svelte';

function clientFor(host: LabHost): OrchestrationClient {
  return createOrchestrationClient(
    (route, args) => host.invoke(route, args),
    (handler) => host.listen<unknown>(ORCHESTRATION_EVENT_V6, handler),
  );
}

function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`No project ${name}`);
  return project.id;
}

async function until(check: () => boolean, seconds = 120): Promise<void> {
  for (let step = 0; step < seconds * 4; step += 1) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(250);
  }
  throw new Error('Condition was not reached.');
}

describe('RunsStore over the lab host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-26T12:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the active run first', async () => {
    const host = labHost();
    const runs = new RunsStore(projectId(host, 'piui'), false, clientFor(host));
    const stop = runs.start();
    await until(() => runs.run !== undefined);
    expect(runs.run?.status).toBe('running');
    expect(runs.summaries.map((item) => item.status).sort()).toEqual(['failed', 'running', 'succeeded']);
    stop();
  });

  it('approves a gated step with revision checks and continues the run', async () => {
    const host = labHost();
    const runs = new RunsStore(projectId(host, 'video-studio'), false, clientFor(host));
    const stop = runs.start();
    await until(() => runs.run !== undefined);
    const gate = runs.run?.tasks.find((task) => task.status === 'awaitingApproval');
    expect(gate).toBeDefined();
    expect(await runs.decide(gate?.stepId ?? '', true)).toBe(true);
    expect(runs.run?.tasks.find((task) => task.stepId === gate?.stepId)?.status).toBe('succeeded');
    expect(runs.actionError).toBe('');
    // Live invalidations carry the run to its recorded end without polling.
    await until(() => runs.run?.status !== 'running', 240);
    expect(runs.run?.status).toBe('succeeded');
    expect(runs.summaries.find((item) => item.id === runs.run?.id)?.status).toBe('succeeded');
    stop();
  });

  it('keeps runs read-only in safe mode', async () => {
    const host = labHost();
    const runs = new RunsStore(projectId(host, 'video-studio'), true, clientFor(host));
    const stop = runs.start();
    await until(() => runs.run !== undefined);
    const gate = runs.run?.tasks.find((task) => task.status === 'awaitingApproval');
    expect(await runs.decide(gate?.stepId ?? '', true)).toBe(false);
    expect(runs.actionError).toMatch(/safe mode/i);
    expect(runs.run?.tasks.find((task) => task.stepId === gate?.stepId)?.status).toBe('awaitingApproval');
    stop();
  });

  it('reports a stale action instead of replaying it', async () => {
    const host = labHost();
    const runs = new RunsStore(projectId(host, 'video-studio'), false, clientFor(host));
    const stop = runs.start();
    await until(() => runs.run !== undefined);
    const gate = runs.run?.tasks.find((task) => task.status === 'awaitingApproval');
    // Someone else decides first; our copy still holds the old revision.
    const current = runs.run;
    if (!current || !gate) throw new Error('missing gate');
    await host.invoke('orchestration_control_flow_v6', {
      request: {
        workspaceId: runs.workspaceId,
        runId: current.id,
        expectedRunRevision: current.revision,
        action: { type: 'decide', stepId: gate.stepId, taskRevision: gate.revision, approved: false },
      },
    });
    runs.run = current;
    expect(await runs.decide(gate.stepId, true)).toBe(false);
    expect(runs.actionError).not.toBe('');
    // Recovery read shows the recorded outcome rather than our intent.
    expect(runs.run?.revision).toBeGreaterThan(current.revision);
    stop();
  });
});
