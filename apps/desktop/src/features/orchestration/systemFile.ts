import validateV1 from '../../../../../contracts/system-file-v1-validator.mjs';
import validateV2 from '../../../../../contracts/system-file-v2-validator.mjs';
import type { AgentProfile } from '../../../../../contracts/orchestration-v4';
import { profileConfigurationErrors } from '../../harness-adapters/validation';
import { compileGraph, emptyGraph, graphErrors, type AgentGraph, type GraphEdge } from './agentGraph';

export interface SystemFile {
  format: 'piui-system'; version: 1 | 2; name: string;
  orchestrator?: string; inheritTeamConnections?: boolean;
  agents: { id: string; profile: Omit<AgentProfile, 'id' | 'allowedSpawnProfileIds'>; task: string; input?: string; position?: { x: number; y: number } }[];
  connections: GraphEdge[];
}
export function parseSystemFile(text: string): SystemFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON.'); }
  const validate = typeof data === 'object' && data !== null && 'version' in data && data.version === 1 ? validateV1 : validateV2;
  if (!validate(data)) throw new Error((validate.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`).join('\n'));
  const value = data as SystemFile;
  const errors: string[] = [];
  const ids = new Set(value.agents.map(agent => agent.id));
  if (ids.size !== value.agents.length) errors.push('Agent IDs must be unique.');
  if (value.orchestrator !== undefined && !ids.has(value.orchestrator)) errors.push('Unknown orchestrator.');
  const edges = new Set<string>();
  for (const edge of value.connections) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push('Connection references an unknown agent.');
    if (edge.from === edge.to && edge.kind !== 'spawn') errors.push('Only delegation may reference the same agent.');
    const key = JSON.stringify([edge.from, edge.to, edge.kind]);
    if (edges.has(key)) errors.push('Duplicate connection.');
    edges.add(key);
  }
  for (const { id, profile } of value.agents) errors.push(...profileConfigurationErrors(id, profile));
  if (errors.length) throw new Error(errors.join('\n'));
  errors.push(...graphErrors(systemFileToGraph(value)));
  if (errors.length) throw new Error(errors.join('\n'));
  return value;
}

/** Import always creates a new draft; no existing definition IDs are overwritten. */
export function systemFileToGraph(file: SystemFile): AgentGraph {
  const graph = emptyGraph();
  const profiles = new Map(file.agents.map(agent => [agent.id, crypto.randomUUID()]));
  return { ...graph, name: file.name, orchestratorId: file.orchestrator ?? file.agents[0]?.id,
    spawnedAgentsJoinTeam: file.inheritTeamConnections,
    nodes: file.agents.map((agent, index) => ({ id: agent.id, task: agent.task, input: agent.input, x: agent.position?.x ?? 60 + index * 280, y: agent.position?.y ?? 100,
      profile: { ...agent.profile, id: profiles.get(agent.id)!, allowedSpawnProfileIds: file.connections.filter(edge => edge.kind === 'spawn' && edge.from === agent.id).map(edge => profiles.get(edge.to)!) } })),
    edges: file.connections.map(edge => ({ ...edge })),
  };
}
export function graphToSystemFile(graph: AgentGraph): SystemFile {
  const definition = compileGraph(graph);
  return { format: 'piui-system', version: 2, name: graph.name,
    orchestrator: definition.team.orchestratorMemberId,
    ...(graph.spawnedAgentsJoinTeam !== undefined ? { inheritTeamConnections: graph.spawnedAgentsJoinTeam } : {}),
    agents: graph.nodes.map(node => {
      const { id: _id, allowedSpawnProfileIds: _spawn, ...profile } = node.profile;
      return { id: node.id, profile, task: node.task, ...(node.input !== undefined ? { input: node.input } : {}), position: { x: node.x, y: node.y } };
    }), connections: graph.edges.map(edge => ({ ...edge })),
  };
}
export function serializeSystemFile(graph: AgentGraph): string {
  const text = JSON.stringify(graphToSystemFile(graph), null, 2) + '\n';
  parseSystemFile(text);
  return text;
}
