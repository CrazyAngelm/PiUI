<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();
  import type { TimelineActivityGroup } from '../../../features/sessions/timelineView';
  import type { TimelineBlock } from '../../../host-api/types';
  import { Spinner } from '../../../lib/ui';
  import DiffStats from './DiffStats.svelte';
  import ToolRow from './ToolRow.svelte';
  import { toolIcons } from './toolIcons';
  import { activityDiffTotals, activityLive, activityState, activitySummary, leadingKind } from './toolKinds';

  interface Props {
    group: TimelineActivityGroup;
    language: 'en' | 'ru';
    /** Remembered disclosure state across re-renders, keyed by block id. */
    openState: Record<string, boolean>;
    onOpenChange: (id: string, open: boolean) => void;
  }
  let { group, language, openState, onOpenChange }: Props = $props();

  const summary = $derived(activitySummary(group.blocks, language));
  const diffStats = $derived(activityDiffTotals(group.blocks));
  const activity = $derived(activityState(group.blocks));
  const live = $derived(group.live === true || activity.live);
  const now = $derived(live ? activityLive(group.blocks, language) : undefined);
  const Icon = $derived(toolIcons[leadingKind(group.blocks)]);
  const calls = $derived(group.blocks.filter((block) => block.kind === 'tool').length);
  const groupOpen = $derived(openState[group.id] ?? false);

  // A lone call, or a lone reasoning block, shows its content as soon as the group opens.
  function rowOpen(block: TimelineBlock): boolean {
    return openState[block.id] ?? (block.status === 'failed' || (block.kind === 'tool' ? calls === 1 : group.blocks.length === 1));
  }

  /**
   * Keeps a live group's body at its end as rows arrive, until the reader
   * scrolls up. Reads layout only when the content resizes or the reader scrolls.
   */
  function follow(node: HTMLElement, active: boolean) {
    let enabled = active;
    let pinned = true;
    const pin = () => {
      if (enabled && pinned) node.scrollTop = node.scrollHeight;
    };
    const onScroll = () => {
      pinned = node.scrollHeight - node.clientHeight - node.scrollTop <= 8;
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(pin);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return {
      update(next: boolean) {
        enabled = next;
        pin();
      },
      destroy() {
        observer?.disconnect();
        node.removeEventListener('scroll', onScroll);
      },
    };
  }
</script>

<div class="group">
  <button type="button" class="group__head" aria-expanded={groupOpen} onclick={() => onOpenChange(group.id, !groupOpen)}>
    <span class="group__lead" class:group__lead--live={live}>
      {#if live}<Spinner size={12} />{:else}<Icon size={14} />{/if}
    </span>
    <span class="group__summary">{now ? now.label : summary}</span>
    {#if now?.detail}<span class="group__current" class:group__current--text={!activity.live}>· {now.detail}</span>{/if}
    {#if diffStats}<DiffStats totals={diffStats} />{/if}
    {#if activity.failed > 0}
      <span class="group__status group__status--failed"><span class="group__icon" aria-hidden="true"><CircleAlert size={13} /></span>{$t('{0} failed', [activity.failed])}</span>
    {/if}
    {#if activity.stopped && !activity.live}<span class="group__status group__status--stopped">{$t('Stopped')}</span>{/if}
    <span class="chevron" class:chevron--open={groupOpen}><ChevronRight size={12} /></span>
  </button>
  {#if groupOpen}
    <div class="group__rows" use:follow={live}>
      <div class="group__list">
        {#each group.blocks as block (block.id)}
          <ToolRow
            {block}
            open={rowOpen(block)}
            onToggle={(open) => onOpenChange(block.id, open)}
          />
        {/each}
      </div>
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
    font-size: var(--piui-chat-font-size);
    text-align: left;
  }
  .group__head:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .group__lead {
    display: inline-flex;
    flex: none;
    width: 16px;
    justify-content: center;
  }
  .group__lead--live {
    color: var(--piui-accent);
  }
  .group__status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .group__status--failed {
    color: var(--piui-danger);
    font-size: var(--piui-text-xs);
  }
  .group__status--stopped {
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .group__icon {
    display: inline-flex;
  }
  .group__current {
    flex: 0 10 auto;
    min-width: 0;
    max-width: 48ch;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group__current--text {
    font-family: inherit;
  }
  .group__summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    max-height: min(420px, 55vh);
    margin: 2px 0 0;
    overflow-y: auto;
    border-left: 1px solid var(--piui-border-subtle);
  }
  .group__list {
    display: grid;
    gap: 1px;
    padding-left: 10px;
  }
</style>
