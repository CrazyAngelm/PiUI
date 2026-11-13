import dagre from '@dagrejs/dagre';
import type { AgentGraph, ConnectionKind } from './agentGraph';
import { graphNodeHeight } from './graphLayout';

export const NODE_WIDTH = 248;

export function syncRouterInputs(graph: AgentGraph): AgentGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'router' || !node.router) return node;
    const inputStepId = graph.edges.find((edge) => edge.kind === 'result' && edge.to === node.id)?.from ?? '';
    return node.router.inputStepId === inputStepId ? node : { ...node, router: { ...node.router, inputStepId } };
  });
  return { ...graph, nodes };
}

export function edgeKey(edge: { from: string; to: string; kind: ConnectionKind; branchId?: string }): string {
  return JSON.stringify([edge.from, edge.to, edge.kind, edge.branchId ?? null]);
}

/** Dagre layout of result and route edges, left to right; returns a new graph. */
export function autoLayout(graph: AgentGraph, heights: ReadonlyMap<string, number> = new Map()): AgentGraph {
  if (!graph.nodes.length) return graph;
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 96, marginx: 40, marginy: 40 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: NODE_WIDTH, height: heights.get(node.id) ?? graphNodeHeight(node) });
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'result' || edge.kind === 'route' || edge.kind === 'spawn') layout.setEdge(edge.from, edge.to);
  }
  dagre.layout(layout);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const placed = layout.node(node.id);
      return placed ? { ...node, x: Math.round(placed.x - NODE_WIDTH / 2), y: Math.round(placed.y - placed.height / 2) } : node;
    }),
  };
}
