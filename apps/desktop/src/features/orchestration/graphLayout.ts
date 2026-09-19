import type { GraphEdge, GraphNode } from './agentGraph';

/** The canvas reserves a little more space than the visible card so long labels remain readable. */
export const GRAPH_NODE_WIDTH = 232;
export const GRAPH_NODE_HEIGHT = 132;
export const GRAPH_PORT_Y = 66;

export interface GraphBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DependencyLayout {
  nodes: GraphNode[];
  cycle: boolean;
  levels: number;
}

/** Return the occupied area of the editable graph in canvas coordinates. */
export function graphBounds(nodes: readonly GraphNode[], padding = 64): GraphBounds {
  if (!nodes.length) {
    return { left: padding, top: padding, right: padding + GRAPH_NODE_WIDTH, bottom: padding + GRAPH_NODE_HEIGHT, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT };
  }
  const left = Math.max(0, Math.min(...nodes.map((node) => node.x)) - padding);
  const top = Math.max(0, Math.min(...nodes.map((node) => node.y)) - padding);
  const right = Math.max(...nodes.map((node) => node.x + GRAPH_NODE_WIDTH)) + padding;
  const bottom = Math.max(...nodes.map((node) => node.y + GRAPH_NODE_HEIGHT)) + padding;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Calculate a readable zoom for the current canvas viewport. */
export function fitGraphZoom(nodes: readonly GraphNode[], viewportWidth: number, viewportHeight: number, padding = 48): number {
  if (!nodes.length || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  const bounds = graphBounds(nodes, padding);
  const width = Math.max(1, viewportWidth - padding * 2);
  const height = Math.max(1, viewportHeight - padding * 2);
  return Math.min(1.15, Math.min(width / bounds.width, height / bounds.height));
}

/**
 * Arrange only result dependencies into execution levels. Other connection kinds
 * are permissions and intentionally do not influence the execution order.
 */
export function arrangeResultDependencies(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): DependencyLayout {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'result' || !indegree.has(edge.from) || !indegree.has(edge.to) || edge.from === edge.to) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    visited += 1;
    for (const child of outgoing.get(id) ?? []) {
      levels.set(child, Math.max(levels.get(child) ?? 0, (levels.get(id) ?? 0) + 1));
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (visited !== nodes.length) return { nodes: [...nodes], cycle: true, levels: 0 };

  const columns = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  for (const column of columns.values()) column.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const arranged = nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const column = columns.get(level) ?? [node];
    const row = column.findIndex((candidate) => candidate.id === node.id);
    return { ...node, x: 80 + level * 320, y: 80 + Math.max(0, row) * 176 };
  });
  return { nodes: arranged, cycle: false, levels: Math.max(...levels.values(), 0) + 1 };
}
