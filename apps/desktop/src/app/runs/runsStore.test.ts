import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationClient, ORCHESTRATION_EVENT_V6, type OrchestrationClient, type OrchestrationRunV6 } from '../../host-api/orchestrationClient';
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

function recordedRun(id: string): OrchestrationRunV6 {
  return {
    schemaVersion: 6,
    id,
    revision: 1,
    status: 'running',
    tasks: [],
    messages: [],
    agentRequests: [],
    definition: {
      profiles: [],
      team: { id: 'team', name: 'Team', members: [], sendEdges: [], observeEdges: [] },
      pipeline: { id: 'pipeline', name: `Pipeline ${id}`, steps: [] },
    },
  } as unknown as OrchestrationRunV6;
}

/** A client whose run reads answer only when the test says so, in any order. */
function gatedClient(): { client: OrchestrationClient; answer: (runId: string, run: OrchestrationRunV6 | null) => void } {
  const pending = new Map<string, (run: OrchestrationRunV6 | null) => void>();
  const client = {
    orchestration_get_run_v6: ({ runId }: { runId: string }) =>
      new Promise<OrchestrationRunV6 | null>((resolve) => {
        pending.set(runId, resolve);
      }),
    orchestration_run_usage_v6: async () => ({}),
  } as unknown as OrchestrationClient;
  return { client, answer: (runId, run) => pending.get(runId)?.(run) };
}

describe('RunsStore open requests', () => {
  it('keeps the newest run when an older read answers last', async () => {
    const { client, answer } = gatedClient();
    const runs = new RunsStore('workspace', false, client);
    const older = runs.open('older');
    const newer = runs.open('newer');
    answer('newer', recordedRun('newer'));
    await newer;
    answer('older', recordedRun('older'));
    await older;
    expect(runs.run?.id).toBe('newer');
    expect(runs.summaries.map((item) => item.id)).toEqual(['newer']);
    expect(runs.runLoading).toBe(false);
    expect(runs.runError).toBe('');
  });

  it('stays loading until the newest read answers', async () => {
    const { client, answer } = gatedClient();
    const runs = new RunsStore('workspace', false, client);
    const older = runs.open('older');
    const newer = runs.open('newer');
    answer('older', recordedRun('older'));
    await older;
    expect(runs.run).toBeUndefined();
    expect(runs.runLoading).toBe(true);
    answer('newer', recordedRun('newer'));
    await newer;
    expect(runs.run?.id).toBe('newer');
    expect(runs.runLoading).toBe(false);
  });

  it('going back to the shown run while another loads opens it again', async () => {
    const { client, answer } = gatedClient();
    const runs = new RunsStore('workspace', false, client);
    const first = runs.open('a');
    answer('a', recordedRun('a'));
    await first;
    const away = runs.open('b');
    expect(runs.selectedRunId, 'the shown run leaves at once').toBe('');
    const back = runs.open('a');
    answer('b', recordedRun('b'));
    await away;
    expect(runs.run).toBeUndefined();
    answer('a', recordedRun('a'));
    await back;
    expect(runs.run?.id).toBe('a');
  });

  it('shows a failed open instead of the run that was shown before', async () => {
    const { client, answer } = gatedClient();
    const runs = new RunsStore('workspace', false, client);
    const first = runs.open('a');
    answer('a', recordedRun('a'));
    await first;
    const missing = runs.open('b');
    answer('b', null);
    await missing;
    expect(runs.run).toBeUndefined();
    expect(runs.runError).toBe('This run is no longer available. Refresh the list.');
  });

  it('does not report a missing run for an answer that is no longer wanted', async () => {
    const { client, answer } = gatedClient();
    const runs = new RunsStore('workspace', false, client);
    const gone = runs.open('gone');
    const newer = runs.open('newer');
    answer('newer', recordedRun('newer'));
    await newer;
    answer('gone', null);
    await gone;
    expect(runs.run?.id).toBe('newer');
    expect(runs.runError).toBe('');
  });
});
