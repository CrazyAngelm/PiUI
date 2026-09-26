/**
 * Builds a display graph from a run's frozen definition snapshot, so the run
 * canvas always shows what actually ran — including agents spawned at run
 * time — independent of later edits to the saved pipeline.
 */
import type { AgentProfile, OrchestrationRunV6, TaskRecord } from '../../host-api/orchestrationClient';
import type { GraphEdge, GraphNode } from '../../features/orchestration/agentGraph';
import dagre from '@dagrejs/dagre';
import { readPositions } from '../pipelines/graphDocument';

const RUN_NODE_WIDTH = 232;
const RUN_NODE_HEIGHT = 92;

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
  // Members and steps share ids for saved graphs; spawned work may not.
  const memberStep = new Map(pipeline.steps.map((step) => [step.assignedMemberId, step.id]));
  const stepOf = (memberId: string) => memberStep.get(memberId) ?? memberId;

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
      ...(step.executor ? { executor: step.executor } : {}),
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
    ...team.sendEdges.map((edge) => ({ from: stepOf(edge.fromMemberId), to: stepOf(edge.toMemberId), kind: 'send' as const })),
    ...team.observeEdges.map((edge) => ({ from: stepOf(edge.fromMemberId), to: stepOf(edge.toMemberId), kind: 'observe' as const })),
  ].filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to));

  // A spawned helper hangs off the agent that created it (it observes them).
  const parents = new Map<string, string>();
  for (const node of nodes) {
    if (!spawned.has(node.id)) continue;
    const observer = team.observeEdges.find((edge) => stepOf(edge.toMemberId) === node.id)?.fromMemberId;
    const parentId = observer === undefined ? undefined : stepOf(observer);
    if (!parentId || !nodes.some((item) => item.id === parentId)) continue;
    parents.set(node.id, parentId);
    if (!edges.some((edge) => edge.from === parentId && edge.to === node.id && edge.kind === 'spawn')) {
      edges.push({ from: parentId, to: node.id, kind: 'spawn' });
    }
  }

  // Saved editor positions win; otherwise lay the whole run out left to right.
  const needsLayout = nodes.some((node) => !spawned.has(node.id) && !positions.has(node.id));
  if (needsLayout) {
    layoutRun(nodes, edges);
  } else {
    const placedPerParent = new Map<string, number>();
    for (const node of nodes) {
      const parent = nodes.find((item) => item.id === parents.get(node.id));
      if (!parent || positions.has(node.id)) continue;
      const slot = placedPerParent.get(parent.id) ?? 0;
      placedPerParent.set(parent.id, slot + 1);
      node.x = parent.x + 320;
      node.y = parent.y + slot * 130 - 40;
    }
  }
  return { nodes, edges, spawned };
}

function layoutRun(nodes: GraphNode[], edges: readonly GraphEdge[]): void {
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 88, marginx: 40, marginy: 40 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) layout.setNode(node.id, { width: RUN_NODE_WIDTH, height: RUN_NODE_HEIGHT });
  for (const edge of edges) {
    if (edge.kind === 'result' || edge.kind === 'route' || edge.kind === 'spawn') layout.setEdge(edge.from, edge.to);
  }
  dagre.layout(layout);
  for (const node of nodes) {
    const placed = layout.node(node.id);
    if (!placed) continue;
    node.x = Math.round(placed.x - RUN_NODE_WIDTH / 2);
    node.y = Math.round(placed.y - RUN_NODE_HEIGHT / 2);
  }
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
    'native-turn-failed': 'The agent’s turn failed in the harness.',
    'native-unavailable': 'The harness was not available.',
    'harness-sign-in-required': 'Claude Code is not signed in with your Claude subscription, so this step did not start. Run `claude` in a terminal and use /login, then run this step again.',
    'dependency-failed': 'An earlier step failed.',
    'cancelled': 'The step was cancelled.',
    'review-limit-reached': 'The review loop reached its round limit. Accept the last result, reject it, or allow one more round.',
    'result-invalid-json': 'The step printed something that is not valid JSON, but it declares result fields.',
    'result-not-object': 'The step returned JSON that is not an object with the declared fields.',
    'result-missing-field': 'The result is missing a declared field.',
    'result-field-type': 'A result field has the wrong type.',
    'script-failed': 'The script exited with an error.',
    'script-timeout': 'The script ran past its time limit and was stopped.',
    'script-runtime-unavailable': 'The script runtime (Node.js, Python or PowerShell) was not found on this computer.',
    'script-input-unavailable': 'The script could not get the results of earlier steps.',
    'script-start-failed': 'The script could not be started.',
    'llm-read-only-unsupported': 'This harness cannot run a model call read-only. Choose Pi, Codex or Claude Code.',
    'review-verdict-missing': 'The reviewer did not return its verdict field.',
    'review-retry-conflict': 'The review could not restart work that was still running.',
    'OPERATOR_ASSERTED_FAILURE': 'A person recorded this step as failed.',
  };
  return known[code] ?? code;
}
