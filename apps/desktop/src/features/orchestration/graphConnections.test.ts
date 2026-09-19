import { describe, expect, it } from 'vitest';
import { emptyGraph, newGraphNode, compileGraph } from './agentGraph';
import { connectAgents, visibleConnections } from './graphConnections';

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
});
