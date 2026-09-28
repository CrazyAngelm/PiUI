import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationClient, type OrchestrationCommandName } from '../../host-api/orchestrationClient';
import { labHost } from '../../host-api/lab/labTestKit';
import { formatIssue, SUBPIPELINE_ISSUE_TEMPLATES, SUBPIPELINE_ISSUES } from '../../host-api/subpipelines';
import { PipelineEditorStore } from './editorStore.svelte';
import { openGraph } from './graphDocument';

function lab() {
  const host = labHost();
  const client = createOrchestrationClient(
    <T>(route: OrchestrationCommandName, args: { request: unknown }) => host.invoke<T>(route, args),
    (handler) => host.listen('piui://orchestration-event', handler),
    (handler) => host.listen('piui://orchestration-schedule-event', handler),
  );
  const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
  return { host, client, workspaceId };
}

describe('sub-pipeline steps in the editor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a step for a saved pipeline, maps its inputs and saves them with the outputs', async () => {
    const { client, workspaceId } = lab();
    const editor = new PipelineEditorStore(workspaceId, false, client);
    await editor.refresh();
    const review = editor.systems.find((item) => item.name === 'Code review');
    const release = editor.systems.find((item) => item.name === 'Release check');
    expect(editor.subpipelines.get(review?.id ?? '')?.inputs.map((input) => input.name)).toEqual(['task']);

    editor.newGraph();
    editor.rename('Ship');
    const agentId = editor.addNode('agent', { x: 0, y: 0 });
    editor.updateProfile(agentId, { name: 'Planner', model: 'gpt-lab-5-mini', modelProvider: 'openai-lab' });
    const callId = editor.addSubpipelineNode(release?.id ?? '', { x: 300, y: 0 }) ?? '';
    const call = () => editor.graph.nodes.find((node) => node.id === callId);
    expect(call()?.profile.name).toBe('Release check');
    expect(call()?.executor).toEqual({ type: 'pipeline', launchCommandId: release?.id, inputs: {} });
    // The open pipeline is never offered as its own child.
    expect(editor.addSubpipelineNode(editor.graph.id, { x: 0, y: 0 })).toBeUndefined();

    // Pointing it at Code review: its required task has no default.
    editor.setSubpipeline(callId, review?.id ?? '');
    expect(call()?.profile.name).toBe('Code review');
    expect(editor.structuralIssues().map((issue) => issue.message)).toContain(SUBPIPELINE_ISSUES.required);
    const executor = call()?.executor;
    if (executor?.type !== 'pipeline') throw new Error('No sub-pipeline step');
    editor.updateNode(callId, { executor: { ...executor, inputs: { task: { kind: 'value', value: 'Review the release branch' } } } });
    editor.setOutputs([{ name: 'plan', kind: 'text', sourceStepId: agentId }]);
    expect(editor.structuralIssues()).toEqual([]);

    expect(await editor.save()).toBe(true);
    const reopened = await openGraph(client, workspaceId, editor.graph.id);
    expect(reopened.graph.outputs).toEqual([{ name: 'plan', kind: 'text', sourceStepId: agentId }]);
    expect(reopened.graph.nodes.find((node) => node.id === callId)?.executor).toEqual({
      type: 'pipeline', launchCommandId: review?.id, inputs: { task: { kind: 'value', value: 'Review the release branch' } },
    });
  });

  it('warns before a change to a pipeline breaks a saved pipeline that runs it, and refuses to save', async () => {
    const { client, workspaceId } = lab();
    const editor = new PipelineEditorStore(workspaceId, false, client);
    await editor.refresh();
    const review = editor.systems.find((item) => item.name === 'Code review');
    editor.newGraph();
    editor.rename('Ship');
    const agentId = editor.addNode('agent', { x: 0, y: 0 });
    editor.updateProfile(agentId, { name: 'Planner', model: 'gpt-lab-5-mini', modelProvider: 'openai-lab' });
    const callId = editor.addSubpipelineNode(review?.id ?? '', { x: 300, y: 0 }) ?? '';
    editor.updateNode(callId, { executor: { type: 'pipeline', launchCommandId: review?.id ?? '', inputs: { task: { kind: 'value', value: 'Review it' } } } });
    expect(await editor.save()).toBe(true);

    // Open Code review and drop the input Ship maps.
    editor.open(review?.id ?? '');
    await vi.waitFor(() => expect(editor.graph.id).toBe(review?.id));
    editor.setInputs([]);
    const broken = formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.breaksParent, '“Ship”');
    expect(editor.structuralIssues().map((issue) => issue.message)).toContain(broken);
    expect(await editor.save()).toBe(false);
    expect(editor.issues.map((issue) => issue.message)).toContain(broken);
    // The message is translated as its template, then filled in.
    const translated = editor.describeIssue(broken, (value) => (value === SUBPIPELINE_ISSUE_TEMPLATES.breaksParent ? 'RU {0}' : value));
    expect(translated).toBe('RU “Ship”');
  });

  it('imports a v5 file by pipeline name as a draft, and keeps an unknown name for the person to pick', async () => {
    const { client, workspaceId } = lab();
    const editor = new PipelineEditorStore(workspaceId, false, client);
    await editor.refresh();
    const release = editor.systems.find((item) => item.name === 'Release check');
    const saved = editor.systems.length;
    const file = (pipeline: string) => JSON.stringify({
      format: 'piui-system', version: 5, name: 'Imported',
      agents: [
        { id: 'plan', profile: { name: 'Planner', harness: 'codex', model: 'gpt-lab-5-mini', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] }, serviceTier: 'standard' }, task: 'Plan the release.' },
        { id: 'check', executor: { type: 'pipeline', pipeline }, profile: { name: 'Check', harness: 'codex', model: 'pipeline', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } }, task: '' },
      ],
      connections: [{ from: 'plan', to: 'check', kind: 'result' }],
    });

    editor.importText(file('release check'));
    await vi.waitFor(() => expect(editor.graph.name).toBe('Imported'));
    expect(editor.graph.nodes.find((node) => node.id === 'check')?.executor).toEqual({ type: 'pipeline', launchCommandId: release?.id, inputs: {} });
    const exported = JSON.parse(await editor.exportText());
    expect(exported.agents[1].executor).toEqual({ type: 'pipeline', pipeline: 'Release check', inputs: {} });

    editor.importText(file('Nightly build'));
    await vi.waitFor(() => expect(editor.graph.nodes.find((node) => node.id === 'check')?.pipelineName).toBe('Nightly build'));
    const missing = formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.unresolved, 'Nightly build');
    // Shown at once, blocks saving, and nothing was created in the project.
    expect(editor.issues.map((issue) => issue.message)).toContain(missing);
    expect(await editor.save()).toBe(false);
    await editor.refresh();
    expect(editor.systems).toHaveLength(saved);
    // Picking a pipeline resolves the step.
    editor.setSubpipeline('check', release?.id ?? '');
    expect(editor.graph.nodes.find((node) => node.id === 'check')?.pipelineName).toBeUndefined();
    expect(editor.structuralIssues().map((issue) => issue.message)).not.toContain(missing);
  });
});
