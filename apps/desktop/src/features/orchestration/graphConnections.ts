import type { AgentGraph, ConnectionKind, GraphEdge } from './agentGraph';

export type ConnectionDirection = 'forward' | 'reverse' | 'both';
export function connectAgents(graph: AgentGraph, from: string, to: string, kind: ConnectionKind, direction: ConnectionDirection): { edges: GraphEdge[]; error?: string } {
  const reject = (error: string) => ({ edges: graph.edges, error });
  if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to)) return reject('Choose two agents.');
  if (from === to && kind !== 'spawn') return reject('Choose two different agents.');
  if (kind === 'result' && direction === 'both') return reject('Result connections must not form a cycle.');
  const candidates: GraphEdge[] = direction === 'reverse' ? [{ from: to, to: from, kind }] : [{ from, to, kind }];
  if (direction === 'both' && from !== to) candidates.push({ from: to, to: from, kind });
  const edges = [...graph.edges];
  for (const edge of candidates) {
    if (edges.some(item => item.from === edge.from && item.to === edge.to && item.kind === kind)) continue;
    if (kind === 'result') {
      const source = graph.nodes.find(node => node.id === edge.from);
      const target = graph.nodes.find(node => node.id === edge.to);
      if (source?.kind === 'router') return reject('A router exposes branch routes, not a result output.');
      if (target?.kind === 'router' && edges.some(item => item.kind === 'result' && item.to === edge.to && item.from !== edge.from)) return reject('A router needs one direct result input.');
      if (graph.nodes.some(node => (node.id === edge.from || node.id === edge.to) && node.executionMode === 'callable')) return reject('Callable agents exchange results through their caller, not pipeline dependencies.');
      const pending = [edge.to], seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (id === edge.from) return reject('Result connections must not form a cycle.');
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...edges.filter(item => item.kind === 'result' && item.from === id).map(item => item.to));
      }
    }
    edges.push(edge);
  }
  return { edges };
}

export function connectRoute(graph: AgentGraph, routerId: string, targetId: string, branchId: string): { edges: GraphEdge[]; error?: string } {
  const reject = (error: string) => ({ edges: graph.edges, error });
  const router = graph.nodes.find(node => node.id === routerId);
  const target = graph.nodes.find(node => node.id === targetId);
  if (!router || !target || router.kind !== 'router' || target.kind === 'router') return reject('Route connections need a router and an agent target.');
  if (!router.router?.branches.some(branch => branch.id === branchId)) return reject('Choose a declared router branch.');
  if (routerId === targetId) return reject('Choose a different route target.');
  if (graph.edges.some(edge => edge.kind === 'route' && edge.from === routerId && edge.to === targetId && edge.branchId === branchId)) return { edges: graph.edges };
  const pending = [targetId]; const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === routerId) return reject('Result and route connections must not form a cycle.');
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...graph.edges.filter(edge => (edge.kind === 'result' || edge.kind === 'route') && edge.from === id).map(edge => edge.to));
  }
  return { edges: [...graph.edges, { from: routerId, to: targetId, kind: 'route', branchId }] };
}

export function visibleConnections(edges: readonly GraphEdge[]): (GraphEdge & { both: boolean; connections: GraphEdge[] })[] {
  const groups: (GraphEdge & { both: boolean; connections: GraphEdge[] })[] = [];
  for (const edge of edges) {
    const group = edge.kind === 'route' ? undefined : groups.find(item => item.kind !== 'route' && ((item.from === edge.from && item.to === edge.to) || (item.from === edge.to && item.to === edge.from)));
    if (!group) groups.push({ ...edge, both: false, connections: [edge] });
    else {
      group.connections.push(edge);
      if (edge.from !== edge.to && edge.from === group.to) group.both = true;
      if (edge.kind === 'result') group.kind = 'result';
    }
  }
  return groups;
}
