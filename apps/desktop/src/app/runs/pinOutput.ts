/**
 * "Pin output" from a finished run's step panel (run debugging v1): read the
 * saved pipeline the run came from, then ask the host to copy the step's
 * recorded output into it at the revision that was read. The host reads the
 * output itself (verified native history or the run record) and checks every
 * rule again; this only decides what to ask the person first.
 */
import type { OrchestrationClient, OrchestrationRunV6, PinnedOutput } from '../../host-api/orchestrationClient';
import { pinningRefusal } from '../../host-api/pinnedData';

export type PinPlan =
  | { readonly kind: 'ready'; readonly pipelineId: string; readonly revision: number; readonly replaces?: PinnedOutput }
  | { readonly kind: 'refused'; readonly message: string };

/** English source strings of the locale catalog. */
export const PIN_REFUSALS = {
  pipelineGone: 'The saved pipeline of this run no longer exists.',
  stepGone: 'This step is no longer in the saved pipeline.',
  notPinnable: 'This step always runs (a reviewing step, callable role or program router), so it cannot be pinned.',
} as const;

export async function planPin(
  client: Pick<OrchestrationClient, 'orchestration_get_pipeline_v6'>,
  workspaceId: string,
  run: Pick<OrchestrationRunV6, 'definition'>,
  stepId: string,
): Promise<PinPlan> {
  const pipelineId = run.definition.pipeline.id;
  const stored = await client.orchestration_get_pipeline_v6({ workspaceId, id: pipelineId });
  if (stored === null) return { kind: 'refused', message: PIN_REFUSALS.pipelineGone };
  const step = stored.value.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return { kind: 'refused', message: PIN_REFUSALS.stepGone };
  if (pinningRefusal(step) !== undefined) return { kind: 'refused', message: PIN_REFUSALS.notPinnable };
  return { kind: 'ready', pipelineId, revision: stored.revision, ...(step.pinnedOutput ? { replaces: step.pinnedOutput } : {}) };
}
