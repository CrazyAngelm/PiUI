/**
 * Loading and saving an agent system (the canvas graph) through the existing
 * orchestration host commands. The graph compiles into profiles, a team, a
 * dependency pipeline and a launch command, saved in one host transaction.
 * Node positions are rebuildable UI metadata kept per system in localStorage.
 */
import type {
  AgentProfile,
  LaunchCommandReference,
  OrchestrationClient,
  PipelineDefinition,
  SaveDefinitionRequest,
  StoredDefinition,
  TeamDefinition,
} from '../../host-api/orchestrationClient';
import {
  compileGraph,
  nodeHasNoMember,
  placeholderProfile,
  type AgentGraph,
  type GraphEdge,
  type GraphNode,
} from '../../features/orchestration/agentGraph';

export type Revisions = Map<string, number>;

export interface OpenedGraph {
  graph: AgentGraph;
  revisions: Revisions;
  /** No saved canvas positions (e.g. created by the assistant, CLI or another device). */
  needsLayout: boolean;
}

export class GraphDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphDocumentError';
  }
}

const positionKey = (workspaceId: string, graphId: string) => `piui.graph.${workspaceId}.${graphId}`;

export function readPositions(workspaceId: string, graphId: string): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(positionKey(workspaceId, graphId)) ?? 'null');
    if (!Array.isArray(stored)) return positions;
    for (const item of stored) {
      if (item && typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y)) {
        positions.set(item.id, { x: item.x, y: item.y });
      }
    }
  } catch {
    // Positions are rebuildable UI metadata.
  }
  return positions;
}

export function writePositions(workspaceId: string, graph: AgentGraph): void {
  try {
    localStorage.setItem(positionKey(workspaceId, graph.id), JSON.stringify(graph.nodes.map(({ id, x, y }) => ({ id, x, y }))));
  } catch {
    // The definition itself is already persisted by the host.
  }
}


/** Definitions a canvas graph is built from: saved ones, or a run's frozen snapshot. */
export interface GraphDefinitions {
  readonly command: Pick<LaunchCommandReference, 'id' | 'name'>;
  readonly team: TeamDefinition;
  readonly pipeline: PipelineDefinition;
  readonly profiles: ReadonlyMap<string, AgentProfile>;
}

/**
 * The canvas graph of a launch command's definitions, at default positions.
 * Pinned data (v6.3) stays on its node. Shapes the canvas cannot edit
 * without losing assignments are refused with a `GraphDocumentError`.
 */
export function graphFromDefinitions({ command, team, pipeline, profiles }: GraphDefinitions): AgentGraph {
  const nodes: GraphNode[] = pipeline.steps.map((step, index) => {
    const kind = step.router ? 'router' : 'agent';
    // Program routers and scripts have no team member, only a placeholder profile.
    const script = step.executor?.type === 'script';
    const noMember = nodeHasNoMember({ kind, router: step.router, executor: step.executor });
    const member = team.members.find((item) => item.id === step.assignedMemberId);
    const profile = member ? profiles.get(member.profileId) : undefined;
    if (!profile && !noMember) throw new GraphDocumentError('An agent in this system has no saved profile.');
    return {
      kind,
      ...(step.executor ? { executor: step.executor } : {}),
      ...(step.pinnedOutput ? { pinnedOutput: step.pinnedOutput } : {}),
      id: step.id,
      profile:
        profile ??
        placeholderProfile(step.name || (script ? `Script ${index + 1}` : `Router ${index + 1}`), script ? 'script' : 'router'),
      router: step.router,
      task: step.instructions,
      inputBindings: step.inputBindings ? [...step.inputBindings] : undefined,
      condition: step.condition,
      review: step.review,
      requireApproval: step.requireApproval,
      resultFields: step.resultFields ? [...step.resultFields] : undefined,
      executionMode: step.executionMode,
      input: step.inputInstructions,
      x: 60 + index * 300,
      y: 120,
    };
  });

  const agentNodes = nodes.filter((node) => !nodeHasNoMember(node));
  const reusesMembers =
    new Set(agentNodes.map((node) => node.profile.id)).size !== agentNodes.length ||
    team.members.some((member) => !pipeline.steps.some((step) => step.id === member.id && step.assignedMemberId === member.id));
  if (reusesMembers) {
    throw new GraphDocumentError('This definition uses reusable members. Open it in Library to preserve its assignments.');
  }

  const edges: GraphEdge[] = [
    ...pipeline.steps.flatMap((step) => [
      ...step.dependencyStepIds
        .filter((dependency) => !(step.routeGates ?? []).some((gate) => gate.routerStepId === dependency))
        .map((dependency) => ({ from: dependency, to: step.id, kind: 'result' as const })),
      ...(step.routeGates ?? []).map((gate) => ({ from: gate.routerStepId, to: step.id, kind: 'route' as const, branchId: gate.branchId })),
    ]),
    ...team.sendEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'send' as const })),
    ...team.observeEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'observe' as const })),
    ...agentNodes.flatMap((node) =>
      node.profile.allowedSpawnProfileIds.map((profileId) => {
        const target = nodes.find((candidate) => candidate.profile.id === profileId);
        if (!target) throw new GraphDocumentError('This definition delegates to an external profile. Open it in Library.');
        return { from: node.id, to: target.id, kind: 'spawn' as const };
      }),
    ),
  ];

  return {
    id: command.id,
    name: command.name,
    teamId: team.id,
    pipelineId: pipeline.id,
    orchestratorId: team.orchestratorMemberId,
    spawnedAgentsJoinTeam: team.spawnedAgentsJoinTeam,
    ...(pipeline.inputs?.length ? { inputs: pipeline.inputs.map((input) => ({ ...input })) } : {}),
    nodes,
    edges,
  };
}

