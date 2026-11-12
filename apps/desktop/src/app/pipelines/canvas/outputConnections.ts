import type { AgentGraph } from '../../../features/orchestration/agentGraph';

/** Canvas-only completion links never add dependencies or declare returned fields. */
export function outputConnections(graph: AgentGraph): { sources: Set<string>; implicit: boolean } {
  const implicit = !graph.outputs?.length;
  const outgoing = new Set(graph.edges.filter((edge) => edge.kind === 'result' || edge.kind === 'route').map((edge) => edge.from));
  const declared = new Set(graph.outputs?.map((output) => output.sourceStepId));
  const sources = new Set(graph.nodes.filter((node) =>
    implicit
      ? node.executionMode !== 'callable' && node.kind !== 'router' && !outgoing.has(node.id)
      : declared.has(node.id),
  ).map((node) => node.id));
  return { sources, implicit };
}
