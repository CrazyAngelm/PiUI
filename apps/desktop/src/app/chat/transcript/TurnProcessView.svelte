<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();
  import type { TimelineTurnProcess } from '../../../features/sessions/timelineView';
  import DiffStats from './DiffStats.svelte';
  import { activityDiffTotals, activityState } from './toolKinds';
  import { turnProcessLabel } from './turnProcess';

  interface Props {
    item: TimelineTurnProcess;
    language: 'en' | 'ru';
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { item, language, open, onToggle }: Props = $props();

  const label = $derived(turnProcessLabel(item, language, $t));
  const diffStats = $derived(activityDiffTotals(item.blocks));
  const failed = $derived(activityState(item.blocks).failed);
</script>

<div class="turn">
  <button type="button" class="turn__head" aria-expanded={open} onclick={() => onToggle(!open)}>
    <span class="turn__label">{label}</span>
    {#if diffStats}<DiffStats totals={diffStats} />{/if}
    {#if failed > 0}<span class="turn__failed"><span class="turn__icon" aria-hidden="true"><CircleAlert size={13} /></span>{$t('{0} failed', [failed])}</span>{/if}
    <span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>
  </button>
</div>

<style>
  .turn {
    margin: 0 0 var(--piui-space-3);
  }
  .turn__head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 2px 6px;
    border: 0;
    border-bottom: 1px solid var(--piui-border-subtle);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-chat-font-size);
    text-align: left;
  }
  .turn__head:hover {
    color: var(--piui-text);
  }
  .turn__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn__failed {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--piui-danger);
    font-size: var(--piui-text-xs);
  }
  .turn__icon {
    display: inline-flex;
  }
  .chevron {
    display: inline-flex;
    flex: none;
    margin-left: auto;
    color: var(--piui-text-disabled);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
</style>
