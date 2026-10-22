<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t, language } from '../../../features/locale/language';
  import type { TimelineActivityGroup } from '../../../features/sessions/timelineView';
  import { Spinner } from '../../../lib/ui';
  import ToolRow from './ToolRow.svelte';
  import { activityDiffTotals, activitySummary } from './toolKinds';

  interface Props {
    group: TimelineActivityGroup;
    /** Remembered disclosure state across re-renders, keyed by block id. */
    openState: Record<string, boolean>;
    onOpenChange: (id: string, open: boolean) => void;
  }
  let { group, openState, onOpenChange }: Props = $props();

  const summary = $derived(activitySummary(group.blocks, $language));
  const diffStats = $derived(activityDiffTotals(group.blocks));
  const live = $derived(group.status === 'streaming');
  const problem = $derived(group.status === 'failed' || group.status === 'interrupted');
  const groupOpen = $derived(openState[group.id] ?? false);

  function rowOpen(id: string, failed: boolean): boolean {
    return openState[id] ?? (group.blocks.length === 1 || failed);
  }
</script>

<div class="group" class:group--problem={problem}>
  <button type="button" class="group__head" aria-expanded={groupOpen} onclick={() => onOpenChange(group.id, !groupOpen)}>
    <span class="group__summary">{summary}</span>
    {#if diffStats}
      <span class="diff-stats" aria-label={$t('{0} lines added, {1} removed', [diffStats.added, diffStats.removed])}>
        <span class="diff-stats__added">+{diffStats.added}</span>
        <span class="diff-stats__removed">−{diffStats.removed}</span>
      </span>
    {/if}
    {#if live}<span class="group__status group__status--live"><Spinner size={12} /><span class="visually-hidden">{$t('working…')}</span></span>
    {:else if problem}<span class="group__status group__status--problem" aria-hidden="true"><CircleAlert size={14} /></span>{/if}
    <span class="chevron" class:chevron--open={groupOpen}><ChevronRight size={12} /></span>
  </button>
  {#if groupOpen}
    <div class="group__rows">
      {#each group.blocks as block (block.id)}
        <ToolRow
          {block}
          open={rowOpen(block.id, block.status === 'failed')}
          onToggle={(open) => onOpenChange(block.id, open)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .group {
    margin: 0 0 var(--piui-space-3);
  }
  .group__head {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: -6px;
    max-width: 100%;
    min-height: 28px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .group__head:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .group__status {
    display: inline-flex;
    justify-content: center;
    flex: none;
  }
  .group__status--live {
    color: var(--piui-accent);
  }
  .group__status--problem {
    color: var(--piui-danger);
  }
  .group__summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .diff-stats {
    display: inline-flex;
    flex: none;
    gap: 5px;
    padding: 1px 5px;
    border-radius: var(--piui-radius-xs);
    background: color-mix(in srgb, var(--piui-surface-1) 70%, transparent);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .diff-stats__added { color: var(--piui-success); }
  .diff-stats__removed { color: var(--piui-danger); }
  .chevron {
    display: inline-flex;
    color: var(--piui-text-disabled);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
  .group__rows {
    display: grid;
    gap: 1px;
    margin: 2px 0 0;
    padding-left: 10px;
    border-left: 1px solid var(--piui-border-subtle);
  }
</style>
