import type { AgentProfile, PipelineDefinition, PipelineInput, TeamDefinition, LaunchCommandReference, RouterConfig, RouterBranch, RouterPredicate, StepExecutor } from '../../../../../contracts/orchestration-v6';
import { pipelineInputIssues, reviewLimitValid, RUN_INPUT_ISSUES } from '../../host-api/runInputs';
import { EXECUTOR_ISSUES, SCRIPT_RUNTIMES, scriptSourceValid, scriptTimeoutValid } from '../../host-api/stepExecutors';
/**
 * `executor` (v6.2) selects a native agent (absent), a single model call
 * (`llm`) or a host-run `script`. A script node has no team member: like a
 * program router it carries a placeholder profile whose name is the step
 * name and which is never saved.
 */
export interface GraphNode { kind?: 'agent' | 'router'; executor?: StepExecutor; inputBindings?: import('../../../../../contracts/orchestration-v6').InputBinding[]; condition?: import('../../../../../contracts/orchestration-v6').ResultCondition; review?: import('../../../../../contracts/orchestration-v6').ReviewRule; requireApproval?: boolean; resultFields?: import('../../../../../contracts/orchestration-v6').ResultField[]; executionMode?: 'scheduled' | 'callable'; id: string; profile: AgentProfile; router?: RouterConfig; task: string; input?: string; x: number; y: number; }
export type ConnectionKind = 'result' | 'send' | 'observe' | 'spawn' | 'route';
export interface GraphEdge { from: string; to: string; kind: ConnectionKind; branchId?: string; }
/** `inputs` are the pipeline's run inputs (v6.1): values requested when a run starts. */
export interface AgentGraph { id: string; name: string; teamId: string; pipelineId: string; orchestratorId?: string; spawnedAgentsJoinTeam?: boolean; inputs?: PipelineInput[]; nodes: GraphNode[]; edges: GraphEdge[]; }
export function emptyGraph(): AgentGraph { return { id: crypto.randomUUID(), name: '', teamId: crypto.randomUUID(), pipelineId: crypto.randomUUID(), nodes: [], edges: [] }; }
export function newGraphNode(index: number): GraphNode {
  return { kind: 'agent', id: crypto.randomUUID(), x: 60 + index * 280, y: 100, task: '', profile: {
    id: crypto.randomUUID(), name: `Agent ${index + 1}`, harness: 'codex', model: '', permissionMode: 'read-only', instructions: '', serviceTier: 'standard', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
  } };
}
export function newRouterNode(index: number): GraphNode {
  const node = newGraphNode(index);
  const branch = (branchIndex: number): RouterBranch => ({ id: crypto.randomUUID(), label: `Route ${branchIndex + 1}`, predicate: { op: 'equals', field: '', value: '' } });
  return { ...node, kind: 'router', task: 'Choose which routes should continue.', profile: { ...node.profile, name: `Router ${index + 1}`, model: 'router' }, router: { mode: 'program', inputStepId: '', branches: [branch(0), branch(1)] } };
}
/** A single model call: one read-only native turn without collaboration. */
export function newLlmNode(index: number): GraphNode {
  const node = newGraphNode(index);
  return { ...node, executor: { type: 'llm' }, profile: { ...node.profile, name: `Model call ${index + 1}`, permissionMode: 'read-only' } };
}
/** A host-run script; its placeholder profile only carries the step name. */
export function newScriptNode(index: number): GraphNode {
  const node = newGraphNode(index);
  return { ...node, executor: { type: 'script', runtime: 'node', source: '', timeoutSeconds: 60 }, profile: placeholderProfile(`Script ${index + 1}`, 'script') };
}
/** The unsaved profile of a node without a team member (program router or script). */
export function placeholderProfile(name: string, model: 'router' | 'script'): AgentProfile {
  return { id: crypto.randomUUID(), name, harness: 'codex', model, permissionMode: 'read-only', instructions: '', serviceTier: 'standard', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] };
}
/** Program routers are coordinator work and scripts are host work: neither is a team member. */
export function nodeHasNoMember(node: Pick<GraphNode, 'kind' | 'router' | 'executor'>): boolean {
  return (node.kind === 'router' && node.router?.mode === 'program') || node.executor?.type === 'script';
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
  const executionNodes = graph.nodes.filter(node => !nodeHasNoMember(node));
  const executionIds = new Set(executionNodes.map(node => node.id));
  const profiles = executionNodes.map(node => ({ ...node.profile, allowedSpawnProfileIds: graph.edges.filter(edge => edge.kind === 'spawn' && edge.from === node.id && executionIds.has(edge.to)).map(edge => graph.nodes.find(target => target.id === edge.to)?.profile.id ?? '') }));
  const steps = graph.nodes.map(node => {
    const routeEdges = graph.edges.filter(edge => edge.kind === 'route' && edge.to === node.id);
    const dependencies = [...graph.edges.filter(edge => edge.kind === 'result' && edge.to === node.id).map(edge => edge.from), ...routeEdges.map(edge => edge.from)];
    const router = node.kind === 'router' ? node.router : undefined;
    const resultFields = router?.mode === 'agent'
      ? [...(node.resultFields ?? []).filter(field => field.name !== (router.selectionField ?? 'selectedBranchIds')), { name: router.selectionField ?? 'selectedBranchIds', kind: 'text-list' as const }]
      : node.resultFields;
    return { id: node.id, name: node.profile.name, assignedMemberId: node.id, instructions: node.task,
      ...(node.inputBindings?.length ? { inputBindings: node.inputBindings } : {}), ...(node.condition ? { condition: node.condition } : {}),
      ...(routeEdges.length ? { routeGates: routeEdges.map(edge => ({ routerStepId: edge.from, branchId: edge.branchId ?? '' })) } : {}),
      ...(router ? { router } : {}), ...(node.review ? { review: node.review } : {}), ...(node.requireApproval ? { requireApproval: true } : {}),
      ...(resultFields?.length ? { resultFields } : {}), ...(node.executionMode ? { executionMode: node.executionMode } : {}),
      ...(node.executor ? { executor: node.executor } : {}),
      ...(node.input !== undefined ? { inputInstructions: node.input } : {}), dependencyStepIds: [...new Set(dependencies)] };
  });
  return {
    profiles,
    team: { id: graph.teamId, name: graph.name, ...(graph.spawnedAgentsJoinTeam ? { spawnedAgentsJoinTeam: true } : {}), members: executionNodes.map(node => ({ id: node.id, profileId: node.profile.id })), orchestratorMemberId: graph.orchestratorId && executionIds.has(graph.orchestratorId) ? graph.orchestratorId : executionNodes[0]?.id ?? '', sendEdges: graph.edges.filter(edge => edge.kind === 'send' && executionIds.has(edge.from) && executionIds.has(edge.to)).map(edge => ({ fromMemberId: edge.from, toMemberId: edge.to })), observeEdges: graph.edges.filter(edge => edge.kind === 'observe' && executionIds.has(edge.from) && executionIds.has(edge.to)).map(edge => ({ fromMemberId: edge.from, toMemberId: edge.to })) },
    pipeline: { id: graph.pipelineId, name: graph.name, steps, ...(graph.inputs?.length ? { inputs: graph.inputs.map(input => ({ ...input })) } : {}) },
    command: { id: graph.id, name: graph.name, teamId: graph.teamId, pipelineId: graph.pipelineId },
  };
}
export interface GraphIssue { message: string; nodeIds: string[] }
export function graphErrors(graph: AgentGraph): string[] { return graphIssues(graph).map(issue => issue.message); }
export function graphIssues(graph: AgentGraph): GraphIssue[] {
  const errors: GraphIssue[] = [];
  const push = (message: string, nodeIds: string[] = []) => errors.push({message,nodeIds});
  const isRouter = (node: GraphNode): boolean => node.kind === 'router';
  const agentNodes = graph.nodes.filter(node => node.kind !== 'router' || node.router?.mode === 'agent');
  const predicateValid = (predicate: RouterPredicate, fields: readonly { name: string; kind: string }[]): boolean => {
    const fieldName = predicate.op === 'equals' || predicate.op === 'exists' ? predicate.field : '';
    const field = fields.find(candidate => candidate.name === fieldName);
    if (predicate.op === 'equals') return !!field && (predicate.value === null || (field.kind === 'text' && typeof predicate.value === 'string') || (field.kind === 'number' && typeof predicate.value === 'number' && Number.isFinite(predicate.value)) || (field.kind === 'boolean' && typeof predicate.value === 'boolean'));
    if (predicate.op === 'exists') return !!field;
    if (predicate.op === 'all' || predicate.op === 'any') return predicate.predicates.length > 0 && predicate.predicates.every(item => predicateValid(item, fields));
    return predicateValid(predicate.predicate, fields);
  };
  for (const node of graph.nodes) {
    const resultDependencies = graph.edges.filter(edge => edge.kind === 'result' && edge.to === node.id).map(edge => edge.from);
    const routeDependencies = graph.edges.filter(edge => edge.kind === 'route' && edge.to === node.id).map(edge => edge.from);
    const dependencies = [...resultDependencies, ...routeDependencies];
    const hasField = (id: string, field: string) => graph.nodes.find(source => source.id === id)?.resultFields?.some(item => item.name === field);
    if (node.condition && (!resultDependencies.includes(node.condition.sourceStepId) || !hasField(node.condition.sourceStepId, node.condition.field) || (typeof node.condition.equals === 'number' && !Number.isFinite(node.condition.equals)))) push('A condition must select a declared field on a result dependency.', [node.id]);
    const bindings = node.inputBindings ?? [];
    if (new Set(bindings.map(binding => binding.name)).size !== bindings.length || bindings.some(binding => !binding.name.trim() || !resultDependencies.includes(binding.sourceStepId) || !hasField(binding.sourceStepId, binding.field))) push('Input mappings need unique names and declared dependency fields.', [node.id]);
    if (isRouter(node)) {
      const router = node.router;
      const inputEdges = graph.edges.filter(edge => edge.kind === 'result' && edge.to === node.id);
      const branchIds = router?.branches.map(branch => branch.id) ?? [];
      if (!router || inputEdges.length !== 1 || router.inputStepId !== inputEdges[0]?.from) push('A router needs one direct result input.', [node.id]);
      if (!router || !router.branches.length || branchIds.some(id => !id.trim()) || new Set(branchIds).size !== branchIds.length || router.branches.some(branch => !branch.label.trim())) push('Router branches need unique ids and labels.', [node.id]);
      const sourceFields = graph.nodes.find(candidate => candidate.id === router?.inputStepId)?.resultFields ?? [];
      if (router?.mode === 'program' && router.branches.some(branch => !branch.predicate || !predicateValid(branch.predicate, sourceFields))) push('Program router predicates must use declared input fields.', [node.id]);
      if (router?.mode === 'agent' && (!router.selectionField?.trim() || router.branches.some(branch => branch.predicate || !branch.description?.trim()))) push('Agent routers need descriptions and a selection field, not program predicates.', [node.id]);
      if (router?.mode === 'agent' && !node.profile.model.trim()) push('Choose a model for the agent router.', [node.id]);
    }
    if (node.review) {
      const visited = new Set<string>(); const pending = [...dependencies];
      while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...graph.edges.filter(edge => edge.kind === 'result' && edge.to === id).map(edge => edge.from)); }
      if (!visited.has(node.review.retryFromStepId) || !node.resultFields?.some(field => field.name === node.review?.field && field.kind === 'boolean')) push('A review needs a boolean result field and an upstream correction task.', [node.id]);
      if (!reviewLimitValid(node.review)) push(RUN_INPUT_ISSUES.reviewLimit, [node.id]);
    }
  }
  for (const node of graph.nodes) { const fields = node.resultFields ?? []; if (fields.some(field => !field.name.trim()) || new Set(fields.map(field => field.name)).size !== fields.length) push('Result fields need unique non-empty names.', [node.id]); }
  for (const message of pipelineInputIssues(graph.inputs)) push(message);
  for (const edge of graph.edges.filter(edge => edge.kind === 'route')) {
    const source = graph.nodes.find(node => node.id === edge.from);
    if (!source || source.kind !== 'router' || !edge.branchId || !source.router?.branches.some(branch => branch.id === edge.branchId) || graph.nodes.some(node => node.id === edge.to && node.kind === 'router')) push('Route connections need a router branch and an agent target.', [edge.from,edge.to]);
  }
  // Step executors (v6.2), the rules of `piui-orchestration/src/executors.rs`.
  for (const node of graph.nodes) {
    const executor = node.executor;
    if (executor === undefined || executor.type === 'agent') continue;
    if (node.kind === 'router') { push(EXECUTOR_ISSUES.notRouter, [node.id]); continue; }
    if (node.executionMode === 'callable') push(EXECUTOR_ISSUES.notCallable, [node.id]);
    if (graph.edges.some(edge => (edge.kind === 'send' || edge.kind === 'observe' || edge.kind === 'spawn') && (edge.from === node.id || edge.to === node.id))) push(EXECUTOR_ISSUES.noCollaboration, [node.id]);
    if (executor.type === 'script') {
      if (!SCRIPT_RUNTIMES.includes(executor.runtime)) push(EXECUTOR_ISSUES.scriptRuntime, [node.id]);
      if (!scriptSourceValid(executor.source)) push(EXECUTOR_ISSUES.scriptSource, [node.id]);
      if (!scriptTimeoutValid(executor.timeoutSeconds)) push(EXECUTOR_ISSUES.scriptTimeout, [node.id]);
      if (node.inputBindings?.length) push(EXECUTOR_ISSUES.scriptBindings, [node.id]);
    } else {
      if (node.profile.permissionMode !== 'read-only') push(EXECUTOR_ISSUES.llmReadOnly, [node.id]);
      if (node.profile.networkAccess === true) push(EXECUTOR_ISSUES.llmNetwork, [node.id]);
      if (node.profile.toolPolicy.rules.some(rule => rule.decision === 'allow')) push(EXECUTOR_ISSUES.llmTools, [node.id]);
      if ((node.profile.resourceRules ?? []).some(rule => rule.enabled)) push(EXECUTOR_ISSUES.llmResources, [node.id]);
    }
  }
  if (graph.nodes.length > 0 && graph.nodes.every(nodeHasNoMember)) push(EXECUTOR_ISSUES.needsMember);
  if (!agentNodes.some(node => node.executionMode !== 'callable')) push('Add a scheduled agent to start this system.');
  if (graph.edges.some(edge => (edge.kind === 'result' || edge.kind === 'route') && graph.nodes.some(node => node.executionMode === 'callable' && (node.id === edge.from || node.id === edge.to)))) push('Callable agents exchange results through their caller, not pipeline dependencies.');
  const needsModel = (node: GraphNode): boolean => (node.kind !== 'router' || node.router?.mode === 'agent') && node.executor?.type !== 'script';
  if (!graph.name.trim() || !graph.nodes.length || agentNodes.some(node => !node.profile.name.trim() || needsModel(node) && !node.profile.model.trim())) push('Enter a name and model for every agent.', agentNodes.filter(node => !node.profile.name.trim() || needsModel(node) && !node.profile.model.trim()).map(node=>node.id));
  const definition = compileGraph(graph);
  if (definition.profiles.some(parent => parent.allowedSpawnProfileIds.some(id => { const child = definition.profiles.find(profile => profile.id === id); return !child || !permissionsSubset(parent, child); }))) push('Child permissions must be the same or lower.');
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges.filter(edge => edge.kind === 'result' || edge.kind === 'route')) { indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]); }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) { const id = ready.pop()!; visited++; for (const child of outgoing.get(id) ?? []) { const degree = (indegree.get(child) ?? 0) - 1; indegree.set(child, degree); if (!degree) ready.push(child); } }
  if (visited !== graph.nodes.length) push('Result connections must not form a cycle.');
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
