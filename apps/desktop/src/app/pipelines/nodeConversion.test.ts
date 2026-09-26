import { describe, expect, it } from 'vitest';
import {
  compileGraph,
  graphIssues,
  newGraphNode,
  newLlmNode,
  newRouterNode,
  newScriptNode,
  type AgentGraph,
  type GraphNode,
} from '../../features/orchestration/agentGraph';
import { EXECUTOR_ISSUES } from '../../host-api/stepExecutors';
import type { OrchestrationClient } from '../../host-api/orchestrationClient';
import { PipelineEditorStore } from './editorStore.svelte';
import { applyConversion, conversionContext, nodeType, planConversion, type ConversionContext } from './nodeConversion';

const context: ConversionContext = { agentHarness: 'codex', modelCallHarness: 'pi' };

function agent(index: number, name: string, patch: Partial<GraphNode> = {}): GraphNode {
  const node = newGraphNode(index);
  return { ...node, profile: { ...node.profile, name, model: 'gpt-5' }, task: `Work of ${name}`, ...patch };
}

function script(index: number, name: string, source: string): GraphNode {
  const node = newScriptNode(index);
  return {
    ...node,
    profile: { ...node.profile, name },
    executor: { type: 'script', runtime: 'python', source, timeoutSeconds: 30 },
  };
}

/** plan → writer → review, with the writer collaborating with a helper. */
function graph(): AgentGraph {
  const plan = agent(0, 'Plan', { resultFields: [{ name: 'files', kind: 'number' }] });
  const writer = agent(1, 'Writer', {
    input: 'A plan',
    inputBindings: [{ sourceStepId: plan.id, field: 'files', name: 'files' }],
    resultFields: [{ name: 'summary', kind: 'text' }],
    requireApproval: true,
  });
  writer.profile = {
    ...writer.profile,
    instructions: 'Write carefully.',
    expectedResult: 'A summary',
    permissionMode: 'workspace-write',
    networkAccess: true,
    toolPolicy: { rules: [{ tool: 'bash', decision: 'allow', enforcement: 'native', mandatory: false }] },
    resourceRules: [{ kind: 'skill', id: 'docs', enabled: true }],
  };
  const helper = agent(2, 'Helper', { executionMode: 'callable' });
  const review = agent(3, 'Review');
  return {
    id: 'graph', name: 'Graph', teamId: 'team', pipelineId: 'pipeline',
    nodes: [plan, writer, helper, review],
    edges: [
      { from: plan.id, to: writer.id, kind: 'result' },
      { from: writer.id, to: review.id, kind: 'result' },
      { from: writer.id, to: helper.id, kind: 'send' },
      { from: helper.id, to: writer.id, kind: 'send' },
      { from: review.id, to: writer.id, kind: 'observe' },
      { from: writer.id, to: helper.id, kind: 'spawn' },
    ],
  };
}

const byName = (value: AgentGraph, name: string): GraphNode => {
  const node = value.nodes.find((item) => item.profile.name === name);
  if (node === undefined) throw new Error(`No node ${name}`);
  return node;
};

