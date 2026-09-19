import { describe, expect, it } from 'vitest';
import { emptyGraph, newGraphNode } from './agentGraph';
import { arrangeResultDependencies, fitGraphZoom, graphBounds } from './graphLayout';

describe('graph layout', () => {
  it('places result dependencies in stable execution levels', () => {
    const graph = { ...emptyGraph(), nodes: [newGraphNode(0), newGraphNode(1), newGraphNode(2)] };
    const [first, second, third] = graph.nodes;
    const result = arrangeResultDependencies(graph.nodes, [
      { from: first!.id, to: third!.id, kind: 'result' },
      { from: second!.id, to: third!.id, kind: 'send' },
    ]);
    expect(result.cycle).toBe(false);
    expect(result.levels).toBe(2);
    expect(result.nodes.find((node) => node.id === first!.id)?.x).toBe(80);
    expect(result.nodes.find((node) => node.id === third!.id)?.x).toBe(400);
    expect(result.nodes.find((node) => node.id === second!.id)?.x).toBe(80);
  });

  it('preserves positions when result dependencies contain a cycle', () => {
    const graph = { ...emptyGraph(), nodes: [newGraphNode(0), newGraphNode(1)] };
    const [first, second] = graph.nodes;
    const edges = [
      { from: first!.id, to: second!.id, kind: 'result' as const },
      { from: second!.id, to: first!.id, kind: 'result' as const },
    ];
    const result = arrangeResultDependencies(graph.nodes, edges);
    expect(result.cycle).toBe(true);
    expect(result.nodes).toEqual(graph.nodes);
  });

  it('calculates a bounded fit zoom from the graph bounds', () => {
    const graph = { ...emptyGraph(), nodes: [newGraphNode(0), newGraphNode(1)] };
    graph.nodes[0]!.x = 100;
    graph.nodes[0]!.y = 120;
    graph.nodes[1]!.x = 900;
    graph.nodes[1]!.y = 520;
    const bounds = graphBounds(graph.nodes);
    expect(bounds.width).toBeGreaterThan(1000);
    expect(fitGraphZoom(graph.nodes, 800, 600)).toBeLessThan(1);
    expect(fitGraphZoom(graph.nodes, 320, 240)).toBeLessThan(0.45);
    expect(fitGraphZoom([], 800, 600)).toBe(1);
  });

  it('places routed targets after their router', () => {
    const router = { ...newGraphNode(0), kind: 'router' as const };
    const target = newGraphNode(1);
    const result = arrangeResultDependencies([router, target], [{ from: router.id, to: target.id, kind: 'route', branchId: 'ready' }]);
    expect(result.cycle).toBe(false);
    expect(result.nodes.find((node) => node.id === target.id)?.x).toBeGreaterThan(router.x);
  });
});
