import validateV5 from '../../../../../contracts/system-file-v5-validator.mjs';
import validateV4 from '../../../../../contracts/system-file-v4-validator.mjs';
import validateV1 from '../../../../../contracts/system-file-v1-validator.mjs';
import validateV3 from '../../../../../contracts/system-file-v3-validator.mjs';
import validateV2 from '../../../../../contracts/system-file-v2-validator.mjs';
import type { AgentProfile, PipelineInput, ResultField, RouterConfig, RunInputValue, StepExecutor, SubpipelineInputSource } from '../../../../../contracts/orchestration-v6';
import { executorConfigurationErrors, profileConfigurationErrors } from '../../harness-adapters/validation';
import { mappingProblems, parseIssue, resolvePipelineName, SUBPIPELINE_ISSUE_TEMPLATES, type PipelineName } from '../../host-api/subpipelines';
import { compileGraph, emptyGraph, graphIssues, type AgentGraph, type GraphEdge, type GraphNode } from './agentGraph';

/** The version every export writes. Versions 1-4 still import unchanged. */
export const SYSTEM_FILE_VERSION = 5;

/**
 * Where one input of a sub-pipeline's child run comes from, as written in a
 * file (version 5): `step` names a direct upstream agent by its local id.
 */
export type SystemFileSubpipelineInput =
  | { kind: 'value'; value: RunInputValue }
  | { kind: 'input'; name: string }
  | { kind: 'step'; agent: string; field?: string };

/**
 * A step executor as written in a file. `pipeline` (version 5, orchestration
 * v6.7) names a saved pipeline of the target project by its launch command
 * NAME: ids are local to a project, so import resolves the name.
 */
export type SystemFileExecutor =
  | Exclude<StepExecutor, { type: 'pipeline' }>
  | { type: 'pipeline'; pipeline: string; inputs?: Record<string, SystemFileSubpipelineInput> };

/** A declared pipeline output (version 5): `agent` is a local agent id. */
export interface SystemFileOutput { name: string; kind: ResultField['kind']; agent: string; field?: string }

export interface SystemFile {
  format: 'piui-system'; version: 1 | 2 | 3 | 4 | 5; name: string;
  orchestrator?: string; inheritTeamConnections?: boolean;
  /** Version 4+: run inputs requested when the system starts. */
  inputs?: PipelineInput[];
  /** Version 5: what the pipeline returns when another pipeline runs it as a sub-pipeline. */
  outputs?: SystemFileOutput[];
  /**
   * `executor` (version 4, orchestration v6.2): `llm` for a single model call,
   * `script` for host-run code, `plugin` (v6.5) for a plugin's node type,
   * `pipeline` (version 5, v6.7) for a sub-pipeline. A script's, plugin
   * node's or sub-pipeline's `profile` only names the step.
   */
  agents: { id: string; kind?: 'agent' | 'router'; executor?: SystemFileExecutor; profile: Omit<AgentProfile, 'id' | 'allowedSpawnProfileIds'>; router?: RouterConfig; task: string; inputBindings?: import('../../../../../contracts/orchestration-v6').InputBinding[]; condition?: import('../../../../../contracts/orchestration-v6').ResultCondition; review?: import('../../../../../contracts/orchestration-v6').ReviewRule; requireApproval?: boolean; resultFields?: import('../../../../../contracts/orchestration-v6').ResultField[]; executionMode?: 'scheduled' | 'callable'; input?: string; position?: { x: number; y: number } }[];
  connections: GraphEdge[];
}

export { resolvePipelineName, type PipelineName };

/** Export refuses a sub-pipeline step whose pipeline it cannot name. */
export const SYSTEM_FILE_UNNAMED_PIPELINE = 'A sub-pipeline step runs a pipeline whose name is unknown. Pick a saved pipeline for it, then export again.';

/** Host work without a native profile: scripts, plugin nodes and sub-pipelines. */
function hostWork(executor: SystemFileExecutor | StepExecutor | undefined): boolean {
  return executor?.type === 'script' || executor?.type === 'plugin' || executor?.type === 'pipeline';
}

function validatorFor(data: unknown): typeof validateV5 {
  const version = typeof data === 'object' && data !== null && 'version' in data ? data.version : undefined;
  switch (version) {
    case 1: return validateV1;
    case 2: return validateV2;
    case 3: return validateV3;
    case 4: return validateV4;
    default: return validateV5;
  }
}

