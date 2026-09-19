import { describe, expect, it } from 'vitest';
import { emptyGraph, newGraphNode, newRouterNode, compileGraph } from './agentGraph';
import { connectAgents, connectRoute, visibleConnections } from './graphConnections';

describe('graph connections', () => {
  const fixture = () => ({ ...emptyGraph(), nodes: [newGraphNode(0), newGraphNode(1), newGraphNode(2)] });
  it('persists two-way messaging as two native permissions without result dependencies', () => {
    const graph = fixture(), [a, b] = graph.nodes;
    graph.edges = connectAgents(graph, a!.id, b!.id, 'send', 'both').edges;
    expect(compileGraph(graph).team.sendEdges).toHaveLength(2);
    expect(compileGraph(graph).pipeline.steps.every(step => !step.dependencyStepIds.length)).toBe(true);
    expect(visibleConnections(graph.edges)).toEqual([{ from: a!.id, to: b!.id, kind: 'send', both: true, connections: graph.edges }]);
    expect(connectAgents(graph, a!.id, b!.id, 'send', 'both').edges).toEqual(graph.edges);
  });
  it('reverses the actual permission and retains distinct connection types', () => {
    const graph = fixture(), [a, b] = graph.nodes;
    graph.edges = connectAgents(graph, a!.id, b!.id, 'observe', 'reverse').edges;
    expect(compileGraph(graph).team.observeEdges).toEqual([{ fromMemberId: b!.id, toMemberId: a!.id }]);
    graph.edges = connectAgents(graph, a!.id, b!.id, 'send', 'forward').edges;
    const visible = visibleConnections(graph.edges);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.connections).toEqual(graph.edges);
    expect(visible[0]!.both).toBe(true);
  });
  it('rejects cycles and missing endpoints without changing existing connections', () => {
    const graph = fixture(), [a, b, c] = graph.nodes;
    graph.edges = connectAgents(graph, a!.id, b!.id, 'result', 'forward').edges;
    graph.edges = connectAgents(graph, b!.id, c!.id, 'result', 'forward').edges;
    for (const result of [connectAgents(graph, c!.id, a!.id, 'result', 'forward'), connectAgents(graph, a!.id, b!.id, 'result', 'both'), connectAgents(graph, 'missing', b!.id, 'send', 'forward')]) {
      expect(result.error).toBeTruthy();
      expect(result.edges).toBe(graph.edges);
    }
  });
  it('connects individual router branches and rejects route cycles', () => {
    const source = newGraphNode(0), router = newRouterNode(1), target = newGraphNode(2);
    router.router = { ...router.router!, inputStepId: source.id };
    const graph = { ...emptyGraph(), nodes: [source, router, target], edges: [{ from: source.id, to: router.id, kind: 'result' as const }] };
    const branch = router.router!.branches[0]!;
    const routed = connectRoute(graph, router.id, target.id, branch.id);
    expect(routed.error).toBeUndefined();
    expect(routed.edges.at(-1)).toEqual({ from: router.id, to: target.id, kind: 'route', branchId: branch.id });
    expect(connectRoute({ ...graph, edges: routed.edges }, router.id, source.id, branch.id).error).toContain('cycle');
  });
  it('keeps router result inputs singular and uses branch ports for router output', () => {
    const source = newGraphNode(0), alternate = newGraphNode(1), router = newRouterNode(2);
    router.router = { ...router.router!, inputStepId: source.id };
    const graph = { ...emptyGraph(), nodes: [source, alternate, router], edges: [{ from: source.id, to: router.id, kind: 'result' as const }] };
    expect(connectAgents(graph, alternate.id, router.id, 'result', 'forward').error).toContain('one direct result input');
    expect(connectAgents(graph, router.id, alternate.id, 'result', 'forward').error).toContain('branch routes');
  });
  it('keeps separate route branches visible even when they share a target', () => {
    const router = newRouterNode(0), target = newGraphNode(1);
    const [first, second] = router.router!.branches;
    const edges = [
      { from: router.id, to: target.id, kind: 'route' as const, branchId: first!.id },
      { from: router.id, to: target.id, kind: 'route' as const, branchId: second!.id },
    ];
    expect(visibleConnections(edges)).toHaveLength(2);
  });
});
