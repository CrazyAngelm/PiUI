import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationClient, type OrchestrationCommandName } from '../../host-api/orchestrationClient';
import type { LabHost } from '../../host-api/lab/labHost';
import { labHost } from '../../host-api/lab/labTestKit';
import { RunLaunch } from './runLaunch.svelte';

const REVIEW_INPUTS = { task: 'Check the release notes against the merged changes.' };

function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

describe('run a pipeline from a chat (UI Lab host)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the project pipelines, asks for inputs and starts with the chat identity', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const client = createOrchestrationClient((route: OrchestrationCommandName, args) => host.invoke(route, args));
    const launch = new RunLaunch(piui, 'chat-1', client, false);
    await launch.load();
    expect(launch.pipelines.map((pipeline) => pipeline.name)).toEqual(['Code review', 'Release check']);
    expect(launch.selected?.name).toBe('Code review');
    expect(launch.ready).toBe(true);
    expect(launch.needsInputs).toBe(true);
    const run = await launch.start(REVIEW_INPUTS);
    expect(run?.trigger).toEqual({ kind: 'chat', sessionId: 'chat-1' });
    expect(run?.inputs).toEqual(REVIEW_INPUTS);
    expect(run?.definition.launchCommand?.id).toBe(launch.selectedId);
    expect(launch.error).toBe('');

    // Like the editor's Run, any declared input (even with a default) is shown first.
    const release = launch.pipelines.find((pipeline) => pipeline.name === 'Release check');
    await launch.select(release?.id ?? '');
    expect(launch.needsInputs).toBe(true);
    expect(launch.inputs.map((input) => input.name)).toEqual(['since']);
  });

  it('keeps the choice when the host refuses, and retries with the same identity', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const client = createOrchestrationClient((route: OrchestrationCommandName, args) => host.invoke(route, args));
    const launch = new RunLaunch(piui, undefined, client, false);
    await launch.load();
    const project = host.state.projects.find((candidate) => candidate.id === piui);
    if (project === undefined) throw new Error('No project.');
    project.trustState = 'restricted';
    expect(await launch.start(REVIEW_INPUTS)).toBeUndefined();
    expect(launch.error).toContain('native runtime is unavailable');
    expect(launch.selected?.name).toBe('Code review');
    project.trustState = 'trusted';
    const run = await launch.start(REVIEW_INPUTS);
    expect(run?.trigger).toEqual({ kind: 'chat' });

    const safe = new RunLaunch(piui, 'chat-1', client, true);
    await safe.load();
    expect(await safe.start(REVIEW_INPUTS)).toBeUndefined();
    expect(safe.error).toBe('Safe mode keeps runs read-only.');
  });
});
