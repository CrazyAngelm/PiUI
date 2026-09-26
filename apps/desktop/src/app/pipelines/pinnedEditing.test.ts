import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { compileGraph, graphIssues, newGraphNode, type AgentGraph } from '../../features/orchestration/agentGraph';
import { duplicateNode } from '../../features/orchestration/graphHistory';
import { graphToSystemFile, parseSystemFile, serializeSystemFile } from '../../features/orchestration/systemFile';
import {
  createOrchestrationClient,
  type OrchestrationCommandName,
  type OrchestrationRunV6,
  type PinnedOutput,
} from '../../host-api/orchestrationClient';
import { PINNED_ISSUES } from '../../host-api/pinnedData';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabHost } from '../../host-api/lab/labHost';
import { labUuid } from '../../host-api/lab/labRandom';
import type { RunOutputsResultV1 } from '../../host-api/runDebuggingClient';
import { applyProposal } from './assistant/builderPrompt';
import { PipelineEditorStore } from './editorStore.svelte';
import { graphFromDefinitions, openGraph, saveGraph } from './graphDocument';
import { DRAFT_REASONS, draftOutputs, runDraft } from './runDraft';
import { defaultSample, pinnedDependencies } from './scriptTests.svelte';
import PinnedRunOption from './inputs/PinnedRunOption.svelte';
import PinnedDataSection from './PinnedDataSection.svelte';
import WithWorkspace from './testing/WithWorkspace.svelte';
import type { OrchestrationClient } from '../../host-api/orchestrationClient';

/**
 * Pinned data in the editor (orchestration v6.3): opening and saving keeps
 * pins, a past run opens as a new draft with the chosen outputs pinned, a
 * run started from the editor uses them, and system files never carry them.
 */
const PIN: PinnedOutput = { text: 'The plan', pinnedAt: '2026-09-27T10:00:00Z', sourceRunId: 'run-1' };

function clientOf(host: LabHost): OrchestrationClient {
  return createOrchestrationClient(
    <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
    (handler) => host.listen('piui://orchestration-event', handler),
    (handler) => host.listen('piui://orchestration-schedule-event', handler),
  );
}

