import { describe, expect, it } from 'vitest';
import { compileGraph, emptyGraph, newGraphNode, newRouterNode, graphErrors, patternEdges } from './agentGraph';
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
