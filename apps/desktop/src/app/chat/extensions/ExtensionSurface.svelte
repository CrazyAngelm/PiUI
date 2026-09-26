<script lang="ts">
  import { untrack } from 'svelte';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import X from '@lucide/svelte/icons/x';
  import { t } from '../../../features/locale/language';
  import type { SessionStatus } from '../../../../../../contracts/workspace-v15';
  import { Button, IconButton } from '../../../lib/ui';
  import { extensionSurfaces, type ExtensionSurfaces } from './extensionSurfaces.svelte';

  interface Props {
    sessionId: string;
    status: SessionStatus;
    /** `above` owns notices, statuses, the title and prepared text; `below` shows lower widgets. */
    placement: 'above' | 'below';
    agentLabel: string;
    /** Test seam; the chat uses the shared store. */
    surfaces?: ExtensionSurfaces;
  }
  let { sessionId, status, placement, agentLabel, surfaces = extensionSurfaces }: Props = $props();

  const view = $derived(surfaces.stateFor(sessionId));
  const widgets = $derived(view.widgets.filter((widget) => widget.placement === (placement === 'above' ? 'aboveEditor' : 'belowEditor')));

  // A stopped runtime no longer owns what its extensions showed.
  $effect(() => {
    if (placement === 'above' && (status === 'closed' || status === 'failed')) untrack(() => surfaces.clear(sessionId));
  });

  // The extension's title applies while this chat is on screen.
  $effect(() => {
    if (placement !== 'above' || typeof document === 'undefined') return;
    const title = view.title;
    if (!title) return;
    const previous = document.title;
    document.title = `${title} — PiUI`;
    return () => {
      document.title = previous;
    };
  });
</script>

{#if placement === 'above'}
  {#if view.notifications.length}
    <div class="notices" aria-label={$t('Extension notices')}>
      {#each view.notifications as notice (notice.id)}
        <div class="notice notice--{notice.level}" role={notice.level === 'error' ? 'alert' : 'status'}>
          <span class="notice__source"><Puzzle size={13} /> {$t('{0} extension', [agentLabel])}</span>
          <p>{notice.message}</p>
          <IconButton size="sm" tooltip={false} label={$t('Dismiss notice')} onclick={() => surfaces.dismissNotice(sessionId, notice.id)}><X /></IconButton>
        </div>
      {/each}
    </div>
  {/if}
  {#if view.statuses.length}
    <ul class="statuses" aria-label={$t('Extension status')}>
      {#each view.statuses as item (item.key)}<li>{item.text}</li>{/each}
    </ul>
  {/if}
{/if}

{#each widgets as widget (widget.key)}
  <aside class="widget" aria-label={$t('Extension panel')}>
    {#each widget.lines as line, index (index)}<p>{line}</p>{/each}
  </aside>
{/each}

{#if placement === 'above' && view.editorSuggestion !== undefined}
  <div class="suggestion" role="status">
    <span>{$t('An extension prepared text for the message box. Your draft was kept.')}</span>
    <Button size="sm" variant="ghost" onclick={() => surfaces.discardSuggestion(sessionId)}>{$t('Discard')}</Button>
    <Button size="sm" onclick={() => surfaces.acceptSuggestion(sessionId)}>{$t('Replace draft')}</Button>
  </div>
{/if}

<style>
  .notices {
    display: grid;
    gap: var(--piui-space-1);
  }
  .notice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--piui-space-2);
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-left: 3px solid var(--piui-accent);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    font-size: var(--piui-text-sm);
  }
  .notice--warning {
    border-left-color: var(--piui-warning);
  }
  .notice--error {
    border-left-color: var(--piui-danger);
  }
  .notice__source {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 3px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    white-space: nowrap;
  }
  .notice p {
    margin: 3px 0 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .statuses {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .statuses li {
    max-width: 100%;
    padding: 1px 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    overflow-wrap: anywhere;
  }
  .widget {
    padding: 6px 0 6px var(--piui-space-3);
    border-left: 2px solid var(--piui-border-strong);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .widget p {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .suggestion {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 6px 6px 10px;
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .suggestion span {
    flex: 1;
    min-width: 12em;
  }
</style>
