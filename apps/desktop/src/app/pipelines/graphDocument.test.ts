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
    vi.unstubAllGlobals();
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

  it('keeps steps left of the origin and the Start and Output places across save and reopen', async () => {
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
    const host = labHost();
    const client = createOrchestrationClient(
      <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
      (handler) => host.listen('piui://orchestration-event', handler),
      (handler) => host.listen('piui://orchestration-schedule-event', handler),
    );
    const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
    const catalog = await client.orchestration_catalog_v6({ workspaceId });
    const command = catalog.launchCommands.find((item) => item.name === 'Release check');

    const opened = await openGraph(client, workspaceId, command?.id ?? '');
    // Nothing is stored yet: the steps are laid out afresh and so are the blocks.
    expect(opened.needsLayout).toBe(true);
    expect(opened.graph.layout).toBeUndefined();

    const layout = { start: { x: -500, y: -60 }, output: { x: 1200, y: 300 } };
    const graph = {
      ...opened.graph,
      layout,
      nodes: opened.graph.nodes.map((node, index) => (index === 0 ? { ...node, x: -120, y: -40 } : node)),
    };
    await saveGraph(client, workspaceId, graph, opened.revisions);

    const reopened = await openGraph(client, workspaceId, command?.id ?? '');
    expect(reopened.graph.nodes[0]).toMatchObject({ x: -120, y: -40 });
    expect(reopened.graph.layout).toEqual(layout);
    expect(reopened.needsLayout).toBe(false);
  });
});