async function settle(client: OrchestrationClient, workspaceId: string, runId: string): Promise<OrchestrationRunV6> {
  for (let second = 0; second < 240; second += 1) {
    const run = await client.orchestration_get_run_v6({ workspaceId, runId });
    if (run !== null && run.status !== 'running') return run;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  throw new Error('The run did not settle.');
}

function chain(): AgentGraph {
  const agent = (index: number) => {
    const node = newGraphNode(index);
    return { ...node, profile: { ...node.profile, model: 'gpt-5.5' } };
  };
  const plan = { ...agent(0), pinnedOutput: PIN };
  const review = agent(1);
  return { id: 'g', name: 'G', teamId: 't', pipelineId: 'p', nodes: [plan, review], edges: [{ from: plan.id, to: review.id, kind: 'result' }] };
}

describe('pinned data in the editor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compiles pins into the pipeline and opens them again', () => {
    const graph = chain();
    const definition = compileGraph(graph);
    expect(definition.pipeline.steps[0]?.pinnedOutput).toEqual(PIN);
    expect(definition.pipeline.steps[1]?.pinnedOutput).toBeUndefined();
    const reopened = graphFromDefinitions({
      command: definition.command,
      team: definition.team,
      pipeline: definition.pipeline,
      profiles: new Map(definition.profiles.map((profile) => [profile.id, profile])),
    });
    expect(reopened.nodes[0]?.pinnedOutput).toEqual(PIN);
    expect(graphIssues(reopened)).toEqual([]);
  });

  it('flags pins the host would refuse and never copies or exports them', () => {
    const graph = chain();
    const [plan, review] = graph.nodes;
    const reviewing: AgentGraph = {
      ...graph,
      nodes: [{ ...plan!, resultFields: [{ name: 'ok', kind: 'boolean' }], review: undefined }, { ...review!, pinnedOutput: PIN, resultFields: [{ name: 'ok', kind: 'boolean' }], review: { field: 'ok', retryFromStepId: plan!.id } }],
    };
    expect(graphIssues(reviewing).map((issue) => issue.message)).toContain(PINNED_ISSUES.notPinnable);
    expect(duplicateNode(plan!, 'Copy').pinnedOutput).toBeUndefined();
    const file = graphToSystemFile(graph);
    expect(JSON.stringify(file)).not.toContain('pinnedOutput');
    expect(parseSystemFile(serializeSystemFile(graph)).agents).toHaveLength(2);
    // An assistant proposal keeps the pins of nodes that survive it.
    const proposed = applyProposal(graph, { ...file, name: 'Renamed' });
    expect(proposed.nodes.find((node) => node.id === plan!.id)?.pinnedOutput).toEqual(PIN);
  });

  it('uses pinned upstream outputs in the script test sample', () => {
    const graph = chain();
    const [plan, review] = graph.nodes;
    const script = { ...review!, executor: { type: 'script' as const, runtime: 'node' as const, source: 'x', timeoutSeconds: 5 } };
    const data = { ...graph, nodes: [{ ...plan!, pinnedOutput: { ...PIN, text: '{"files": 2}' } }, script] };
    const sample = JSON.parse(defaultSample(data, script)) as { dependencies: Record<string, unknown> };
    expect(sample.dependencies[plan!.id]).toEqual({ text: '{"files": 2}', data: { files: 2 } });
    expect(pinnedDependencies(data, script.id).map((node) => node.id)).toEqual([plan!.id]);
    const plain = { ...graph, nodes: [{ ...plan!, pinnedOutput: undefined }, script] };
    expect((JSON.parse(defaultSample(plain, script)) as { dependencies: Record<string, unknown> }).dependencies[plan!.id]).toEqual({ text: null, data: null });
  });

  it('keeps pins through open and save, opens a run as a new draft and runs it with pinned data', async () => {
    const host = labHost();
    const client = clientOf(host);
    const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
    const catalog = await client.orchestration_catalog_v6({ workspaceId });
    const commandId = catalog.launchCommands.find((item) => item.name === 'Release check')?.id ?? '';
    const opened = await openGraph(client, workspaceId, commandId);
    const [scout, metrics] = opened.graph.nodes;

    // A finished run: its scout output is pinned into the saved pipeline.
    const first = labUuid('test:editor-source');
    await client.orchestration_start_run_v6({ workspaceId, runId: first, teamId: opened.graph.teamId, pipelineId: opened.graph.pipelineId });
    const finished = await settle(client, workspaceId, first);
    const pipeline = await client.orchestration_get_pipeline_v6({ workspaceId, id: opened.graph.pipelineId });
    await host.invoke('orchestration_pin_step_output_v1', {
      request: { workspaceId, runId: first, stepId: scout!.id, pipelineId: opened.graph.pipelineId, expectedRevision: pipeline?.revision ?? -1 },
    });
    const pinned = await openGraph(client, workspaceId, commandId);
    expect(pinned.graph.nodes[0]?.pinnedOutput?.sourceRunId).toBe(first);
    // Saving the opened graph unchanged keeps the pin.
    const revisions = await saveGraph(client, workspaceId, pinned.graph, pinned.revisions);
    const saved = await client.orchestration_get_pipeline_v6({ workspaceId, id: opened.graph.pipelineId });
    expect(saved?.value.steps[0]?.pinnedOutput?.sourceRunId).toBe(first);

    // Debug the finished run: a new draft with the checked outputs pinned.
    const outputs = await host.invoke<RunOutputsResultV1>('orchestration_run_outputs_v1', { request: { workspaceId, runId: first } });
    const items = draftOutputs(finished, outputs.outputs, new Date('2026-09-27T11:00:00Z'));
    expect(items.map((item) => item.stepId)).toEqual(opened.graph.nodes.map((node) => node.id));
    expect(items.every((item) => item.pin !== undefined && item.reason === undefined)).toBe(true);
    const metricsPin = items.find((item) => item.stepId === metrics!.id)?.pin;
    const draft = runDraft(finished, workspaceId, [{ stepId: metrics!.id, pinnedOutput: metricsPin! }], 'Release check (debug)');
    expect(draft.id).not.toBe(commandId);
    expect(draft.pipelineId).not.toBe(opened.graph.pipelineId);
    expect(draft.teamId).not.toBe(opened.graph.teamId);
    expect(draft.nodes.map((node) => node.id)).toEqual(opened.graph.nodes.map((node) => node.id));
    expect(draft.nodes.every((node) => !opened.graph.nodes.some((original) => original.profile.id === node.profile.id))).toBe(true);
    expect(draft.nodes.map((node) => node.pinnedOutput?.sourceRunId)).toEqual([undefined, first, undefined]);
    expect(graphIssues(draft)).toEqual([]);

    // The editor saves the draft as a copy and starts it with pinned data: the script never runs.
    const editor = new PipelineEditorStore(workspaceId, false, client);
    editor.startFrom(draft);
    // The native catalog preflight answers after a simulated latency.
    let done = false;
    const pending = editor.save(true, undefined, true).finally(() => {
      done = true;
    });
    for (let step = 0; step < 40 && !done; step += 1) await vi.advanceTimersByTimeAsync(500);
    const started = await pending;
    expect(editor.errors).toEqual([]);
    expect(started).toBe(true);
    expect(editor.lastRun?.usePinnedData).toBe(true);
    const run = await settle(client, workspaceId, editor.lastRun?.id ?? '');
    expect(run.status).toBe('succeeded');
    const metricsTask = run.tasks.find((task) => task.stepId === metrics!.id);
    expect(metricsTask).toMatchObject({ pinned: true, status: 'succeeded' });
    expect(metricsTask?.execution).toBeUndefined();

    // The copy holds the chosen pin; the saved pipeline is untouched and keeps its own.
    const copy = await client.orchestration_get_pipeline_v6({ workspaceId, id: draft.pipelineId });
    expect(copy?.value.steps.map((step) => step.pinnedOutput?.sourceRunId)).toEqual([undefined, first, undefined]);
    const original = await client.orchestration_get_pipeline_v6({ workspaceId, id: opened.graph.pipelineId });
    expect(original?.revision).toBe(revisions.get(opened.graph.pipelineId));
    expect(original?.value.steps[0]?.pinnedOutput?.sourceRunId).toBe(first);
  }, 60_000);

  it('explains what cannot be pinned when a run is opened as a draft', () => {
    const run = {
      schemaVersion: 6, id: 'run-1', status: 'failed', revision: 3,
      definition: {
        profiles: [{ id: 'p', name: 'Worker', harness: 'codex', model: 'm', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] }],
        team: { id: 't', name: 'T', members: [{ id: 'a', profileId: 'p' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'a' },
        pipeline: { id: 'x', name: 'X', steps: [
          { id: 'a', name: 'A', assignedMemberId: 'a', instructions: '', dependencyStepIds: [], resultFields: [{ name: 'ok', kind: 'boolean' }] },
          { id: 'b', name: 'B', assignedMemberId: 'b', instructions: '', dependencyStepIds: ['a'], router: { mode: 'program', inputStepId: 'a', branches: [] } },
          { id: 'c', name: 'C', assignedMemberId: 'c', instructions: '', dependencyStepIds: ['a'], executor: { type: 'script', runtime: 'node', source: 'x', timeoutSeconds: 5 } },
          { id: 'd', name: 'D', assignedMemberId: 'd', instructions: '', dependencyStepIds: [], executor: { type: 'script', runtime: 'node', source: 'x', timeoutSeconds: 5 } },
          { id: 'e', name: 'E', assignedMemberId: 'e', instructions: '', dependencyStepIds: [], executor: { type: 'script', runtime: 'node', source: 'x', timeoutSeconds: 5 } },
        ] },
      },
      tasks: [
        { stepId: 'a', status: 'succeeded', revision: 1, resultData: { ok: true } },
        { stepId: 'b', status: 'succeeded', revision: 1, resultData: { selectedBranchIds: [] } },
        { stepId: 'c', status: 'succeeded', revision: 1 },
        { stepId: 'd', status: 'succeeded', revision: 1 },
        { stepId: 'e', status: 'failed', revision: 1, failure: { code: 'script-failed' } },
      ],
      messages: [], agentRequests: [],
    } as unknown as OrchestrationRunV6;
    const items = draftOutputs(run, [
      { stepId: 'a', data: { ok: true } },
      { stepId: 'c', issue: 'unavailable' },
      { stepId: 'd' },
    ], new Date('2026-09-27T10:00:00.123Z'));
    expect(items.map((item) => [item.stepId, item.reason])).toEqual([
      ['a', undefined],
      ['b', DRAFT_REASONS.notPinnable],
      ['c', DRAFT_REASONS.unavailable],
      ['d', DRAFT_REASONS.noOutput],
    ]);
    expect(items[0]?.pin).toEqual({ data: { ok: true }, pinnedAt: '2026-09-27T10:00:00Z', sourceRunId: 'run-1' });
  });

  it('labels the pinned-data option and the inspector section', () => {
    const option = render(PinnedRunOption, { props: { checked: true, steps: ['Plan', 'Collect'] } }).body;
    expect(option).toContain('Use pinned data (pinned steps don’t run)');
    expect(option).toMatch(/role="checkbox"[^>]*aria-checked="true"/);
    expect(option).toContain('Pinned: Plan, Collect.');
    expect(render(PinnedRunOption, { props: { checked: true, steps: [] } }).body).not.toContain('pinned steps');

    const node = { ...newGraphNode(0), pinnedOutput: PIN };
    const editor = new PipelineEditorStore('workspace', false, {} as OrchestrationClient);
    const markup = render(WithWorkspace, {
      props: {
        workspace: { catalog: { protocol: 15, safeMode: false, workspaces: [], sessions: [], harnesses: [] } },
        component: PinnedDataSection as unknown as Component<Record<string, unknown>>,
        props: { editor, node },
      },
    }).body;
    expect(markup).toMatch(/<section[^>]*aria-labelledby="pinned-title-[^"]+"/);
    expect(markup).toContain('From run #run1');
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="pinned-body-/);
    expect(markup).toContain('Unpin');
  });
});
