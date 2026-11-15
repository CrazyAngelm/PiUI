import type { AgentGraph } from '../../../features/orchestration/agentGraph';

export interface OutputConnections {
  /** Steps whose result a declared output returns. */
  declared: Set<string>;
  /** Final scheduled steps without a declared output: the pipeline ends after them. Canvas only, never saved. */
  completion: Set<string>;
  /** Every step wired to Output. */
  sources: Set<string>;
  /** No outputs are declared. */
  implicit: boolean;
}

/** Completion links never add dependencies or declare returned fields. */
export function outputConnections(graph: AgentGraph): OutputConnections {
  const outgoing = new Set(graph.edges.filter((edge) => edge.kind === 'result' || edge.kind === 'route').map((edge) => edge.from));
  const named = new Set(graph.outputs?.map((output) => output.sourceStepId));
  const declared = new Set(graph.nodes.filter((node) => named.has(node.id)).map((node) => node.id));
  const completion = new Set(
    graph.nodes.filter((node) => node.executionMode !== 'callable' && node.kind !== 'router' && !outgoing.has(node.id) && !declared.has(node.id)).map((node) => node.id),
  );
  return { declared, completion, sources: new Set([...declared, ...completion]), implicit: !graph.outputs?.length };
}
