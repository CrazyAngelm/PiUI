<script lang="ts">
  import { tick, untrack } from 'svelte';
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
    /** This chat has a message box (not a sidekick, a pipeline member, a stopped or read-only chat). */
    canMessage?: boolean;
    /** Test seam; the chat uses the shared store. */
    surfaces?: ExtensionSurfaces;
  }
  let { sessionId, status, placement, agentLabel, canMessage = false, surfaces = extensionSurfaces }: Props = $props();
  let replaceButton = $state<HTMLButtonElement | null>(null);

  const view = $derived(surfaces.stateFor(sessionId));
  // Only errors are kept (extensionUiState): said plainly, with the extension's own words behind Details.
  const notices = $derived(view.notifications);

  /** Puts a question about the error in the message box; a typed draft is kept as a suggestion.
   * The focus follows the text: to the message box, or to "Replace draft" when a draft was kept. */
  async function askAgent(notice: { id: string; message: string }, event: MouseEvent): Promise<void> {
    const zone = (event.currentTarget as HTMLElement | null)?.closest('.composer-zone');
    const question = [$t('The {0} extension reported an error:', [agentLabel]), notice.message, $t('What does it mean, and does anything need to be done?')];
    surfaces.prepareText(sessionId, question.join('\n\n'));
    surfaces.dismissNotice(sessionId, notice.id);
    await tick();
    if (view.editorSuggestion !== undefined) replaceButton?.focus();
    else zone?.querySelector<HTMLTextAreaElement>('[data-nano-composer="root"] textarea')?.focus();
  }
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
    document.title = `${title} — Nano Desktop`;
    return () => {
      document.title = previous;
    };
  });
</script>

{#if placement === 'above'}
  {#if notices.length}
    <div class="notices" aria-label={$t('Extension notices')}>
      {#each notices as notice (notice.id)}
        <div class="notice notice--{notice.level}" role="alert">
          <Puzzle class="notice__icon" size={14} aria-hidden="true" />
          <div class="notice__body">
            <p class="notice__title">{$t('A {0} extension reported an error. The chat keeps working: close this, or ask the agent what it means.', [agentLabel])}</p>
            <details class="notice__details">
              <summary>{$t('Details')}</summary>
              <p>{notice.message}</p>
            </details>
          </div>
          <div class="notice__actions">
            {#if canMessage}
              <Button size="sm" variant="ghost" onclick={(event: MouseEvent) => void askAgent(notice, event)}>{$t('Ask the agent')}</Button>
            {/if}
            <IconButton size="sm" tooltip={false} label={$t('Dismiss notice')} onclick={() => surfaces.dismissNotice(sessionId, notice.id)}><X /></IconButton>
          </div>
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
    <Button size="sm" bind:ref={replaceButton} onclick={() => surfaces.acceptSuggestion(sessionId)}>{$t('Replace draft')}</Button>
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
    border-left: 3px solid var(--piui-danger);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    font-size: var(--piui-text-sm);
  }
  .notice :global(.notice__icon) {
    margin-top: 5px;
    color: var(--piui-text-muted);
  }
  .notice__body {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .notice__title {
    margin: 4px 0 0;
  }
  .notice__details summary {
    width: fit-content;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    cursor: pointer;
  }
  .notice__details p {
    margin: 4px 0 2px;
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .notice__actions {
    display: flex;
    align-items: center;
    gap: 2px;
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
