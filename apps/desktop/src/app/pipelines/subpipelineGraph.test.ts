import { describe, expect, it } from 'vitest';
import {
  compileGraph, emptyGraph, graphIssues, newGraphNode, newSubpipelineNode, nodeHasNoMember, type AgentGraph, type GraphNode,
} from '../../features/orchestration/agentGraph';
import { subpipelineIssues } from '../../features/orchestration/graphPreflight';
import { serializeSystemFile, SYSTEM_FILE_SUBPIPELINES } from '../../features/orchestration/systemFile';
import { SUBPIPELINE_ISSUES, type PipelineExecutor, type SubpipelineInfo } from '../../host-api/subpipelines';
import { graphFromDefinitions } from './graphDocument';
import { nodeType } from './nodeConversion';

/** A saved-looking system: an agent whose result feeds a sub-pipeline step. */
function system(): AgentGraph {
  const agent = newGraphNode(0);
  agent.profile = { ...agent.profile, name: 'Planner', model: 'gpt-lab' };
  agent.resultFields = [{ name: 'summary', kind: 'text' }, { name: 'score', kind: 'number' }];
  const call = newSubpipelineNode(1, { commandId: 'child-command', name: 'Testing' }, [{ name: 'passed', kind: 'boolean' }]);
  call.executor = {
    type: 'pipeline',
    launchCommandId: 'child-command',
    inputs: { topic: { kind: 'step', stepId: agent.id, field: 'summary' }, retries: { kind: 'value', value: 2 }, task: { kind: 'input', name: 'task' } },
  };
  return {
    ...emptyGraph(),
    name: 'Development',
    inputs: [{ name: 'task', label: 'Task', kind: 'long-text', required: true }],
    outputs: [{ name: 'passed', kind: 'boolean', sourceStepId: call.id, field: 'passed' }, { name: 'plan', kind: 'text', sourceStepId: agent.id }],
    nodes: [agent, call],
    edges: [{ from: agent.id, to: call.id, kind: 'result' }],
  };
}

const child: SubpipelineInfo = {
  commandId: 'child-command',
  name: 'Testing',
  pipelineId: 'child-pipeline',
  inputs: [
    { name: 'topic', label: 'Topic', kind: 'text', required: true },
    { name: 'retries', label: 'Retries', kind: 'number' },
    { name: 'task', label: 'Task', kind: 'long-text' },
  ],
  outputs: [{ name: 'passed', kind: 'boolean', sourceStepId: 'check', field: 'passed' }],
  references: [],
};

