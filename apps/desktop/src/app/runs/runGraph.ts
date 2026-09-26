/**
 * Builds a display graph from a run's frozen definition snapshot, so the run
 * canvas always shows what actually ran — including agents spawned at run
 * time — independent of later edits to the saved pipeline.
 */
import type { AgentProfile, OrchestrationRunV6, TaskRecord } from '../../host-api/orchestrationClient';
import type { GraphEdge, GraphNode } from '../../features/orchestration/agentGraph';
import { readPositions } from '../pipelines/graphDocument';

export interface RunGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Steps created at run time by an agent (not in the saved pipeline). */
  spawned: Set<string>;
}

export function taskFor(run: OrchestrationRunV6, stepId: string): TaskRecord | undefined {
  return run.tasks.find((task) => task.stepId === stepId);
}

export function attemptsFor(run: OrchestrationRunV6, stepId: string): TaskRecord[] {
  return (run.attempts ?? []).filter((task) => task.stepId === stepId);
}

export function buildRunGraph(run: OrchestrationRunV6, workspaceId: string): RunGraph {
  const { profiles, team, pipeline, launchCommand } = run.definition;
  const initialSteps = new Set((run.initialDefinition ?? run.definition).pipeline.steps.map((step) => step.id));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const positions = launchCommand ? readPositions(workspaceId, launchCommand.id) : new Map<string, { x: number; y: number }>();
  const spawned = new Set<string>();

  const fallbackProfile = (name: string): AgentProfile => ({
    id: `router:${name}`,
    name,
    harness: 'codex',
    model: '',
    permissionMode: 'read-only',
    instructions: '',
    toolPolicy: { rules: [] },
    allowedSpawnProfileIds: [],
  });

  const nodes: GraphNode[] = pipeline.steps.map((step, index) => {
    const member = team.members.find((item) => item.id === step.assignedMemberId);
    const profile = (member && profileById.get(member.profileId)) ?? fallbackProfile(step.name || `Step ${index + 1}`);
    if (!initialSteps.has(step.id)) spawned.add(step.id);
    const position = positions.get(step.id) ?? { x: 60 + index * 300, y: 120 };
    return {
      kind: step.router ? 'router' : 'agent',
      id: step.id,
      profile,
      router: step.router,
      task: step.instructions,
      executionMode: step.executionMode,
      requireApproval: step.requireApproval,
      resultFields: step.resultFields ? [...step.resultFields] : undefined,
      x: position.x,
      y: position.y,
    };
  });

  const edges: GraphEdge[] = [
    ...pipeline.steps.flatMap((step) => [
      ...step.dependencyStepIds
        .filter((dependency) => !(step.routeGates ?? []).some((gate) => gate.routerStepId === dependency))
        .map((dependency) => ({ from: dependency, to: step.id, kind: 'result' as const })),
      ...(step.routeGates ?? []).map((gate) => ({ from: gate.routerStepId, to: step.id, kind: 'route' as const, branchId: gate.branchId })),
    ]),
    ...team.sendEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'send' as const })),
    ...team.observeEdges.map((edge) => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'observe' as const })),
  ].filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to));

  // Place spawned helpers next to the agent that created them (it observes them).
  const placedPerParent = new Map<string, number>();
  for (const node of nodes) {
    if (!spawned.has(node.id) || positions.has(node.id)) continue;
    const parentId = team.observeEdges.find((edge) => edge.toMemberId === node.id)?.fromMemberId;
    const parent = nodes.find((item) => item.id === parentId);
    if (!parent) continue;
    const slot = placedPerParent.get(parent.id) ?? 0;
    placedPerParent.set(parent.id, slot + 1);
    node.x = parent.x + 320;
    node.y = parent.y + slot * 150 - 40;
    edges.push({ from: parent.id, to: node.id, kind: 'spawn' });
  }
  return { nodes, edges, spawned };
}

export const RUN_STATUS_TONE = {
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  uncertain: 'warning',
} as const;

export const TASK_STATUS_LABEL: Record<TaskRecord['status'], string> = {
  awaitingApproval: 'Needs approval',
  skipped: 'Skipped',
  ready: 'Waiting',
  running: 'Working',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Needs checking',
};

/** Human wording for stable failure codes; unknown codes stay visible verbatim. */
export function failureText(code: string): string {
  const known: Record<string, string> = {
    'result-rejected': 'A person rejected the result.',
    'result-invalid': 'The agent returned a result that does not match the declared fields.',
    'review-retry-conflict': 'The review could not restart work that was still running.',
    'native-turn-failed': 'The agent’s turn failed in the harness.',
    'native-unavailable': 'The harness was not available.',
    'dependency-failed': 'An earlier step failed.',
    'cancelled': 'The step was cancelled.',
  };
  return known[code] ?? code;
}
