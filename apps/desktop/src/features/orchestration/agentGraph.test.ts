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