describe('changing a node type', () => {
  it('lists what a model call cannot keep and converts the agent at least authority', () => {
    const before = graph();
    const writer = byName(before, 'Writer');
    const plan = planConversion(before, writer.id, 'llm', context);
    expect(plan?.needsConfirmation).toBe(true);
    expect(plan?.removedEdges.map((edge) => edge.kind).sort()).toEqual(['observe', 'send', 'send', 'spawn']);
    expect(plan?.removals).toEqual([
      { message: 'Sends messages to {0}', params: ['Helper'] },
      { message: 'Receives messages from {0}', params: ['Helper'] },
      { message: 'Is observed by {0}', params: ['Review'] },
      { message: 'May start instances of {0}', params: ['Helper'] },
      { message: 'File access becomes read-only' },
      { message: 'Network access is turned off' },
      { message: 'Tool rules ({0})', params: [1] },
      { message: 'Skills and MCP settings ({0})', params: [1] },
    ]);
    // Codex answers read-only itself, so the harness and model stay.
    expect(plan?.harness).toBeUndefined();
    expect(plan?.losses).toEqual([]);

    const after = applyConversion(before, plan!);
    const converted = byName(after, 'Writer');
    expect(converted.id).toBe(writer.id);
    expect([converted.x, converted.y]).toEqual([writer.x, writer.y]);
    expect(converted.executor).toEqual({ type: 'llm' });
    expect(converted.task).toBe(writer.task);
    expect(converted.inputBindings).toEqual(writer.inputBindings);
    expect(converted.resultFields).toEqual(writer.resultFields);
    expect(converted.requireApproval).toBe(true);
    expect(converted.profile).toMatchObject({ id: writer.profile.id, model: 'gpt-5', instructions: 'Write carefully.', permissionMode: 'read-only', toolPolicy: { rules: [] } });
    expect(converted.profile.networkAccess).toBeUndefined();
    expect(converted.profile.resourceRules).toBeUndefined();
    // Result connections stay; collaboration is gone, and the graph is valid again.
    expect(after.edges.map((edge) => edge.kind)).toEqual(['result', 'result']);
    expect(graphIssues(after)).toEqual([]);
  });

  it('moves a model call off a harness that cannot answer read-only', () => {
    const before = graph();
    const review = byName(before, 'Review');
    review.profile = { ...review.profile, harness: 'prime-agent', permissionMode: 'native' };
    const plan = planConversion(before, review.id, 'llm', context);
    expect(plan?.harness).toBe('pi');
    expect(plan?.losses).toEqual([
      { message: 'Harness {0} cannot answer read-only; it becomes {1} and the model is chosen again', params: ['Prime Agent', 'Pi'] },
    ]);
    const after = applyConversion(before, plan!, { model: 'pi-model', modelProvider: 'local' });
    expect(byName(after, 'Review').profile).toMatchObject({ harness: 'pi', model: 'pi-model', modelProvider: 'local', permissionMode: 'read-only' });
  });

  it('turns a callable agent into a scheduled model call and says so', () => {
    const before = graph();
    const helper = byName(before, 'Helper');
    helper.profile = { ...helper.profile, whenToCall: 'When a writer needs facts.' };
    const plan = planConversion(before, helper.id, 'llm', context);
    expect(plan?.removals).toContainEqual({ message: 'Runs only when another agent calls it; it will run in order instead' });
    expect(plan?.removals).toContainEqual({ message: 'May be started by {0}', params: ['Writer'] });
    expect(plan?.losses).toContainEqual({ message: 'When to call' });
    const converted = byName(applyConversion(before, plan!), 'Helper');
    expect(converted.executionMode).toBeUndefined();
    expect(converted.profile.whenToCall).toBeUndefined();
  });

  it('converts an agent into a script that keeps its result contract and discards agent data', () => {
    const before = graph();
    const writer = byName(before, 'Writer');
    const plan = planConversion(before, writer.id, 'script', context);
    expect(plan?.removals).toContainEqual({ message: 'Input mappings ({0})', params: [1] });
    expect(plan?.losses).toEqual([
      { message: 'Task' },
      { message: 'Role instructions' },
      { message: 'Expected input' },
      { message: 'Expected result' },
      { message: 'Harness and model: {0}', params: ['Codex · gpt-5'] },
      { message: 'Permissions, tools, skills and MCP settings' },
    ]);
    const after = applyConversion(before, plan!);
    const converted = byName(after, 'Writer');
    expect(converted.executor).toEqual({ type: 'script', runtime: 'node', source: '', timeoutSeconds: 60 });
    expect(converted.profile.model).toBe('script');
    expect(converted.task).toBe('');
    expect(converted.input).toBeUndefined();
    expect(converted.inputBindings).toBeUndefined();
    expect(converted.resultFields).toEqual(writer.resultFields);
    // A script is host work: it leaves the team, and only its missing code is a problem.
    expect(compileGraph(after).team.members.map((member) => member.id)).not.toContain(writer.id);
    expect(graphIssues(after)).toEqual([{ message: EXECUTOR_ISSUES.scriptSource, nodeIds: [writer.id] }]);
  });

  it('converts a script into an agent or model call and warns only when code is discarded', () => {
    const empty = newScriptNode(0);
    const withEmpty: AgentGraph = { id: 'g', name: 'G', teamId: 't', pipelineId: 'p', nodes: [empty], edges: [] };
    const quiet = planConversion(withEmpty, empty.id, 'agent', context);
    expect(quiet?.needsConfirmation).toBe(false);
    expect(quiet?.harness).toBe('codex');

    const code = script(0, 'Metrics', 'import json\nprint(json.dumps({}))\n');
    const withCode: AgentGraph = { ...withEmpty, nodes: [code] };
    const toAgent = planConversion(withCode, code.id, 'agent', context);
    expect(toAgent?.losses).toEqual([{ message: 'Script code ({0} lines)', params: [2] }]);
    const agentNode = byName(applyConversion(withCode, toAgent!, { model: 'gpt-5' }), 'Metrics');
    expect(agentNode.executor).toBeUndefined();
    expect(agentNode.profile).toMatchObject({ name: 'Metrics', harness: 'codex', model: 'gpt-5', permissionMode: 'read-only' });
    expect(agentNode.profile.id).not.toBe(code.profile.id);

    const toModelCall = planConversion(withCode, code.id, 'llm', context);
    expect(toModelCall?.harness).toBe('pi');
    const llmNode = byName(applyConversion(withCode, toModelCall!, { model: 'pi-model' }), 'Metrics');
    expect(llmNode.executor).toEqual({ type: 'llm' });
    expect(llmNode.profile).toMatchObject({ harness: 'pi', model: 'pi-model', permissionMode: 'read-only' });
  });

  it('keeps a model call whole when it becomes an agent and ignores routers', () => {
    const call = newLlmNode(0);
    call.profile = { ...call.profile, model: 'gpt-5' };
    call.task = 'Summarize.';
    const router = newRouterNode(1);
    const value: AgentGraph = { id: 'g', name: 'G', teamId: 't', pipelineId: 'p', nodes: [call, router], edges: [] };
    const plan = planConversion(value, call.id, 'agent', context);
    expect(plan?.needsConfirmation).toBe(false);
    const converted = applyConversion(value, plan!).nodes[0]!;
    expect(converted.executor).toBeUndefined();
    expect(converted.profile).toEqual(call.profile);
    expect(converted.task).toBe('Summarize.');
    expect(nodeType(router)).toBeUndefined();
    expect(planConversion(value, router.id, 'script', context)).toBeUndefined();
    expect(planConversion(value, call.id, 'llm', context)).toBeUndefined();
    expect(planConversion(value, 'missing', 'agent', context)).toBeUndefined();
  });

  it('picks harnesses from the native catalog statuses', () => {
    expect(conversionContext([])).toEqual({ agentHarness: 'codex', modelCallHarness: 'codex' });
    expect(conversionContext([
      { kind: 'prime-agent', status: 'available' },
      { kind: 'hermes', status: 'available' },
      { kind: 'claude-code', status: 'available' },
    ])).toEqual({ agentHarness: 'prime-agent', modelCallHarness: 'claude-code' });
    expect(conversionContext([{ kind: 'pi', status: 'missing' }, { kind: 'future-acp', status: 'available' }, { kind: 'pi', status: 'available' }]))
      .toEqual({ agentHarness: 'pi', modelCallHarness: 'pi' });
  });
});

