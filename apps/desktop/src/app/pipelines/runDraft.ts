/**
 * "Debug in editor": a past run's frozen pipeline as a new, unsaved editor
 * draft. The draft gets new pipeline, team, launch and profile ids, so saving
 * it creates a copy and never overwrites the saved pipeline; nothing is saved
 * until the person presses Save. Outputs of the run the person chose become
 * the draft's pinned data (v6.4), so a run with pinned data only runs the
 * rest. Spawned helpers are not part of it: the run's original definitions
 * are used.
 */
import type { OrchestrationRunV6, PinnedOutput, PipelineStep } from '../../host-api/orchestrationClient';
import type { StepOutputV1 } from '../../host-api/runDebuggingClient';
import { nodeHasNoMember, type AgentGraph } from '../../features/orchestration/agentGraph';
import { pinnedOutputIssue, pinningRefusal } from '../../host-api/pinnedData';
import { graphFromDefinitions, readPositions } from './graphDocument';
import { autoLayout } from './editorStore.svelte';

export interface PinChoice {
  readonly stepId: string;
  readonly pinnedOutput: PinnedOutput;
}

/** One succeeded step of a run as the checklist offers it. */
export interface DraftOutput {
  readonly stepId: string;
  readonly name: string;
  /** The pinned data the draft would hold, or why it cannot. */
  readonly pin: PinnedOutput | undefined;
  /** English source string of the locale catalog when `pin` is absent. */
  readonly reason: string | undefined;
  /** The run already used this step's pinned data. */
  readonly wasPinned: boolean;
}

/** English source strings of the locale catalog. */
export const DRAFT_REASONS = {
  notPinnable: 'Reviewing steps, callable roles and program routers always run.',
  tooLarge: 'The output is larger than 256 KiB.',
  unavailable: 'The agent’s history could not be read.',
  noOutput: 'No output was recorded.',
} as const;

/** The run's original definitions (before any agent spawned helpers). */
export function draftSnapshot(run: OrchestrationRunV6): OrchestrationRunV6['definition'] {
  return run.initialDefinition ?? run.definition;
}

/** RFC 3339 in whole seconds, like the host's pins. */
export function pinTime(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * The run's succeeded steps with the pinned data a draft could hold: the
 * recorded output the host read (`outputs`), or the pin the run itself used.
 */
export function draftOutputs(run: OrchestrationRunV6, outputs: readonly StepOutputV1[], now: Date): DraftOutput[] {
  const steps: readonly PipelineStep[] = draftSnapshot(run).pipeline.steps;
  const byStep = new Map(outputs.map((output) => [output.stepId, output]));
  return steps.flatMap((step): DraftOutput[] => {
    const task = run.tasks.find((candidate) => candidate.stepId === step.id);
    if (task?.status !== 'succeeded') return [];
    const base = { stepId: step.id, name: step.name || step.id, wasPinned: task.pinned === true };
    if (pinningRefusal(step) !== undefined) return [{ ...base, pin: undefined, reason: DRAFT_REASONS.notPinnable }];
    const frozen = run.definition.pipeline.steps.find((candidate) => candidate.id === step.id)?.pinnedOutput;
    if (task.pinned === true && frozen !== undefined) return [{ ...base, pin: frozen, reason: undefined }];
    const output = byStep.get(step.id);
    if (output?.issue === 'too-large') return [{ ...base, pin: undefined, reason: DRAFT_REASONS.tooLarge }];
    if (output?.issue === 'unavailable') return [{ ...base, pin: undefined, reason: DRAFT_REASONS.unavailable }];
    if (output === undefined || (output.text === undefined && output.data === undefined)) {
      return [{ ...base, pin: undefined, reason: DRAFT_REASONS.noOutput }];
    }
    const pin: PinnedOutput = {
      ...(output.text === undefined ? {} : { text: output.text }),
      ...(output.truncated === true ? { truncated: true } : {}),
      ...(output.data === undefined ? {} : { data: output.data }),
      pinnedAt: pinTime(now),
      sourceRunId: run.id,
    };
    return pinnedOutputIssue(step, pin) === undefined ? [{ ...base, pin, reason: undefined }] : [{ ...base, pin: undefined, reason: DRAFT_REASONS.tooLarge }];
  });
}

/**
 * The draft graph of `run` named `name`, with exactly `pins` as pinned data.
 * Throws `GraphDocumentError` for definitions the canvas cannot edit.
 */
export function runDraft(
  run: OrchestrationRunV6,
  workspaceId: string,
  pins: readonly PinChoice[],
  name: string,
  newId: () => string = () => crypto.randomUUID(),
): AgentGraph {
  const snapshot = draftSnapshot(run);
  const graph = graphFromDefinitions({
    command: { id: snapshot.launchCommand?.id ?? snapshot.pipeline.id, name },
    team: snapshot.team,
    pipeline: snapshot.pipeline,
    profiles: new Map(snapshot.profiles.map((profile) => [profile.id, profile])),
  });
  const profileIds = new Map(graph.nodes.filter((node) => !nodeHasNoMember(node)).map((node) => [node.profile.id, newId()]));
  const chosen = new Map(pins.map((pin) => [pin.stepId, pin.pinnedOutput]));
  const positions = snapshot.launchCommand ? readPositions(workspaceId, snapshot.launchCommand.id) : new Map<string, { x: number; y: number }>();
  const nodes = graph.nodes.map((node) => {
    const { pinnedOutput: _frozen, ...rest } = node;
    const pinned = chosen.get(node.id);
    const position = positions.get(node.id);
    const profile = nodeHasNoMember(node)
      ? { ...node.profile, id: newId() }
      : {
          ...node.profile,
          id: profileIds.get(node.profile.id) ?? newId(),
          allowedSpawnProfileIds: node.profile.allowedSpawnProfileIds.map((id) => profileIds.get(id) ?? id),
        };
    return {
      ...rest,
      ...(pinned === undefined ? {} : { pinnedOutput: pinned }),
      profile,
      ...(position === undefined ? {} : { x: Math.max(0, position.x), y: Math.max(0, position.y) }),
    };
  });
  const draft: AgentGraph = { ...graph, id: newId(), name, teamId: newId(), pipelineId: newId(), nodes };
  return nodes.some((node) => positions.has(node.id)) ? draft : autoLayout(draft);
}
