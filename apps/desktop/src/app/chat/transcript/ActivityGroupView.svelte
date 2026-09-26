<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t, language } from '../../../features/locale/language';
  import type { TimelineActivityGroup } from '../../../features/sessions/timelineView';
  import { Spinner } from '../../../lib/ui';
  import ToolRow from './ToolRow.svelte';
  import { activitySummary } from './toolKinds';

  interface Props {
    group: TimelineActivityGroup;
    /** Remembered disclosure state across re-renders, keyed by block id. */
    openState: Record<string, boolean>;
    onOpenChange: (id: string, open: boolean) => void;
  }
  let { group, openState, onOpenChange }: Props = $props();

  const summary = $derived(activitySummary(group.blocks, $language));
  const live = $derived(group.status === 'streaming');
  const problem = $derived(group.status === 'failed' || group.status === 'interrupted');
  const groupOpen = $derived(openState[group.id] ?? (live || problem));

  function rowOpen(id: string, streaming: boolean, failed: boolean): boolean {
    return openState[id] ?? (group.blocks.length === 1 || streaming || failed);
  }
</script>

<div class="group" class:group--problem={problem}>
  <button type="button" class="group__head" aria-expanded={groupOpen} onclick={() => onOpenChange(group.id, !groupOpen)}>
    <span class="group__icon">
      {#if live}<Spinner size={12} />{:else if problem}<CircleAlert size={14} />{:else}<span class="dot"></span>{/if}
    </span>
    <span class="group__summary">{summary}</span>
    {#if live}<span class="group__live">{$t('working…')}</span>{/if}
    <span class="chevron" class:chevron--open={groupOpen}><ChevronRight size={12} /></span>
  </button>
  {#if groupOpen}
    <div class="group__rows">
      {#each group.blocks as block (block.id)}
        <ToolRow
          {block}
          open={rowOpen(block.id, block.status === 'streaming', block.status === 'failed')}
          onToggle={(open) => onOpenChange(block.id, open)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .group {
    margin: 2px 0 14px;
  }
  .group__head {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    max-width: 100%;
    min-height: 28px;
    padding: 2px 8px 2px 6px;
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
  .group__icon {
    display: inline-flex;
    justify-content: center;
    width: 16px;
    flex: none;
  }
  .group--problem .group__icon {
    color: var(--piui-danger);
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--piui-text-disabled);
  }
  .group__summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group__live {
    color: var(--piui-accent);
    font-size: var(--piui-text-xs);
  }
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
    margin: 2px 0 0 10px;
    padding-left: 10px;
    border-left: 1px solid var(--piui-border-subtle);
  }
</style>
