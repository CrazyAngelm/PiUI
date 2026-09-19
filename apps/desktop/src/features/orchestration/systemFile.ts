import validateV4 from '../../../../../contracts/system-file-v4-validator.mjs';
import validateV1 from '../../../../../contracts/system-file-v1-validator.mjs';
import validateV3 from '../../../../../contracts/system-file-v3-validator.mjs';
import validateV2 from '../../../../../contracts/system-file-v2-validator.mjs';
import type { AgentProfile, RouterConfig } from '../../../../../contracts/orchestration-v6';
import { profileConfigurationErrors } from '../../harness-adapters/validation';
import { compileGraph, emptyGraph, graphErrors, type AgentGraph, type GraphEdge } from './agentGraph';

export interface SystemFile {
  format: 'piui-system'; version: 1 | 2 | 3 | 4; name: string;
  orchestrator?: string; inheritTeamConnections?: boolean;
  agents: { id: string; kind?: 'agent' | 'router'; profile: Omit<AgentProfile, 'id' | 'allowedSpawnProfileIds'>; router?: RouterConfig; task: string; inputBindings?: import('../../../../../contracts/orchestration-v6').InputBinding[]; condition?: import('../../../../../contracts/orchestration-v6').ResultCondition; review?: import('../../../../../contracts/orchestration-v6').ReviewRule; requireApproval?: boolean; resultFields?: import('../../../../../contracts/orchestration-v6').ResultField[]; executionMode?: 'scheduled' | 'callable'; input?: string; position?: { x: number; y: number } }[];
  connections: GraphEdge[];
}
export function parseSystemFile(text: string): SystemFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON.'); }
  const validate = typeof data === 'object' && data !== null && 'version' in data && data.version === 1 ? validateV1 : typeof data === 'object' && data !== null && 'version' in data && data.version === 2 ? validateV2 : typeof data === 'object' && data !== null && 'version' in data && data.version === 3 ? validateV3 : validateV4;
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
    if (edge.kind === 'route' && !edge.branchId) errors.push('Route connections need a branch ID.');
    if (edge.kind !== 'route' && edge.branchId !== undefined) errors.push('Only route connections may contain a branch ID.');
    const key = JSON.stringify([edge.from, edge.to, edge.kind, edge.branchId ?? null]);
    if (edges.has(key)) errors.push('Duplicate connection.');
    edges.add(key);
  }
  for (const agent of value.agents) {
    errors.push(...profileConfigurationErrors(agent.id, agent.profile));
    if (agent.router && agent.kind !== 'router') errors.push(`${agent.id}: router configuration requires kind=router.`);
    if (agent.kind === 'router' && !agent.router) errors.push(`${agent.id}: kind=router requires router configuration.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  errors.push(...graphErrors(systemFileToGraph(value)));
  if (errors.length) throw new Error(errors.join('\n'));
  return value;
}

/** Import always creates a new draft; no existing definition IDs are overwritten. */
export function systemFileToGraph(file: SystemFile): AgentGraph {
  const graph = emptyGraph();
  const profiles = new Map(file.agents.map(agent => [agent.id, crypto.randomUUID()]));
  return { ...graph, name: file.name, orchestratorId: file.orchestrator ?? file.agents.find(agent => agent.kind !== 'router')?.id,
    spawnedAgentsJoinTeam: file.inheritTeamConnections,
    nodes: file.agents.map((agent, index) => ({ kind: agent.kind ?? 'agent', id: agent.id, task: agent.task, inputBindings: agent.inputBindings, condition: agent.condition, review: agent.review, requireApproval: agent.requireApproval, resultFields: agent.resultFields, executionMode: agent.executionMode, router: agent.router, input: agent.input, x: agent.position?.x ?? 60 + index * 280, y: agent.position?.y ?? 100,
      profile: { ...agent.profile, id: profiles.get(agent.id)!, allowedSpawnProfileIds: file.connections.filter(edge => edge.kind === 'spawn' && edge.from === agent.id).map(edge => profiles.get(edge.to)!) } })),
    edges: file.connections.map(edge => ({ ...edge })),
  };
}
export function graphToSystemFile(graph: AgentGraph): SystemFile {
  const definition = compileGraph(graph);
  return { format: 'piui-system', version: 4, name: graph.name,
    orchestrator: definition.team.orchestratorMemberId,
    ...(graph.spawnedAgentsJoinTeam !== undefined ? { inheritTeamConnections: graph.spawnedAgentsJoinTeam } : {}),
    agents: graph.nodes.map(node => {
      const { id: _id, allowedSpawnProfileIds: _spawn, ...profile } = node.profile;
      return { id: node.id, ...(node.kind && node.kind !== 'agent' ? { kind: node.kind } : {}), profile, ...(node.router ? { router: node.router } : {}), task: node.task, ...(node.inputBindings?.length ? { inputBindings: node.inputBindings } : {}), ...(node.condition ? { condition: node.condition } : {}), ...(node.review ? { review: node.review } : {}), ...(node.requireApproval ? { requireApproval: true } : {}), ...(node.resultFields?.length ? { resultFields: node.resultFields } : {}), ...(node.executionMode ? { executionMode: node.executionMode } : {}), ...(node.input !== undefined ? { input: node.input } : {}), position: { x: node.x, y: node.y } };
    }), connections: graph.edges.map(edge => ({ ...edge })),
  };
}
export function serializeSystemFile(graph: AgentGraph): string {
  const text = JSON.stringify(graphToSystemFile(graph), null, 2) + '\n';
  parseSystemFile(text);
  return text;
}
