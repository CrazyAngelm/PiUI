<script lang="ts">
  import Pin from '@lucide/svelte/icons/pin';
  import { t } from '../../features/locale/language';
  import { orchestrationError, type OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { runDebuggingError } from '../../host-api/runDebuggingClient';
  import { Button, Dialog, toasts } from '../../lib/ui';
  import { planPin } from './pinOutput';
  import { canPinOutput, shortId, type StepView } from './runPresentation';
  import type { RunsStore } from './runsStore.svelte';

  /**
   * "Pin output": saves this step's recorded output as pinned data on the
   * saved pipeline's step, so a run started with pinned data skips it. The
   * saved pipeline changes at the revision read here; a replaced pin is
   * confirmed first. Hidden in safe mode and where pins cannot apply.
   */
  interface Props {
    runs: RunsStore;
    run: OrchestrationRunV6;
    view: StepView;
  }
  let { runs, run, view }: Props = $props();

  let busy = $state(false);
  let pinned = $state(false);
  let confirm = $state<{ revision: number; pipelineId: string; source: string } | undefined>();
  const available = $derived(!runs.safeMode && canPinOutput(run, view));

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const plan = await planPin(runs.client, runs.workspaceId, run, view.stepId);
      if (plan.kind === 'refused') {
        toasts.error($t('Could not pin the output'), $t(plan.message));
        return;
      }
      if (plan.replaces) {
        confirm = { revision: plan.revision, pipelineId: plan.pipelineId, source: plan.replaces.sourceRunId ? shortId(plan.replaces.sourceRunId) : '' };
        return;
      }
      await commit(plan.pipelineId, plan.revision);
    } catch (error) {
      toasts.error($t('Could not pin the output'), $t(orchestrationError(error).message));
    } finally {
      busy = false;
    }
  }

  async function commit(pipelineId: string, revision: number): Promise<void> {
    busy = true;
    try {
      await runs.debugging.pin({ workspaceId: runs.workspaceId, runId: run.id, stepId: view.stepId, pipelineId, expectedRevision: revision });
      pinned = true;
      confirm = undefined;
      toasts.success($t('Output pinned'), $t('{0} is pinned in the saved pipeline. A run with pinned data skips it.', [view.name]));
    } catch (error) {
      confirm = undefined;
      toasts.error($t('Could not pin the output'), $t(runDebuggingError(error).message));
    } finally {
      busy = false;
    }
  }
</script>

{#if available}
  <Button
    size="sm"
    variant="ghost"
    loading={busy && confirm === undefined}
    disabled={busy || pinned}
    title={$t('Save this output on the step in the saved pipeline, so a run with pinned data skips the step')}
    onclick={() => void start()}
  >
    {#snippet leading()}<Pin />{/snippet}
    {pinned ? $t('Pinned') : $t('Pin output')}
  </Button>
{/if}

<Dialog
  open={confirm !== undefined}
  onOpenChange={(open) => {
    if (!open) confirm = undefined;
  }}
  title={$t('Replace the pinned data?')}
  description={confirm?.source
    ? $t('{0} already has pinned data from run #{1}. Pinning this output replaces it in the saved pipeline.', [view.name, confirm.source])
    : $t('{0} already has pinned data. Pinning this output replaces it in the saved pipeline.', [view.name])}
  size="sm"
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirm = undefined)}>{$t('Keep the current pin')}</Button>
    <Button
      variant="primary"
      loading={busy}
      onclick={() => {
        if (confirm) void commit(confirm.pipelineId, confirm.revision);
      }}>{$t('Replace')}</Button
    >
  {/snippet}
</Dialog>
