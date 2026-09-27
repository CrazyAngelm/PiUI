<script lang="ts">
  import Terminal from '@lucide/svelte/icons/terminal';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import FileText from '@lucide/svelte/icons/file-text';
  import Search from '@lucide/svelte/icons/search';
  import Globe from '@lucide/svelte/icons/globe';
  import Workflow from '@lucide/svelte/icons/workflow';
  import Wrench from '@lucide/svelte/icons/wrench';
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import { t } from '../../../features/locale/language';
  import type { TimelineBlock } from '../../../host-api/types';
  import { IconButton, Spinner, toasts } from '../../../lib/ui';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import DiffView from './DiffView.svelte';
  import { looksLikeDiff, toolKind, toolTitle, type ToolKind } from './toolKinds';
  import { rendererActivity } from '../../../host-api/pluginBridge';
  import { pluginRegistry } from '../../plugins/pluginRegistry.svelte';

  interface Props {
    block: TimelineBlock;
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { block, open, onToggle }: Props = $props();

  const icons: Record<ToolKind, typeof Terminal> = {
    thinking: Brain,
    command: Terminal,
    edit: FilePen,
    read: FileText,
    search: Search,
    web: Globe,
    agent: Workflow,
    tool: Wrench,
  };
  const kind = $derived(toolKind(block));
  const Icon = $derived(icons[kind]);
  const title = $derived(kind === 'thinking' ? $t('Reasoning') : toolTitle(block));
  const body = $derived(block.text ?? block.safeSummary ?? '');
  const isDiff = $derived(kind === 'edit' && looksLikeDiff(block.text));
  // A plugin's own view of this tool (plugins v2). The plain view is always
  // one click away and takes over when the plugin is off or its frame fails.
  const renderer = $derived(kind === 'thinking' ? undefined : pluginRegistry.renderer(block.toolName));
  let plain = $state(false);
  let rendererFailed = $state(false);
  const pluginView = $derived(renderer !== undefined && !plain && !rendererFailed);
  const activity = $derived(renderer ? rendererActivity(block) : undefined);
  // The frame is plugin code's host: its own chunk, loaded only when needed.
  let Frame = $state<typeof import('../../plugins/PluginPanelFrame.svelte').default | undefined>();
  $effect(() => {
    if (!pluginView || !open || Frame) return;
    import('../../plugins/PluginPanelFrame.svelte')
      .then((module) => (Frame = module.default))
      .catch(() => (rendererFailed = true));
  });

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(body);
      toasts.success($t('Copied'));
    } catch {
      toasts.error($t('Could not copy'));
    }
  }
</script>

<div class="row" class:row--failed={block.status === 'failed'} class:row--open={open}>
  <button type="button" class="row__head" aria-expanded={open} onclick={() => onToggle(!open)} disabled={!body}>
    <span class="row__icon">
      {#if block.status === 'streaming'}<Spinner size={12} />{:else}<Icon size={14} />{/if}
    </span>
    <span class="row__title" class:row__title--mono={kind === 'command'} title={title}>{title}</span>
    {#if block.status === 'failed'}<span class="row__state row__state--failed">{$t('Failed')}</span>{/if}
    {#if block.status === 'interrupted'}<span class="row__state">{$t('Stopped')}</span>{/if}
    {#if body}<span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>{/if}
  </button>
  {#if open && body}
    <div class="row__body">
      {#if renderer}
        <div class="views" role="group" aria-label={$t('How to show this tool')}>
          <button type="button" class="views__option" aria-pressed={pluginView} disabled={rendererFailed} onclick={() => (plain = false)}>
            {$t('{0} (plugin {1})', [renderer.renderer.title, renderer.plugin.name])}
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
      {#if pluginView && renderer && activity}
        {#if Frame}
          <Frame
            plugin={renderer.plugin}
            panel={{ id: renderer.renderer.id, title: renderer.renderer.title, url: renderer.renderer.url }}
            chat={null}
            {activity}
            onStatus={(status) => {
              if (status === 'failed') rendererFailed = true;
            }}
          />
        {/if}
      {:else if isDiff}
        <DiffView text={body} />
      {:else if kind === 'thinking'}
        <div class="thinking"><MarkdownContent source={body} compact={true} /></div>
      {:else}
        <div class="output">
          <pre>{body}</pre>
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
  .row__title--mono {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .row__state {
    flex: none;
    color: var(--piui-warning);
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
