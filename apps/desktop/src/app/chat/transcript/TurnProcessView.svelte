<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();
  import type { TimelineTurnProcess } from '../../../features/sessions/timelineView';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import { answerText, useAnswerSource } from '../../../shared/conversation/answerSource';
  import FullAnswerNotice from '../../../shared/conversation/FullAnswerNotice.svelte';
  import { Spinner } from '../../../lib/ui';
  import ActivityGroupView from './ActivityGroupView.svelte';
  import DiffStats from './DiffStats.svelte';
  import { activityState } from './toolKinds';
  import { processDiffTotals, processLive, turnProcessLabel } from './turnProcess';

  interface Props {
    item: TimelineTurnProcess;
    language: 'en' | 'ru';
    open: boolean;
    onToggle: (open: boolean) => void;
    /** Disclosure state of the groups and rows inside, keyed by block or group id. */
    openState: Record<string, boolean>;
    onOpenChange: (id: string, open: boolean) => void;
  }
  let { item, language, open, onToggle, openState, onOpenChange }: Props = $props();

  const now = $derived(processLive(item, language));
  const label = $derived(turnProcessLabel(item, language, $t));
  const diffStats = $derived(processDiffTotals(item));
  const state = $derived(activityState(item.blocks));
  // A process of one group has nothing to outline: opening it lists the calls.
  const flat = $derived(item.parts.length === 1);
  // A reply folded into the process reads the same text as in the chat: the full answer once loaded, no service markup.
  const answers = useAnswerSource();
</script>

<div class="turn">
  <button type="button" class="turn__head" aria-expanded={open} onclick={() => onToggle(!open)}>
    {#if now}<span class="turn__live"><Spinner size={12} /></span>{/if}
    <span class="turn__label">{now ? now.label : label}</span>
    <!-- Opened, the last group below names the same call: the line keeps only the state. -->
    {#if now?.detail && !open}<span class="turn__detail" class:turn__detail--text={!state.live}>· {now.detail}</span>{/if}
    {#if diffStats}<DiffStats totals={diffStats} />{/if}
    {#if state.failed > 0}<span class="turn__failed"><span class="turn__icon" aria-hidden="true"><CircleAlert size={13} /></span>{$t('{0} failed', [state.failed])}</span>{/if}
    {#if state.stopped && !now}<span class="turn__stopped">{$t('Stopped')}</span>{/if}
    <span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>
  </button>
  {#if open}
    <div class="turn__body">
      {#each item.parts as part (part.type === 'block' ? part.block.id : part.id)}
        {#if part.type === 'activity-group'}
          <ActivityGroupView group={part} {language} {openState} {onOpenChange} {flat} />
        {:else}
          {@const note = part.block.text ? answerText(part.block, answers.full(part.block.id)) : (part.block.safeSummary ?? '')}
          {#if note.trim() !== ''}
            <div class="turn__note" data-timeline-block={part.block.id}>
              <MarkdownContent source={note} compact={true} streaming={part.block.status === 'streaming'} />
              <FullAnswerNotice block={part.block} />
            </div>
          {/if}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .turn {
    margin: 0 0 var(--piui-space-3);
  }
  .turn__head {
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
    font-size: var(--piui-text-md);
    text-align: left;
  }
  .turn__head:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .turn__live {
    display: inline-flex;
    flex: none;
    color: var(--piui-accent);
  }
  .turn__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn__detail {
    flex: 0 10 auto;
    min-width: 0;
    max-width: 48ch;
    overflow: hidden;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn__detail--text {
    font-family: inherit;
  }
  .turn__failed,
  .turn__stopped {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    font-size: var(--piui-text-xs);
  }
  .turn__failed {
    color: var(--piui-danger);
  }
  .turn__stopped {
    color: var(--piui-text-disabled);
  }
  .turn__icon {
    display: inline-flex;
  }
  .chevron {
    display: inline-flex;
    flex: none;
    color: var(--piui-text-disabled);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
  .turn__body {
    --piui-activity-gap: 0px;
    display: grid;
    gap: 2px;
    margin: 2px 0 var(--piui-space-2) 5px;
    padding-left: 12px;
    border-left: 1px solid var(--piui-border-subtle);
  }
  .turn__note {
    padding: 4px 0;
    color: var(--piui-text-muted);
  }
  .turn__note :global(.markdown-content) {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-md);
  }
</style>
