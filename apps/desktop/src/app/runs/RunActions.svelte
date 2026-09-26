<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
  import Bug from '@lucide/svelte/icons/bug';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Trash from '@lucide/svelte/icons/trash-2';
  import { t } from '../../features/locale/language';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import type { AgentGraph } from '../../features/orchestration/agentGraph';
  import { Button, Dialog, IconButton, Menu, type MenuEntry } from '../../lib/ui';
  import DebugRunDialog from './DebugRunDialog.svelte';
  import RunDeletionSummary from './RunDeletionSummary.svelte';
  import { isActiveRun } from './runPresentation';
  import type { RunsStore } from './runsStore.svelte';

  /**
   * Run header actions (run debugging v1): debug the run in the editor as a
   * new draft, archive or unarchive it, and delete its PiUI records after a
   * confirmation that says exactly what is removed. Archive and delete wait
   * until the run no longer runs; safe mode keeps runs read-only.
   */
  interface Props {
    runs: RunsStore;
    run: OrchestrationRunV6;
    onDebug: ((draft: AgentGraph) => void) | undefined;
    onDeleted: (runId: string) => void;
  }
  let { runs, run, onDebug, onDeleted }: Props = $props();

  let debugOpen = $state(false);
  let deleteOpen = $state(false);
  let deleteRevision = $state(-1);
  const archived = $derived(runs.archived.has(run.id));
  const active = $derived(isActiveRun(run.status));
  const blocked = $derived(runs.safeMode || !!runs.busy);
  const recorded = $derived([...run.tasks, ...(run.attempts ?? [])]);
  const scriptSteps = $derived(new Set(run.definition.pipeline.steps.filter((step) => step.executor?.type === 'script').map((step) => step.id)));
  const sessions = $derived(new Set(recorded.filter((task) => task.execution && !scriptSteps.has(task.stepId)).map((task) => task.execution?.id)).size);
  const scripts = $derived(recorded.filter((task) => task.execution && scriptSteps.has(task.stepId)).length);

  const items = $derived<MenuEntry[]>([
    ...(runs.safeMode
      ? [{ type: 'label' as const, label: $t('Safe mode keeps runs read-only.') }]
      : active
        ? [{ type: 'label' as const, label: $t('Stop or finish the run to archive or delete it.') }]
        : []),
    {
      label: archived ? $t('Unarchive') : $t('Archive'),
      icon: archived ? ArchiveRestore : Archive,
      disabled: blocked || (!archived && active),
      onSelect: () => void runs.setArchived(run.id, !archived),
    },
    { type: 'separator' },
    {
      label: $t('Delete run…'),
      icon: Trash,
      danger: true,
      disabled: blocked || active,
      onSelect: () => {
        deleteRevision = run.revision;
        deleteOpen = true;
      },
    },
  ]);

  async function remove(): Promise<void> {
    if (await runs.deleteRun(run.id, deleteRevision)) {
      deleteOpen = false;
      onDeleted(run.id);
    }
  }
</script>

{#if onDebug}
  <Button size="sm" variant="ghost" onclick={() => (debugOpen = true)}>
    {#snippet leading()}<Bug />{/snippet}
    {$t('Debug in editor')}
  </Button>
{/if}
<Menu align="end" {items}>
  {#snippet trigger(props)}
    <IconButton label={$t('More run actions')} tooltip={false} size="sm" {...props}><Ellipsis /></IconButton>
  {/snippet}
</Menu>

{#if onDebug}
  <DebugRunDialog bind:open={debugOpen} {run} workspaceId={runs.workspaceId} debugging={runs.debugging} onOpenDraft={onDebug} />
{/if}

<Dialog bind:open={deleteOpen} title={$t('Delete this run?')} description={$t('Only PiUI’s own records of this run are deleted.')} size="md">
  <RunDeletionSummary {sessions} {scripts} />
  {#if runs.actionError && deleteOpen}<p class="error" role="alert">{$t(runs.actionError)}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)}>{$t('Keep the run')}</Button>
    <Button variant="danger" loading={runs.busy === 'delete'} disabled={runs.safeMode || active} onclick={() => void remove()}>
      {#snippet leading()}<Trash />{/snippet}
      {$t('Delete run')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .error {
    margin: var(--piui-space-3) 0 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
