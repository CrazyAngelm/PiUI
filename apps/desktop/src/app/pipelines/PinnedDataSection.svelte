<script lang="ts">
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import { t, language } from '../../features/locale/language';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import { pinningRefusal } from '../../host-api/pinnedData';
  import { Button } from '../../lib/ui';
  import { shortId } from '../runs/runPresentation';
  import type { PipelineEditorStore } from './editorStore.svelte';

  /**
   * Pinned data of the selected node (orchestration v6.4): where it came
   * from, what it holds and an Unpin action (one undo step; Save keeps it).
   * A run started with "Use pinned data" does not run a pinned step.
   */
  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
  }
  let { editor, node }: Props = $props();

  let open = $state(false);
  const pinned = $derived(node.pinnedOutput);
  const unused = $derived(pinningRefusal(node) !== undefined);
  const when = $derived.by(() => {
    const time = pinned ? Date.parse(pinned.pinnedAt) : Number.NaN;
    return Number.isFinite(time)
      ? new Date(time).toLocaleString($language === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : '';
  });
  const data = $derived(pinned?.data === undefined ? '' : JSON.stringify(pinned.data, null, 2));

  function unpin(): void {
    if (editor.readOnly) return;
    editor.updateNode(node.id, { pinnedOutput: undefined });
  }
</script>

{#if pinned}
  <section class="pinned" class:pinned--unused={unused} aria-labelledby="pinned-title-{node.id}">
    <div class="head">
      <span class="mark" aria-hidden="true"><Pin size={13} /></span>
      <div class="title">
        <h3 id="pinned-title-{node.id}">{$t('Pinned data')}</h3>
        <span class="meta">
          {[pinned.sourceRunId ? $t('From run #{0}', [shortId(pinned.sourceRunId)]) : '', when].filter(Boolean).join(' · ')}
        </span>
      </div>
      <Button size="sm" variant="ghost" aria-expanded={open} aria-controls="pinned-body-{node.id}" onclick={() => (open = !open)}>
        {open ? $t('Hide') : $t('View')}
      </Button>
      <Button size="sm" variant="ghost" disabled={editor.readOnly} onclick={unpin}>
        {#snippet leading()}<PinOff />{/snippet}
        {$t('Unpin')}
      </Button>
    </div>
    <p class="hint">
      {unused
        ? $t('This step always runs, so its pinned data is never used. Unpin it.')
        : $t('A run started with “Use pinned data” skips this step and passes this output to the next steps.')}
    </p>
    {#if open}
      <div class="body" id="pinned-body-{node.id}">
        {#if pinned.text !== undefined}
          <h4>{$t('Output')}</h4>
          <pre>{pinned.text}</pre>
          {#if pinned.truncated}<p class="hint">{$t('The output was longer than 256 KiB and was cut.')}</p>{/if}
        {/if}
        {#if pinned.data !== undefined}
          <h4>{$t('Result')}</h4>
          <pre>{data}</pre>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .pinned {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0 var(--piui-space-3) var(--piui-space-2);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid color-mix(in srgb, var(--piui-accent) 35%, var(--piui-border-subtle));
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-accent) 6%, var(--piui-surface-1));
  }
  .pinned--unused {
    border-color: var(--piui-warning);
    background: var(--piui-warning-surface);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .mark {
    display: inline-flex;
    flex: none;
    color: var(--piui-accent);
  }
  .title {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  h4 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .meta,
  .hint {
    margin: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
  }
  .meta {
    white-space: nowrap;
  }
  .body {
    display: grid;
    gap: var(--piui-space-2);
  }
  pre {
    max-height: 220px;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
