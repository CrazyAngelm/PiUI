<script lang="ts">
  import Bug from '@lucide/svelte/icons/bug';
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { runDebuggingError, type RunDebuggingClient } from '../../host-api/runDebuggingClient';
  import type { AgentGraph } from '../../features/orchestration/agentGraph';
  import { Button, Dialog, Spinner } from '../../lib/ui';
  import { GraphDocumentError } from '../pipelines/graphDocument';
  import { draftOutputs, draftSnapshot, runDraft, type DraftOutput } from '../pipelines/runDraft';
  import DraftOutputChecklist from './DraftOutputChecklist.svelte';
  import { shortId } from './runPresentation';

  /**
   * "Debug in editor": opens the pipeline exactly as this run used it as a
   * new unsaved draft (the saved pipeline is never changed), with the
   * outputs the person checks as pinned data. The host reads the outputs;
   * if it cannot, the draft can still open without pins.
   */
  interface Props {
    open: boolean;
    run: OrchestrationRunV6;
    workspaceId: string;
    debugging: RunDebuggingClient;
    onOpenDraft: (draft: AgentGraph) => void;
  }
  let { open = $bindable(false), run, workspaceId, debugging, onOpenDraft }: Props = $props();

  let loading = $state(false);
  let error = $state('');
  let items = $state.raw<readonly DraftOutput[]>([]);
  let checked = $state<Record<string, boolean>>({});
  let request = 0;

  // Read the outputs once per opening, not on every live update of the run.
  $effect(() => {
    if (open) untrack(() => void load());
  });

  async function load(): Promise<void> {
    const current = ++request;
    loading = true;
    error = '';
    items = [];
    try {
      const result = await debugging.outputs({ workspaceId, runId: run.id });
      if (current !== request) return;
      items = draftOutputs(run, result.outputs, new Date());
      checked = Object.fromEntries(items.map((item) => [item.stepId, item.pin !== undefined]));
    } catch (cause) {
      if (current === request) error = runDebuggingError(cause).message;
    } finally {
      if (current === request) loading = false;
    }
  }

  function openDraft(withPins: boolean): void {
    const pins = withPins
      ? items.flatMap((item) => (item.pin !== undefined && checked[item.stepId] ? [{ stepId: item.stepId, pinnedOutput: item.pin }] : []))
      : [];
    const name = $t('{0} (run #{1})', [draftSnapshot(run).pipeline.name || $t('Untitled pipeline'), shortId(run.id)]);
    try {
      onOpenDraft(runDraft(run, workspaceId, pins, name));
      open = false;
    } catch (cause) {
      error = cause instanceof GraphDocumentError ? cause.message : 'This run’s pipeline cannot be opened in the editor.';
    }
  }
</script>

<Dialog
  bind:open
  title={$t('Debug this run in the editor')}
  description={$t('Opens the pipeline exactly as this run used it, as a new unsaved draft. The saved pipeline is not changed. Checked outputs become pinned data: a run with pinned data skips those steps.')}
  size="md"
>
  <div class="body">
    {#if loading}
      <p class="loading" role="status"><Spinner size={14} /> {$t('Reading this run’s outputs…')}</p>
    {:else}
      {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
      <DraftOutputChecklist {items} bind:checked />
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{$t('Cancel')}</Button>
    {#if error && !items.length}
      <Button variant="primary" onclick={() => openDraft(false)}>{$t('Open without pinned data')}</Button>
    {:else}
      <Button variant="primary" disabled={loading} onclick={() => openDraft(true)}>
        {#snippet leading()}<Bug />{/snippet}
        {$t('Open draft')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-3);
  }
  .loading {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    margin: 0;
    color: var(--piui-text-muted);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