export function parseSystemFile(text: string): SystemFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON.'); }
  const validate = validatorFor(data);
  if (!validate(data)) throw new Error((validate.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`).join('\n'));
  const value = data as SystemFile;
  const errors: string[] = [];
  const ids = new Set(value.agents.map(agent => agent.id));
  if (ids.size !== value.agents.length) errors.push('Agent IDs must be unique.');
  if (value.orchestrator !== undefined && !ids.has(value.orchestrator)) errors.push('Unknown orchestrator.');
  if (value.agents.some(agent => agent.id === value.orchestrator && agent.executor?.type === 'script')) errors.push('A script runs on the host and cannot be the orchestrator.');
  if (value.agents.some(agent => agent.id === value.orchestrator && agent.executor?.type === 'plugin')) errors.push('A plugin node runs on the host and cannot be the orchestrator.');
  if (value.agents.some(agent => agent.id === value.orchestrator && agent.executor?.type === 'pipeline')) errors.push('A sub-pipeline runs on the host and cannot be the orchestrator.');
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
    // A script, a plugin node or a sub-pipeline has no native profile: its placeholder only names the step.
    if (!hostWork(agent.executor)) errors.push(...profileConfigurationErrors(agent.id, agent.profile));
    if (agent.executor?.type !== 'pipeline') errors.push(...executorConfigurationErrors(agent.id, agent.executor, agent.profile));
    if (agent.router && agent.kind !== 'router') errors.push(`${agent.id}: router configuration requires kind=router.`);
    if (agent.kind === 'router' && !agent.router) errors.push(`${agent.id}: kind=router requires router configuration.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const graph = systemFileToGraph(value);
  // The named pipeline is resolved against a project at import; offline it is not an error.
  errors.push(...graphIssues(graph).filter(issue => parseIssue(issue.message)?.template !== SUBPIPELINE_ISSUE_TEMPLATES.unresolved).map(issue => issue.message));
  // Mappings that only depend on this file: run inputs it declares and fields of direct upstream agents.
  for (const node of graph.nodes) {
    if (node.executor?.type !== 'pipeline') continue;
    const dependencies = graph.edges.filter(edge => (edge.kind === 'result' || edge.kind === 'route') && edge.to === node.id).map(edge => edge.from);
    const fieldsOf = (id: string) => graph.nodes.find(candidate => candidate.id === id)?.resultFields ?? [];
    for (const problem of mappingProblems(node.executor, undefined, graph.inputs ?? [], dependencies, fieldsOf)) errors.push(`${node.id}: ${problem.message}`);
  }
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  return value;
}

function sourceFromFile(source: SystemFileSubpipelineInput): SubpipelineInputSource {
  switch (source.kind) {
    case 'value': return { kind: 'value', value: source.value };
    case 'input': return { kind: 'input', name: source.name };
    case 'step': return { kind: 'step', stepId: source.agent, ...(source.field !== undefined ? { field: source.field } : {}) };
    default: { const exhaustive: never = source; return exhaustive; }
  }
}

function sourceToFile(source: SubpipelineInputSource): SystemFileSubpipelineInput {
  switch (source.kind) {
    case 'value': return { kind: 'value', value: source.value };
    case 'input': return { kind: 'input', name: source.name };
    case 'step': {
      const field = source.field ?? undefined;
      return { kind: 'step', agent: source.stepId, ...(field !== undefined ? { field } : {}) };
    }
    default: { const exhaustive: never = source; return exhaustive; }
  }
}

/**
 * Import always creates a new draft; no existing definition IDs are
 * overwritten and nothing is saved or run. A sub-pipeline's name resolves
 * against `commands` (the current project's launch commands); a name that is
 * missing or ambiguous stays on the node as `pipelineName`, unresolved,
 * until the person picks a pipeline.
 */
export function systemFileToGraph(file: SystemFile, commands: readonly PipelineName[] = []): AgentGraph {
  const graph = emptyGraph();
  const profiles = new Map(file.agents.map(agent => [agent.id, crypto.randomUUID()]));
  const executorOf = (agent: SystemFile['agents'][number]): Pick<GraphNode, 'executor' | 'pipelineName'> => {
    const executor = agent.executor;
    if (executor === undefined) return {};
    if (executor.type !== 'pipeline') return { executor };
    const launchCommandId = resolvePipelineName(executor.pipeline, commands) ?? '';
    const inputs = Object.fromEntries(Object.entries(executor.inputs ?? {}).map(([name, source]) => [name, sourceFromFile(source)]));
    return { executor: { type: 'pipeline', launchCommandId, inputs }, ...(launchCommandId ? {} : { pipelineName: executor.pipeline }) };
  };
  return { ...graph, name: file.name, orchestratorId: file.orchestrator ?? file.agents.find(agent => agent.kind !== 'router' && !hostWork(agent.executor))?.id,
    spawnedAgentsJoinTeam: file.inheritTeamConnections,
    ...(file.inputs ? { inputs: file.inputs.map(input => ({ ...input })) } : {}),
    ...(file.outputs?.length ? { outputs: file.outputs.map(output => ({ name: output.name, kind: output.kind, sourceStepId: output.agent, ...(output.field !== undefined ? { field: output.field } : {}) })) } : {}),
    nodes: file.agents.map((agent, index) => ({ kind: agent.kind ?? 'agent', id: agent.id, ...executorOf(agent), task: agent.task, inputBindings: agent.inputBindings, condition: agent.condition, review: agent.review, requireApproval: agent.requireApproval, resultFields: agent.resultFields, executionMode: agent.executionMode, router: agent.router, input: agent.input, x: agent.position?.x ?? 60 + index * 280, y: agent.position?.y ?? 100,
      profile: { ...agent.profile, id: profiles.get(agent.id)!, allowedSpawnProfileIds: file.connections.filter(edge => edge.kind === 'spawn' && edge.from === agent.id).map(edge => profiles.get(edge.to)!) } })),
    edges: file.connections.map(edge => ({ ...edge })),
  };
}

/**
 * The portable document of a graph (always the current version). A
 * sub-pipeline step is written with its pipeline's NAME from `commands`, or
 * the unresolved name it was imported with; an unknown one is written blank
 * (`serializeSystemFile` refuses it).
 */
export function graphToSystemFile(graph: AgentGraph, commands: readonly PipelineName[] = []): SystemFile {
  const definition = compileGraph(graph);
  const executorOf = (node: GraphNode): SystemFileExecutor | undefined => {
    const executor = node.executor;
    if (executor?.type !== 'pipeline') return executor;
    const name = commands.find(command => command.id === executor.launchCommandId)?.name ?? (executor.launchCommandId ? undefined : node.pipelineName) ?? '';
    return { type: 'pipeline', pipeline: name, inputs: Object.fromEntries(Object.entries(executor.inputs).map(([input, source]) => [input, sourceToFile(source)])) };
  };
  const outputs = definition.pipeline.outputs ?? [];
  return { format: 'piui-system', version: SYSTEM_FILE_VERSION, name: graph.name,
    orchestrator: definition.team.orchestratorMemberId,
    ...(graph.spawnedAgentsJoinTeam !== undefined ? { inheritTeamConnections: graph.spawnedAgentsJoinTeam } : {}),
    ...(definition.pipeline.inputs?.length ? { inputs: definition.pipeline.inputs.map(input => ({ ...input })) } : {}),
    ...(outputs.length ? { outputs: outputs.map(output => { const field = output.field ?? undefined; return { name: output.name, kind: output.kind, agent: output.sourceStepId, ...(field !== undefined ? { field } : {}) }; }) } : {}),
    agents: graph.nodes.map(node => {
      const { id: _id, allowedSpawnProfileIds: _spawn, ...profile } = node.profile;
      const executor = executorOf(node);
      return { id: node.id, ...(node.kind && node.kind !== 'agent' ? { kind: node.kind } : {}), ...(executor ? { executor } : {}), profile, ...(node.router ? { router: node.router } : {}), task: node.task, ...(node.inputBindings?.length ? { inputBindings: node.inputBindings } : {}), ...(node.condition ? { condition: node.condition } : {}), ...(node.review ? { review: node.review } : {}), ...(node.requireApproval ? { requireApproval: true } : {}), ...(node.resultFields?.length ? { resultFields: node.resultFields } : {}), ...(node.executionMode ? { executionMode: node.executionMode } : {}), ...(node.input !== undefined ? { input: node.input } : {}), position: { x: node.x, y: node.y } };
    }), connections: graph.edges.map(edge => ({ ...edge })),
  };
}

/** Exports the current version through the import parser, so a written file always imports. */
export function serializeSystemFile(graph: AgentGraph, commands: readonly PipelineName[] = []): string {
  const file = graphToSystemFile(graph, commands);
  if (file.agents.some(agent => agent.executor?.type === 'pipeline' && !agent.executor.pipeline.trim())) throw new Error(SYSTEM_FILE_UNNAMED_PIPELINE);
  const text = JSON.stringify(file, null, 2) + '\n';
  parseSystemFile(text);
  return text;
}

/** Names of sub-pipelines a draft could not resolve in this project (import from a file). */
export function unresolvedPipelines(graph: AgentGraph): string[] {
  return [...new Set(graph.nodes.flatMap(node => node.executor?.type === 'pipeline' && !node.executor.launchCommandId && node.pipelineName ? [node.pipelineName] : []))];
}