describe('node conversion in the editor', () => {
  const client = {} as OrchestrationClient;

  it('is one undo step that re-runs the checks and restores everything on undo', () => {
    const editor = new PipelineEditorStore('workspace', false, client);
    const before = graph();
    editor.startFrom(before);
    const original = JSON.stringify(editor.graph);
    const writer = byName(editor.graph, 'Writer');
    editor.preflight = [{ nodeId: writer.id, message: 'The model is not in the catalog.' }];

    expect(editor.convertNode(writer.id, 'script', context)).toBe(true);
    expect(byName(editor.graph, 'Writer').executor?.type).toBe('script');
    expect(editor.graph.edges).toHaveLength(2);
    expect(editor.issues.map((issue) => issue.message)).toEqual([EXECUTOR_ISSUES.scriptSource]);
    expect(editor.preflight).toEqual([]);
    expect(editor.nodeProblems(writer.id)).toEqual([EXECUTOR_ISSUES.scriptSource]);

    editor.undo();
    expect(JSON.stringify(editor.graph)).toBe(original);
    editor.redo();
    expect(byName(editor.graph, 'Writer').executor?.type).toBe('script');
  });

  it('refuses to convert in safe mode or for the same type', () => {
    const safe = new PipelineEditorStore('workspace', true, client);
    safe.startFrom(graph());
    const writer = byName(safe.graph, 'Writer');
    expect(safe.convertNode(writer.id, 'script', context)).toBe(false);
    expect(byName(safe.graph, 'Writer').executor).toBeUndefined();
    const editor = new PipelineEditorStore('workspace', false, client);
    editor.startFrom(graph());
    expect(editor.convertNode(byName(editor.graph, 'Writer').id, 'agent', context)).toBe(false);
    expect(editor.canUndo).toBe(false);
  });
});
