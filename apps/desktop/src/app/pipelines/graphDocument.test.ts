import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphIssues } from '../../features/orchestration/agentGraph';
import { createOrchestrationClient, type OrchestrationCommandName } from '../../host-api/orchestrationClient';
import { labHost } from '../../host-api/lab/labTestKit';
import { openGraph, saveGraph } from './graphDocument';

describe('graph documents with step executors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a system with a script and a model call, and saves it unchanged', async () => {
    const host = labHost();
    const client = createOrchestrationClient(
      <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
      (handler) => host.listen('piui://orchestration-event', handler),
      (handler) => host.listen('piui://orchestration-schedule-event', handler),
    );
    const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
    const catalog = await client.orchestration_catalog_v6({ workspaceId });
    const command = catalog.launchCommands.find((item) => item.name === 'Release check');
    expect(command).toBeDefined();

    const opened = await openGraph(client, workspaceId, command?.id ?? '');
    const kinds = opened.graph.nodes.map((node) => node.executor?.type ?? 'agent');
    expect(kinds).toEqual(['agent', 'script', 'llm']);
    const script = opened.graph.nodes.find((node) => node.executor?.type === 'script');
    expect(script?.profile.model).toBe('script');
    expect(graphIssues(opened.graph)).toEqual([]);

    // The script's placeholder profile is never saved; the agent and model call are.
    const revisions = await saveGraph(client, workspaceId, opened.graph, opened.revisions);
    expect(revisions.has(script?.profile.id ?? '')).toBe(false);
    const reopened = await openGraph(client, workspaceId, command?.id ?? '');
    expect(reopened.graph.nodes.map((node) => node.executor)).toEqual(opened.graph.nodes.map((node) => node.executor));
  });
});