/** Rebuilds the canvas graph for a saved launch command. */
export async function openGraph(client: OrchestrationClient, workspaceId: string, commandId: string): Promise<OpenedGraph> {
  const command = await client.orchestration_get_launch_command_v6({ workspaceId, id: commandId });
  if (!command) throw new GraphDocumentError('This system is no longer available.');
  const [team, pipeline, catalog] = await Promise.all([
    client.orchestration_get_team_v6({ workspaceId, id: command.value.teamId }),
    client.orchestration_get_pipeline_v6({ workspaceId, id: command.value.pipelineId }),
    client.orchestration_catalog_v6({ workspaceId }),
  ]);
  if (!team || !pipeline) throw new GraphDocumentError('The system definition is incomplete.');
  const stored = await Promise.all(catalog.profiles.map((profile) => client.orchestration_get_profile_v6({ workspaceId, id: profile.id })));
  const profiles = new Map(
    stored.filter((profile): profile is StoredDefinition<AgentProfile> => profile !== null).map((profile) => [profile.value.id, profile]),
  );
  const graph = graphFromDefinitions({
    command: { id: commandId, name: command.value.name },
    team: team.value,
    pipeline: pipeline.value,
    profiles: new Map([...profiles].map(([id, profile]) => [id, profile.value])),
  });
  const agentNodes = graph.nodes.filter((node) => !nodeHasNoMember(node));
  const positions = readPositions(workspaceId, commandId);
  const needsLayout = graph.nodes.length > 1 && !graph.nodes.some((node) => positions.has(node.id));
  graph.nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, x: Math.max(0, position.x), y: Math.max(0, position.y) } : node;
  });

  const revisions: Revisions = new Map([
    [commandId, command.revision],
    [team.value.id, team.revision],
    [pipeline.value.id, pipeline.revision],
    ...agentNodes
      .filter((node) => profiles.has(node.profile.id))
      .map((node) => [node.profile.id, profiles.get(node.profile.id)!.revision] as [string, number]),
  ]);
  return { graph, revisions, needsLayout };
}

/** Saves the whole graph atomically; returns the revisions to use next time. */
export async function saveGraph(
  client: OrchestrationClient,
  workspaceId: string,
  graph: AgentGraph,
  revisions: Revisions,
): Promise<Revisions> {
  const definition = compileGraph(graph);
  const request = <T extends { id: string }>(value: T): SaveDefinitionRequest<T> => ({
    workspaceId,
    value,
    ...(revisions.has(value.id) ? { expectedRevision: revisions.get(value.id)! } : {}),
  });
  await client.orchestration_save_graph_v6({
    workspaceId,
    profiles: definition.profiles.map((value) => request(value)),
    team: request(definition.team),
    pipeline: request(definition.pipeline),
    command: request(definition.command),
  });
  writePositions(workspaceId, graph);
  return new Map(
    [...definition.profiles, definition.team, definition.pipeline, definition.command].map((value) => [value.id, (revisions.get(value.id) ?? -1) + 1]),
  );
}
