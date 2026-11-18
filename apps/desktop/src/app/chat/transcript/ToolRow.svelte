<script lang="ts">
  import { onDestroy } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import { useTranslation } from '../../../features/locale/context';
  import { useConversationPresentation } from '../../../shared/conversation/context';
  const t = useTranslation();
  const presentation = useConversationPresentation();
  let disposed = false;
  onDestroy(() => { disposed = true; });
  import type { TimelineBlock } from '../../../host-api/types';
  import { Badge, IconButton, Spinner } from '../../../lib/ui';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import DiffView from './DiffView.svelte';
  import { followEnd } from './followEnd';
  import { toolIcons } from './toolIcons';
  import { looksLikeDiff, reasoningPreview, toolKind, toolTitle } from './toolKinds';
  import SidekickBriefCard from '../../fusion/SidekickBriefCard.svelte';
  import { parseSidekickBlock, sidekickChip } from '../../fusion/sidekickBlock';

  interface Props {
    block: TimelineBlock;
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { block, open, onToggle }: Props = $props();

  const kind = $derived(toolKind(block));
  const Icon = $derived(toolIcons[kind]);
  // A Fusion lead's `sidekick` call (ADR-043) is a brief card; anything the parser
  // does not recognize keeps the generic row.
  const sidekick = $derived(kind === 'thinking' ? undefined : parseSidekickBlock(block));
  const sidekickState = $derived(sidekick ? sidekickChip(sidekick) : undefined);
  const title = $derived(
    kind === 'thinking'
      ? block.label === 'Plan'
        ? $t('Work plan')
        : block.status === 'streaming'
          ? $t('Thinking…')
          : $t('Reasoning')
      : sidekick
        ? [$t('Sidekick'), sidekick.briefId, sidekick.roundId].filter(Boolean).join(' · ')
        : toolTitle(block),
  );
  const body = $derived(block.text ?? block.safeSummary ?? '');
  // A reasoning row names itself by its first line, so a long turn reads without opening anything.
  const preview = $derived(kind === 'thinking' ? reasoningPreview(body, block.status === 'streaming') : '');
  const isDiff = $derived(kind === 'edit' && looksLikeDiff(block.text));
  // A plugin's own view of this tool (plugins v2). The plain view is always
  // one click away and takes over when the plugin is off or its frame fails.
  const renderer = $derived(kind === 'thinking' ? undefined : presentation.renderer?.(block));
  let plain = $state(false);
  let rendererFailed = $state(false);
  const pluginView = $derived(renderer !== undefined && !plain && !rendererFailed);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(body);
      if (!disposed) presentation.notify('success', $t('Copied'));
    } catch {
      if (!disposed) presentation.notify('error', $t('Could not copy'));
    }
  }
</script>

<div class="row" class:row--failed={block.status === 'failed'} class:row--open={open}>
  <button type="button" class="row__head" aria-expanded={open} onclick={() => onToggle(!open)} disabled={!body}>
    <span class="row__icon">
      {#if block.status === 'streaming'}<Spinner size={12} /><span class="visually-hidden">{$t('working…')}</span>{:else}<Icon size={14} />{/if}
    </span>
    <span class="row__title" class:row__title--mono={kind === 'command'} class:row__title--lead={preview !== ''} title={title}>{title}</span>
    {#if preview}<span class="row__preview">{preview}</span>{/if}
    {#if sidekickState}<Badge tone={sidekickState.tone}>{$t(sidekickState.label)}</Badge>{/if}
    {#if block.status === 'failed'}<span class="row__state row__state--failed">{$t('Failed')}</span>{/if}
    {#if block.status === 'interrupted'}<span class="row__state">{$t('Stopped')}</span>{/if}
    {#if body}<span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>{/if}
  </button>
  {#if open && body}
    <div class="row__body">
      {#if renderer}
        <div class="views" role="group" aria-label={$t('How to show this tool')}>
          <button type="button" class="views__option" aria-pressed={pluginView} disabled={rendererFailed} onclick={() => (plain = false)}>
            {$t('{0} (plugin {1})', [renderer.title, renderer.source])}
          </button>
          <button type="button" class="views__option" aria-pressed={!pluginView} onclick={() => (plain = true)}>{$t('Plain view')}</button>
        </div>
        {#if rendererFailed}
          <p class="note" role="status">
            {$t('The plugin view did not load, so the plain view is shown.')}
            <button type="button" class="note__retry" onclick={() => { rendererFailed = false; plain = false; }}>{$t('Try again')}</button>
          </p>
        {/if}
      {/if}
      {#if pluginView && renderer}
        {#key renderer.key}
          <renderer.component {block} onFailure={() => (rendererFailed = true)} />
        {/key}
      {:else if sidekick}
        <SidekickBriefCard view={sidekick} />
      {:else if isDiff}
        <DiffView text={body} />
      {:else if kind === 'thinking'}
        <div class="thinking"><MarkdownContent source={body} compact={true} streaming={block.status === 'streaming'} /></div>
      {:else}
        <div class="output">
          <pre use:followEnd={block.status === 'streaming'}>{body}</pre>
          <span class="output__copy"><IconButton size="sm" label={$t('Copy output')} onclick={() => void copy()}><Copy /></IconButton></span>
        </div>
      {/if}
      {#if block.truncated}<p class="note">{$t('Output was shortened to keep the chat responsive.')}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .row__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    width: 100%;
    min-height: 28px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .row__head:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .row__head:disabled {
    cursor: default;
    opacity: 1;
  }
  .row__icon {
    display: inline-flex;
    flex: none;
    width: 16px;
    justify-content: center;
    color: var(--piui-text-muted);
  }
  .row--failed .row__icon {
    color: var(--piui-danger);
  }
  .row__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row__title--lead {
    flex: none;
    max-width: 40%;
  }
  .row__preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row__title--mono {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .row__state {
    flex: none;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .row__state--failed {
    color: var(--piui-danger);
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
  .row__body {
    margin: 4px 0 8px 22px;
  }
  .output {
    position: relative;
  }
  .output pre {
    max-height: 360px;
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-chat-code-font-size);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .output__copy {
    position: absolute;
    top: 4px;
    right: 4px;
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .output:hover .output__copy,
  .output:focus-within .output__copy {
    opacity: 1;
  }
  .thinking {
    padding-left: 10px;
    border-left: 2px solid var(--piui-border);
    color: var(--piui-text-muted);
  }
  .note {
    margin: 4px 0 0;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .views {
    display: inline-flex;
    gap: 2px;
    margin-bottom: 6px;
    padding: 2px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
  }
  .views__option {
    padding: 2px 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .views__option[aria-pressed='true'] {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  .views__option:focus-visible,
  .note__retry:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .note__retry {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font: inherit;
    text-decoration: underline;
  }
</style>
