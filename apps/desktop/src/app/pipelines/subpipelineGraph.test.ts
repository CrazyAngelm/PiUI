import { describe, expect, it } from 'vitest';
import {
  compileGraph, emptyGraph, graphIssues, newGraphNode, newSubpipelineNode, nodeHasNoMember, type AgentGraph, type GraphNode,
} from '../../features/orchestration/agentGraph';
import { parentIssues, subpipelineIssues } from '../../features/orchestration/graphPreflight';
import { serializeSystemFile, SYSTEM_FILE_UNNAMED_PIPELINE } from '../../features/orchestration/systemFile';
import type { PipelineStep } from '../../host-api/orchestrationClient';
import {
  formatIssue, parentBreakage, SUBPIPELINE_ISSUE_TEMPLATES, SUBPIPELINE_ISSUES, type PipelineExecutor, type SubpipelineInfo,
} from '../../host-api/subpipelines';
import { graphFromTemplate, templateSystem } from '../chatPipelines/templateLibrary';
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

  it('exports sub-pipeline steps by pipeline name and outputs by agent id (system-file v5)', () => {
    const graph = system();
    const call = graph.nodes[1]!;
    const agent = graph.nodes[0]!;
    const file = JSON.parse(serializeSystemFile(graph, [{ id: 'child-command', name: 'Testing' }]));
    expect(file.version).toBe(5);
    expect(file.agents[1].executor).toEqual({
      type: 'pipeline',
      pipeline: 'Testing',
      inputs: { topic: { kind: 'step', agent: agent.id, field: 'summary' }, retries: { kind: 'value', value: 2 }, task: { kind: 'input', name: 'task' } },
    });
    expect(file.outputs).toEqual([{ name: 'passed', kind: 'boolean', agent: call.id, field: 'passed' }, { name: 'plan', kind: 'text', agent: agent.id }]);
    // Without the project's names the pipeline cannot be named: refused, never dropped.
    expect(() => serializeSystemFile(graph)).toThrow(SYSTEM_FILE_UNNAMED_PIPELINE);
  });

  it('saves a template with sub-pipelines and opens it resolved against the project', () => {
    const graph = system();
    const names = [{ id: 'child-command', name: 'Testing' }];
    const document = templateSystem(graph, names);
    expect(document.version).toBe(5);
    const opened = graphFromTemplate({ system: document, name: 'Development' }, [{ id: 'other-project-command', name: 'Testing' }]);
    expect(opened.nodes[1]?.executor).toMatchObject({ type: 'pipeline', launchCommandId: 'other-project-command' });
    expect(opened.outputs).toEqual(graph.outputs);
    // A project without that pipeline keeps the name for the person to pick.
    expect(graphFromTemplate({ system: document, name: 'Development' }).nodes[1]?.pipelineName).toBe('Testing');
  });

  it('reports saved parents a change of inputs or outputs would break, by name', () => {
    // The draft is the child; a saved parent runs it with a mapping and result fields.
    const draft: AgentGraph = {
      ...emptyGraph(),
      name: 'Testing',
      inputs: [{ name: 'topic', label: 'Topic', kind: 'text' }],
      outputs: [{ name: 'passed', kind: 'boolean', sourceStepId: 'check', field: 'passed' }],
    };
    const parentStep = (patch: Partial<PipelineStep> = {}): PipelineStep => ({
      id: 'call', name: 'Testing', assignedMemberId: 'call', instructions: '', dependencyStepIds: [],
      executor: { type: 'pipeline', launchCommandId: draft.id, inputs: { topic: { kind: 'value', value: 'release' } } },
      resultFields: [{ name: 'passed', kind: 'boolean' }],
      ...patch,
    });
    const info = (name: string, step: PipelineStep, references = [draft.id]): SubpipelineInfo => ({
      commandId: `cmd-${name}`, name, pipelineId: `pipe-${name}`, inputs: [], outputs: [], references, pipeline: { steps: [step], inputs: [] },
    });
    const saved = new Map([
      ['cmd-Ship', info('Ship', parentStep())],
      ['cmd-Nightly', info('Nightly', parentStep({ executor: { type: 'pipeline', launchCommandId: draft.id, inputs: {} }, resultFields: [] }))],
    ]);
    expect(parentIssues(draft, saved)).toEqual([]);
    // Renaming the input breaks Ship's mapping and leaves the new required input unmapped in both.
    const renamed = { ...draft, inputs: [{ name: 'subject', label: 'Subject', kind: 'text' as const, required: true }] };
    const [issue] = parentIssues(renamed, saved);
    expect(issue?.message).toBe(formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.breaksParent, '“Ship”, “Nightly”'));
    expect(issue?.nodeIds).toEqual([]);
    // A number output where Ship declares a boolean field breaks Ship only.
    const retyped = { ...draft, outputs: [{ name: 'passed', kind: 'number' as const, sourceStepId: 'check', field: 'score' }] };
    expect(parentIssues(retyped, saved)[0]?.message).toBe(formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.breaksParent, '“Ship”'));
    // Without outputs the step receives the last step's text: fields are not checked.
    expect(parentIssues({ ...draft, outputs: undefined }, saved)).toEqual([]);
    // A new optional input or an extra output breaks nobody.
    const grown = {
      ...draft,
      inputs: [...(draft.inputs ?? []), { name: 'depth', label: 'Depth', kind: 'number' as const }],
      outputs: [...(draft.outputs ?? []), { name: 'report', kind: 'text' as const, sourceStepId: 'check' }],
    };
    expect(parentIssues(grown, saved)).toEqual([]);
    // A parent that did not fit the saved version either is not blamed on this draft.
    const savedDraft: SubpipelineInfo = {
      commandId: draft.id, name: 'Testing', pipelineId: draft.pipelineId, inputs: renamed.inputs, outputs: draft.outputs ?? [], references: [],
    };
    expect(parentIssues(renamed, new Map([...saved, [draft.id, savedDraft]]))).toEqual([]);
    // Pipelines that do not run the draft, or were not read yet, are not reported.
    const unrelated = new Map([['cmd-Other', info('Other', parentStep(), [])], ['cmd-Unknown', { ...info('Unknown', parentStep()), pipeline: undefined }]]);
    expect(parentIssues(renamed, unrelated)).toEqual([]);
  });

  it('checks a parent with the same rule the host uses', () => {
    const parent = {
      commandId: 'cmd-parent', name: 'Parent',
      pipeline: {
        inputs: [{ name: 'task', label: 'Task', kind: 'text' as const }],
        steps: [{
          id: 'call', name: 'Child', assignedMemberId: 'call', instructions: '', dependencyStepIds: [],
          executor: { type: 'pipeline' as const, launchCommandId: 'cmd-child', inputs: { goal: { kind: 'input' as const, name: 'task' } } },
        }],
      },
    };
    const text = { inputs: [{ name: 'goal', label: 'Goal', kind: 'long-text' as const }], outputs: [] };
    const number = { inputs: [{ name: 'goal', label: 'Goal', kind: 'number' as const }], outputs: [] };
    expect(parentBreakage(['cmd-child'], text, [parent])).toEqual([]);
    expect(parentBreakage(['cmd-child'], number, [parent])).toEqual([parent]);
    expect(parentBreakage(['cmd-child'], number, [parent], text)).toEqual([parent]);
    // A step that did not fit the saved version either is not blamed on this change.
    expect(parentBreakage(['cmd-child'], number, [parent], { inputs: [], outputs: [] })).toEqual([]);
    expect(parentBreakage(['cmd-other'], number, [parent])).toEqual([]);
  });
});
