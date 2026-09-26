import { describe, expect, it } from 'vitest';
import { compileGraph, emptyGraph, newGraphNode, newRouterNode, graphErrors, patternEdges, newLlmNode, newScriptNode, nodeHasNoMember } from './agentGraph';
import { EXECUTOR_ISSUES } from '../../host-api/stepExecutors';

describe('step executors in the agent graph (v6.2)', () => {
  function mixed() {
    const graph = emptyGraph(); graph.name = 'Mixed executors';
    const agent = newGraphNode(0), script = newScriptNode(1), llm = newLlmNode(2);
    agent.profile = { ...agent.profile, model: 'model' };
    llm.profile = { ...llm.profile, model: 'model' };
    if (script.executor?.type === 'script') script.executor = { ...script.executor, source: 'console.log(JSON.stringify({ ok: true }))' };
    graph.nodes = [agent, script, llm];
    graph.edges = [{ from: agent.id, to: script.id, kind: 'result' }, { from: script.id, to: llm.id, kind: 'result' }];
    return graph;
  }
  it('compiles a script as host work and a model call as a read-only member', () => {
    const graph = mixed();
    expect(graphErrors(graph)).toEqual([]);
    const [agent, script, llm] = graph.nodes;
    expect(nodeHasNoMember(script!)).toBe(true);
    const compiled = compileGraph(graph);
    expect(compiled.profiles.map(profile => profile.id)).toEqual([agent!.profile.id, llm!.profile.id]);
    expect(compiled.team.members.map(member => member.id)).toEqual([agent!.id, llm!.id]);
    expect(compiled.pipeline.steps[1]).toMatchObject({ id: script!.id, assignedMemberId: script!.id, name: 'Script 2', executor: script!.executor });
    expect(compiled.pipeline.steps[2]).toMatchObject({ executor: { type: 'llm' }, dependencyStepIds: [script!.id] });
    expect(compiled.profiles[1]!.permissionMode).toBe('read-only');
    expect(compiled.pipeline.steps[0]).not.toHaveProperty('executor');
  });
  it('reports every executor rule before saving instead of dropping settings', () => {
    const graph = mixed(); const [agent, script, llm] = graph.nodes;
    if (script!.executor?.type !== 'script') throw new Error('script');
    script!.executor = { ...script!.executor, source: ' ', timeoutSeconds: 0 };
    script!.inputBindings = [{ sourceStepId: agent!.id, field: 'x', name: 'y' }];
    llm!.profile = { ...llm!.profile, permissionMode: 'workspace-write', networkAccess: true, toolPolicy: { rules: [{ tool: 'shell', decision: 'allow', enforcement: 'advisory', mandatory: false }] } };
    graph.edges.push({ from: agent!.id, to: llm!.id, kind: 'send' }, { from: script!.id, to: agent!.id, kind: 'observe' });
    const errors = graphErrors(graph);
    for (const issue of [EXECUTOR_ISSUES.scriptSource, EXECUTOR_ISSUES.scriptTimeout, EXECUTOR_ISSUES.scriptBindings,
      EXECUTOR_ISSUES.noCollaboration, EXECUTOR_ISSUES.llmReadOnly, EXECUTOR_ISSUES.llmNetwork, EXECUTOR_ISSUES.llmTools]) {
      expect(errors).toContain(issue);
    }
    const callable = mixed(); callable.edges = [];
    callable.nodes[2]!.executionMode = 'callable';
    expect(graphErrors(callable)).toContain(EXECUTOR_ISSUES.notCallable);
    const router = mixed(); router.nodes[1]!.kind = 'router';
    expect(graphErrors(router)).toContain(EXECUTOR_ISSUES.notRouter);
    const scripts = mixed(); scripts.nodes = [scripts.nodes[1]!]; scripts.edges = [];
    expect(graphErrors(scripts)).toContain(EXECUTOR_ISSUES.needsMember);
  });
  it('needs no model for a script but does for a model call', () => {
    const graph = mixed();
    graph.nodes[1]!.profile = { ...graph.nodes[1]!.profile, model: '' };
    expect(graphErrors(graph)).toEqual([]);
    graph.nodes[2]!.profile = { ...graph.nodes[2]!.profile, model: '' };
    expect(graphErrors(graph)).toContain('Enter a name and model for every agent.');
  });
});
describe('agent graph', () => {
  function graph() { const graph = emptyGraph(); graph.name = 'Mixed'; graph.nodes = [newGraphNode(0), newGraphNode(1)]; graph.nodes.forEach(node => { node.profile = { ...node.profile, model: 'model' }; }); graph.nodes[1]!.profile = { ...graph.nodes[1]!.profile, harness: 'prime-agent', permissionMode: 'native', serviceTier: undefined }; return graph; }
  it('compiles cross-harness results independently from message permissions', () => {
    const value = graph(); value.edges = patternEdges(value.nodes, 'sequential');
    const compiled = compileGraph(value);
    expect(graphErrors(value)).toEqual([]);
    expect(compiled.profiles.map(profile => profile.harness)).toEqual(['codex', 'prime-agent']);
    expect(compiled.pipeline.steps[1]!.dependencyStepIds).toEqual([value.nodes[0]!.id]);
    expect(compiled.team.sendEdges).toEqual([]);
  });
  it('rejects result cycles and delegation to a stronger profile', () => {
    const value = graph(); const [a,b] = value.nodes;
    value.edges = [{ from:a!.id, to:b!.id, kind:'spawn' }];
    expect(graphErrors(value)).toContain('Child permissions must be the same or lower.');
    value.edges = [{ from:a!.id, to:b!.id, kind:'result' }, { from:b!.id, to:a!.id, kind:'result' }];
    expect(graphErrors(value)).toContain('Result connections must not form a cycle.');
  });
  it('allows message cycles without creating execution cycles', () => { const value = graph(); value.edges = patternEdges(value.nodes, 'peer'); expect(graphErrors(value)).toEqual([]); expect(compileGraph(value).team.sendEdges).toHaveLength(2); });
  it('compiles run inputs and a bounded review loop into the pipeline', () => {
    const value = graph(); const [writer, reviewer] = value.nodes;
    value.edges = patternEdges(value.nodes, 'sequential');
    writer!.task = 'Draft {{input.task}}';
    reviewer!.resultFields = [{ name: 'accepted', kind: 'boolean' }];
    reviewer!.review = { field: 'accepted', retryFromStepId: writer!.id, maxIterations: 3 };
    value.inputs = [
      { name: 'task', label: 'What should be reviewed?', kind: 'long-text', required: true },
      { name: 'depth', label: 'Depth', kind: 'choice', options: ['quick', 'deep'], defaultValue: 'quick' },
    ];
    expect(graphErrors(value)).toEqual([]);
    const compiled = compileGraph(value);
    expect(compiled.pipeline.inputs).toEqual(value.inputs);
    expect(compiled.pipeline.inputs).not.toBe(value.inputs);
    expect(compiled.pipeline.steps[0]!.instructions).toBe('Draft {{input.task}}');
    expect(compiled.pipeline.steps[1]!.review).toEqual({ field: 'accepted', retryFromStepId: writer!.id, maxIterations: 3 });
    value.inputs = [];
    expect('inputs' in compileGraph(value).pipeline).toBe(false);
    delete value.inputs;
    expect('inputs' in compileGraph(value).pipeline).toBe(false);
  });
  it('reports invalid run inputs and review loop limits before saving', () => {
    const value = graph(); const [writer, reviewer] = value.nodes;
    value.edges = patternEdges(value.nodes, 'sequential');
    reviewer!.resultFields = [{ name: 'accepted', kind: 'boolean' }];
    reviewer!.review = { field: 'accepted', retryFromStepId: writer!.id, maxIterations: 0 };
    value.inputs = [{ name: 'Task', label: '', kind: 'choice' }];
    expect(graphErrors(value)).toEqual([
      'A review loop limit must be a whole number from 1 to 20.',
      'Run input names must be unique, start with a lowercase letter and use only letters, digits and underscores (up to 64).',
      'Every run input needs a label of at most 120 characters.',
      'A choice input needs 1 to 50 unique, non-empty options; other inputs have none.',
    ]);
    reviewer!.review = { ...reviewer!.review, maxIterations: 21 };
    expect(graphErrors(value)).toContain('A review loop limit must be a whole number from 1 to 20.');
  });
  it('compiles a program router into labeled route gates without a native profile', () => {
    const value = emptyGraph(); value.name = 'Routed';
    const source = newGraphNode(0), router = newRouterNode(1), target = newGraphNode(2);
    source.profile = { ...source.profile, model: 'source-model' }; target.profile = { ...target.profile, model: 'target-model' };
    source.resultFields = [{ name: 'status', kind: 'text' }];
    const branches = router.router!.branches.map((branch, index) => ({ ...branch, label: `Status ${index}`, predicate: { op: 'equals' as const, field: 'status', value: index === 0 ? 'ready' : 'blocked' } }));
    router.router = { ...router.router!, inputStepId: source.id, branches };
    value.nodes = [source, router, target];
    value.edges = [{ from: source.id, to: router.id, kind: 'result' }, { from: router.id, to: target.id, kind: 'route', branchId: branches[0]!.id }];
    expect(graphErrors(value)).toEqual([]);
    const compiled = compileGraph(value);
    const routerStep = compiled.pipeline.steps.find(step => step.id === router.id)!;
    expect(compiled.profiles).toHaveLength(2);
    expect(routerStep.router?.mode).toBe('program');
    expect(routerStep.dependencyStepIds).toEqual([source.id]);
    expect(compiled.pipeline.steps.find(step => step.id === target.id)?.routeGates).toEqual([{ routerStepId: router.id, branchId: branches[0]!.id }]);
  });
});
