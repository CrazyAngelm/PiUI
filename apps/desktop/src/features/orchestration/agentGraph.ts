import type { AgentProfile, PipelineDefinition, TeamDefinition, LaunchCommandReference } from '../../../../../contracts/orchestration-v6';
export interface GraphNode { inputBindings?: import('../../../../../contracts/orchestration-v6').InputBinding[]; condition?: import('../../../../../contracts/orchestration-v6').ResultCondition; review?: import('../../../../../contracts/orchestration-v6').ReviewRule; requireApproval?: boolean; resultFields?: import('../../../../../contracts/orchestration-v6').ResultField[]; executionMode?: 'scheduled' | 'callable'; id: string; profile: AgentProfile; task: string; input?: string; x: number; y: number; }
export type ConnectionKind = 'result' | 'send' | 'observe' | 'spawn';
export interface GraphEdge { from: string; to: string; kind: ConnectionKind; }
export interface AgentGraph { id: string; name: string; teamId: string; pipelineId: string; orchestratorId?: string; spawnedAgentsJoinTeam?: boolean; nodes: GraphNode[]; edges: GraphEdge[]; }
export function emptyGraph(): AgentGraph { return { id: crypto.randomUUID(), name: '', teamId: crypto.randomUUID(), pipelineId: crypto.randomUUID(), nodes: [], edges: [] }; }
export function newGraphNode(index: number): GraphNode {
  return { id: crypto.randomUUID(), x: 60 + index * 280, y: 100, task: '', profile: {
    id: crypto.randomUUID(), name: `Agent ${index + 1}`, harness: 'codex', model: '', permissionMode: 'read-only', instructions: '', serviceTier: 'standard', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
  } };
}
export function permissionsSubset(parent: AgentProfile, child: AgentProfile): boolean {
  const ranks = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
  if (parent.permissionMode === 'native' || child.permissionMode === 'native') {
    if (parent.permissionMode !== child.permissionMode || parent.harness !== child.harness) return false;
  } else if (ranks[child.permissionMode] > ranks[parent.permissionMode]) return false;
  if (parent.toolPolicy.rules.some(rule => rule.decision === 'deny' && !child.toolPolicy.rules.some(candidate => candidate.tool === rule.tool && candidate.decision === 'deny' && candidate.enforcement === rule.enforcement && (!rule.mandatory || candidate.mandatory)))) return false;
  const nativeParent = parent.toolPolicy.rules.filter(rule => rule.enforcement === 'native');
  const nativeChild = child.toolPolicy.rules.filter(rule => rule.enforcement === 'native');
  if (nativeParent.length && (!nativeChild.length || nativeChild.some(rule => rule.decision === 'allow' && !nativeParent.some(candidate => candidate.tool === rule.tool && candidate.decision === 'allow')))) return false;
  if (parent.resourceRules?.some(rule => !rule.enabled && !child.resourceRules?.some(candidate => candidate.kind === rule.kind && candidate.id === rule.id && !candidate.enabled))) return false;
  return child.allowedSpawnProfileIds.every(id => parent.allowedSpawnProfileIds.includes(id));
}
export function compileGraph(graph: AgentGraph): { profiles: AgentProfile[]; team: TeamDefinition; pipeline: PipelineDefinition; command: LaunchCommandReference } {
  const profiles = graph.nodes.map(node => ({ ...node.profile, allowedSpawnProfileIds: graph.edges.filter(edge => edge.kind === 'spawn' && edge.from === node.id).map(edge => graph.nodes.find(target => target.id === edge.to)?.profile.id ?? '') }));
  return {
    profiles,
    team: { id: graph.teamId, name: graph.name, ...(graph.spawnedAgentsJoinTeam ? { spawnedAgentsJoinTeam: true } : {}), members: graph.nodes.map(node => ({ id: node.id, profileId: node.profile.id })), orchestratorMemberId: graph.nodes.some(node => node.id === graph.orchestratorId) ? graph.orchestratorId! : graph.nodes[0]?.id ?? '', sendEdges: graph.edges.filter(edge => edge.kind === 'send').map(edge => ({ fromMemberId: edge.from, toMemberId: edge.to })), observeEdges: graph.edges.filter(edge => edge.kind === 'observe').map(edge => ({ fromMemberId: edge.from, toMemberId: edge.to })) },
    pipeline: { id: graph.pipelineId, name: graph.name, steps: graph.nodes.map(node => ({ id: node.id, name: node.profile.name, assignedMemberId: node.id, instructions: node.task, ...(node.inputBindings?.length ? { inputBindings: node.inputBindings } : {}), ...(node.condition ? { condition: node.condition } : {}), ...(node.review ? { review: node.review } : {}), ...(node.requireApproval ? { requireApproval: true } : {}), ...(node.resultFields?.length ? { resultFields: node.resultFields } : {}), ...(node.executionMode ? { executionMode: node.executionMode } : {}), ...(node.input !== undefined ? { inputInstructions: node.input } : {}), dependencyStepIds: graph.edges.filter(edge => edge.kind === 'result' && edge.to === node.id).map(edge => edge.from) })) },
    command: { id: graph.id, name: graph.name, teamId: graph.teamId, pipelineId: graph.pipelineId },
  };
}
export function graphErrors(graph: AgentGraph): string[] {
  const errors: string[] = [];
  for (const node of graph.nodes) {
    const dependencies = graph.edges.filter(edge => edge.kind === 'result' && edge.to === node.id).map(edge => edge.from);
    const hasField = (id: string, field: string) => graph.nodes.find(source => source.id === id)?.resultFields?.some(item => item.name === field);
    if (node.condition && (!dependencies.includes(node.condition.sourceStepId) || !hasField(node.condition.sourceStepId, node.condition.field) || (typeof node.condition.equals === 'number' && !Number.isFinite(node.condition.equals)))) errors.push('A condition must select a declared field on a result dependency.');
    const bindings = node.inputBindings ?? [];
    if (new Set(bindings.map(binding => binding.name)).size !== bindings.length || bindings.some(binding => !binding.name.trim() || !dependencies.includes(binding.sourceStepId) || !hasField(binding.sourceStepId, binding.field))) errors.push('Input mappings need unique names and declared dependency fields.');
    if (node.review) {
      const visited = new Set<string>(); const pending = [...dependencies];
      while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...graph.edges.filter(edge => edge.kind === 'result' && edge.to === id).map(edge => edge.from)); }
      if (!visited.has(node.review.retryFromStepId) || !node.resultFields?.some(field => field.name === node.review?.field && field.kind === 'boolean')) errors.push('A review needs a boolean result field and an upstream correction task.');
    }
  }
  for (const node of graph.nodes) { const fields = node.resultFields ?? []; if (fields.some(field => !field.name.trim()) || new Set(fields.map(field => field.name)).size !== fields.length) errors.push('Result fields need unique non-empty names.'); }
  if (!graph.nodes.some(node => node.executionMode !== 'callable')) errors.push('Add a scheduled agent to start this system.');
  if (graph.edges.some(edge => edge.kind === 'result' && graph.nodes.some(node => node.executionMode === 'callable' && (node.id === edge.from || node.id === edge.to)))) errors.push('Callable agents exchange results through their caller, not pipeline dependencies.');
  if (!graph.name.trim() || !graph.nodes.length || graph.nodes.some(node => !node.profile.name.trim() || !node.profile.model.trim())) errors.push('Enter a name and model for every agent.');
  const definition = compileGraph(graph);
  if (definition.profiles.some(parent => parent.allowedSpawnProfileIds.some(id => { const child = definition.profiles.find(profile => profile.id === id); return !child || !permissionsSubset(parent, child); }))) errors.push('Child permissions must be the same or lower.');
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges.filter(edge => edge.kind === 'result')) { indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]); }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) { const id = ready.pop()!; visited++; for (const child of outgoing.get(id) ?? []) { const degree = (indegree.get(child) ?? 0) - 1; indegree.set(child, degree); if (!degree) ready.push(child); } }
  if (visited !== graph.nodes.length) errors.push('Result connections must not form a cycle.');
  return errors;
}
export function patternEdges(nodes: readonly GraphNode[], pattern: string): GraphEdge[] {
  const edges: GraphEdge[] = [];
  if (pattern === 'sequential') nodes.slice(1).forEach((node, index) => edges.push({ from: nodes[index]!.id, to: node.id, kind: 'result' }));
  if (pattern === 'supervisor' && nodes[0]) for (const node of nodes.slice(1)) {
    edges.push({ from: node.id, to: nodes[0].id, kind: 'result' });
    edges.push({ from: nodes[0].id, to: node.id, kind: 'observe' });
  }
  if (pattern === 'peer') for (const source of nodes) for (const target of nodes) if (source.id !== target.id) edges.push({ from: source.id, to: target.id, kind: 'send' });
  return edges;
}