describe('sub-pipeline steps in the graph', () => {
  it('compiles as host work and round-trips with the pipeline outputs', () => {
    const graph = system();
    const call = graph.nodes[1];
    expect(call && nodeHasNoMember(call)).toBe(true);
    expect(call && nodeType(call)).toBeUndefined();
    const definition = compileGraph(graph);
    // Not a team member and no saved profile.
    expect(definition.team.members.map((member) => member.id)).toEqual([graph.nodes[0]?.id]);
    expect(definition.profiles).toHaveLength(1);
    expect(definition.pipeline.outputs).toEqual(graph.outputs);
    const step = definition.pipeline.steps.find((item) => item.id === call?.id);
    expect(step?.executor).toEqual(call?.executor);
    expect(step?.resultFields).toEqual([{ name: 'passed', kind: 'boolean' }]);

    const reopened = graphFromDefinitions({
      command: definition.command,
      team: definition.team,
      pipeline: definition.pipeline,
      profiles: new Map(definition.profiles.map((profile) => [profile.id, profile])),
    });
    expect(reopened.outputs).toEqual(graph.outputs);
    expect(reopened.nodes.map((node) => node.executor)).toEqual(graph.nodes.map((node) => node.executor));
    expect(reopened.nodes[1]?.profile.name).toBe('Testing');
    expect(reopened.nodes[1]?.profile.model).toBe('pipeline');
    expect(reopened.edges).toEqual(graph.edges);
    expect(graphIssues(reopened)).toEqual([]);
  });

  it('reports the rules a sub-pipeline step shows by itself', () => {
    const graph = system();
    const call = graph.nodes[1];
    if (call?.executor?.type !== 'pipeline') throw new Error('No sub-pipeline step');
    const withExecutor = (executor: PipelineExecutor, patch: Partial<GraphNode> = {}): AgentGraph => ({
      ...graph,
      nodes: [graph.nodes[0]!, { ...call, ...patch, executor }],
    });
    const messages = (next: AgentGraph) => graphIssues(next).map((issue) => issue.message);
    expect(messages(withExecutor({ ...call.executor, launchCommandId: '' }))).toContain(SUBPIPELINE_ISSUES.command);
    expect(messages(withExecutor({ ...call.executor, launchCommandId: graph.id }))).toContain(SUBPIPELINE_ISSUES.self);
    expect(messages(withExecutor(call.executor, { inputBindings: [{ sourceStepId: graph.nodes[0]!.id, field: 'summary', name: 's' }] }))).toContain(SUBPIPELINE_ISSUES.bindings);
    expect(messages({ ...graph, edges: [] })).toContain(SUBPIPELINE_ISSUES.stepSource);
    expect(messages(withExecutor(call.executor, { executionMode: 'callable' }))).not.toEqual([]);
    expect(messages({ ...graph, outputs: [{ name: 'passed', kind: 'text', sourceStepId: call.id, field: 'passed' }] })).toContain(SUBPIPELINE_ISSUES.outputs);
  });

  it('checks references and mappings against the saved child', () => {
    const graph = system();
    const call = graph.nodes[1];
    if (call?.executor?.type !== 'pipeline') throw new Error('No sub-pipeline step');
    const messages = (next: AgentGraph, children: ReadonlyMap<string, SubpipelineInfo>, saved: ReadonlySet<string> | undefined) =>
      subpipelineIssues(next, children, saved).map((issue) => issue.message);
    const children = new Map([[child.commandId, child]]);
    expect(messages(graph, children, new Set(['child-command']))).toEqual([]);
    // Not loaded yet: nothing is claimed.
    expect(messages(graph, new Map(), undefined)).toEqual([]);
    expect(messages(graph, new Map(), new Set())).toEqual([SUBPIPELINE_ISSUES.missing]);
    // The child runs this pipeline again.
    expect(messages(graph, new Map([[child.commandId, { ...child, references: [graph.id] }]]), new Set(['child-command']))).toEqual([SUBPIPELINE_ISSUES.cycle]);
    const unmapped = { ...graph, nodes: [graph.nodes[0]!, { ...call, executor: { ...call.executor, inputs: {} } }] };
    expect(messages(unmapped, children, undefined)).toEqual([SUBPIPELINE_ISSUES.required]);
    const wrongValue = { ...graph, nodes: [graph.nodes[0]!, { ...call, executor: { ...call.executor, inputs: { ...call.executor.inputs, retries: { kind: 'value' as const, value: 'two' } } } }] };
    expect(messages(wrongValue, children, undefined)).toEqual([SUBPIPELINE_ISSUES.valueKind]);
    expect(subpipelineIssues(wrongValue, children, undefined)[0]?.nodeIds).toEqual([call.id]);
  });

  it('refuses to export a system file with sub-pipeline steps or outputs instead of dropping them', () => {
    const graph = system();
    expect(() => serializeSystemFile(graph)).toThrow(SYSTEM_FILE_SUBPIPELINES);
    const outputsOnly: AgentGraph = { ...graph, nodes: [graph.nodes[0]!], edges: [], outputs: [{ name: 'plan', kind: 'text', sourceStepId: graph.nodes[0]!.id }] };
    expect(() => serializeSystemFile(outputsOnly)).toThrow(SYSTEM_FILE_SUBPIPELINES);
    expect(() => serializeSystemFile({ ...outputsOnly, outputs: undefined })).not.toThrow();
  });
});
