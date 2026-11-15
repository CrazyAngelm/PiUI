<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { useTranslation } from '../../../features/locale/context';
  import type { TimelineBlock } from '../../../host-api/types';
  import { Spinner } from '../../../lib/ui';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import { reasoningDuration, type ReasoningClock } from './reasoningClock';
  const t = useTranslation();

  interface Props {
    block: TimelineBlock;
    open: boolean;
    onToggle: (open: boolean) => void;
    clock: ReasoningClock;
  }
  let { block, open, onToggle, clock }: Props = $props();

  const live = $derived(block.status === 'streaming');
  const source = $derived(block.text ?? block.safeSummary ?? '');
  const hasBody = $derived(source.trim().length > 0);
  const duration = $derived.by(() => {
    const seconds = clock.observe(block.id, live, Date.now());
    return seconds === undefined ? undefined : reasoningDuration(seconds);
  });
  // Read `duration` before branching: the clock must observe the streaming
  // start, or a finished block has no start time to measure from.
  const title = $derived.by(() => {
    const spent = duration;
    if (block.label === 'Plan') return $t('Work plan');
    if (live) return $t('Thinking…');
    if (spent === undefined) return $t('Thought');
    return spent.minutes > 0 ? $t('Thought for {0}m {1}s', [spent.minutes, spent.seconds]) : $t('Thought for {0}s', [spent.seconds]);
  });

  let head: HTMLButtonElement | undefined = $state();
  let body: HTMLDivElement | undefined = $state();
  // Auto-collapse removes the body: keep keyboard focus on the disclosure.
  $effect.pre(() => {
    if (!open && body && head && body.contains(document.activeElement)) head.focus();
  });
</script>

<div class="reasoning">
  <button bind:this={head} type="button" class="reasoning__head" aria-expanded={hasBody ? open : undefined} disabled={!hasBody} onclick={() => onToggle(!open)}>
    {#if live}<span class="reasoning__live"><Spinner size={12} /></span>{/if}
    <span class="reasoning__title">{title}</span>
    {#if hasBody}<span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>{/if}
  </button>
  {#if open && hasBody}
    <div class="reasoning__body" bind:this={body}>
      <MarkdownContent {source} compact={true} />
      {#if block.truncated}<p class="reasoning__note">{$t('Output was shortened to keep the chat responsive.')}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .reasoning {
    margin: 0 0 var(--piui-space-3);
  }
  .reasoning__note {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .reasoning__head {
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
  .reasoning__head:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .reasoning__head:disabled {
    cursor: default;
    opacity: 1;
  }
  .reasoning__live {
    display: inline-flex;
    flex: none;
    color: var(--piui-accent);
  }
  .reasoning__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .reasoning__body {
    margin: 2px 0 0;
    padding-left: 10px;
    border-left: 2px solid var(--piui-border);
    color: var(--piui-text-muted);
  }
</style>
