<script lang="ts">
  import { tick, untrack } from 'svelte';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
  import Unlink from '@lucide/svelte/icons/unlink';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import Link from '@lucide/svelte/icons/link';
  import PlugZap from '@lucide/svelte/icons/plug-zap';
  import { t } from '../../features/locale/language';
  import { boardToolNotice, type SessionNoticeCode } from '../../features/workspace/sessionNotices';
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';
  import { Menu, Picker, Tooltip, toasts, type PickerItem } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { boards } from './boardStore.svelte';
  import { STATUS_LABEL } from './boardModel';
  import { activeCardOf, linkableCards } from './chatBoard';

  /**
   * The chat's active card in the chat header (docs/BOARD.md "Chat ↔ card"):
   * `#N title` and status with Open on board / Change card / Unlink, or a
   * quiet "Link to card" when the project board is on. A badge says when the
   * agent of this chat cannot use the board tool.
   */
  interface Props {
    workspaceId: string;
    sessionId: string;
    harness: HarnessKind;
    notices: readonly SessionNoticeCode[];
  }
  let { workspaceId, sessionId, harness, notices }: Props = $props();
  const store = useWorkspace();

  $effect(() => {
    const id = workspaceId;
    untrack(() => boards.ensure([id]));
  });
  const board = $derived(boards.stores.get(workspaceId));
  const enabled = $derived(board?.enabled === true);
  // The board store reloads on every board-changed event; the active card follows it.
  const active = $derived(activeCardOf(board?.board, sessionId));
  const candidates = $derived(linkableCards(board?.board, '', active?.id));
  const pickerItems = $derived<PickerItem[]>(
    candidates.map((card) => ({
      value: card.id,
      label: `#${card.number} ${card.title}`,
      description: $t(STATUS_LABEL[card.status]),
      keywords: [`#${card.number}`, String(card.number), ...card.labels],
    })),
  );
  const notice = $derived(enabled ? boardToolNotice(harness, notices) : undefined);
  const noticeText = $derived(
    notice === 'unsupported-board-tool-resume'
      ? $t('This chat was resumed: {0} cannot add the board tool to a resumed conversation. Start a new chat to let the agent keep the board up to date. You can still link cards and hand off work yourself.', [harnessMeta(harness).label])
      : $t('{0} cannot use the board tool in this chat, so the agent does not see or change cards. You can still link cards and hand off work yourself.', [harnessMeta(harness).label]),
  );

  let pickerOpen = $state(false);
  let busy = $state(false);
  let chip = $state<HTMLButtonElement | null>(null);
  let anchor = $state<HTMLButtonElement | null>(null);

  // The picker opened from the chip menu returns focus to its hidden anchor; move it to the chip.
  let pickerWasOpen = false;
  $effect(() => {
    const open = pickerOpen;
    if (pickerWasOpen && !open) {
      setTimeout(() => {
        if (document.activeElement === anchor || document.activeElement === document.body) chip?.focus();
      }, 0);
    }
    pickerWasOpen = open;
  });

  async function act(action: () => Promise<unknown>, failure: string, done: string | undefined = undefined): Promise<void> {
    busy = true;
    try {
      await action();
      if (done) toasts.success(done);
    } catch (error) {
      toasts.error($t(failure), $t(errorMessage(error)));
    } finally {
      busy = false;
    }
  }

  function openOnBoard(): void {
    if (!active) return;
    store.selectWorkspace(workspaceId);
    store.navigate({ name: 'board', workspaceId, cardId: active.id });
  }

  async function changeCard(): Promise<void> {
    // Let the menu close and return focus before the picker takes it.
    await tick();
    setTimeout(() => (pickerOpen = true), 0);
  }

  function link(cardId: string): void {
    const target = board;
    if (!target) return;
    const card = target.card(cardId);
    void act(() => target.linkSession(cardId, sessionId), 'Could not link the card', card ? $t('Linked #{0} to this chat', [card.number]) : undefined).then(async () => {
      await tick();
      chip?.focus();
    });
  }

  function unlink(): void {
    const card = active;
    const target = board;
    if (!card || !target) return;
    void act(() => target.unlinkSession(card.id, sessionId), 'Could not unlink the card', $t('Unlinked #{0} from this chat', [card.number]));
  }
</script>

{#if enabled}
  <div class="board-chip">
    {#if active}
      <Menu
        align="start"
        items={[
          { label: $t('Open on board'), icon: SquareArrowOutUpRight, onSelect: openOnBoard },
          { label: $t('Change card…'), icon: ArrowRightLeft, disabled: store.safeMode || candidates.length === 0, onSelect: () => void changeCard() },
          { type: 'separator' as const },
          { label: $t('Unlink from this chat'), icon: Unlink, disabled: store.safeMode, onSelect: unlink },
        ]}
      >
        {#snippet trigger(props)}
          <button
            type="button"
            class="chip"
            bind:this={chip}
            {...props}
            disabled={busy}
            aria-label={$t('Active card: #{0} {1}, {2}', [active.number, active.title, $t(STATUS_LABEL[active.status])])}
          >
            <KanbanSquare size={13} aria-hidden="true" />
            <span class="chip__number">#{active.number}</span>
            <span class="chip__title">{active.title}</span>
            <span class="chip__status" data-status={active.status}>{$t(STATUS_LABEL[active.status])}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        {/snippet}
      </Menu>
    {/if}
    <Picker
      bind:open={pickerOpen}
      items={pickerItems}
      value={active?.id}
      label={$t('Link a card to this chat')}
      searchPlaceholder={$t('Search cards by #number or title')}
      emptyText={$t('No open cards')}
      width={360}
      onSelect={link}
    >
      {#snippet trigger(props)}
        {#if active}
          <!-- The picker opens from the chip menu; this anchor only positions it. -->
          <span class="anchor" aria-hidden="true"><button type="button" tabindex="-1" bind:this={anchor} {...props} aria-label={$t('Link a card to this chat')}></button></span>
        {:else}
          <button type="button" class="link" {...props} disabled={busy || store.safeMode}>
            <Link size={12} aria-hidden="true" />
            <span>{$t('Link to card')}</span>
          </button>
        {/if}
      {/snippet}
    </Picker>
    {#if notice}
      <Tooltip content={noticeText}>
        {#snippet trigger(props)}
          <button type="button" class="notice" {...props} aria-label={`${$t('Board tools unavailable')}. ${noticeText}`}>
            <PlugZap size={12} aria-hidden="true" />
            <span>{$t('Board tools unavailable')}</span>
          </button>
        {/snippet}
      </Tooltip>
    {/if}
  </div>
{/if}

<style>
  .board-chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 340px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-chaos-streak, transparent);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip:hover:not(:disabled),
  .chip[data-state='open'] {
    background: var(--piui-hover);
  }
  .chip__number {
    flex: none;
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .chip__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip__status {
    flex: none;
    padding: 0 6px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .chip__status[data-status='inProgress'],
  .chip__status[data-status='inReview'] {
    color: var(--piui-accent);
  }
  .chip__status[data-status='blocked'] {
    color: var(--piui-warning);
  }
  .anchor {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 1px;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
  }
  .anchor button {
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    opacity: 0;
  }
  .link,
  .notice {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    white-space: nowrap;
  }
  .link:hover:not(:disabled),
  .link[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .notice {
    border: 1px dashed var(--piui-border);
    color: var(--piui-text-disabled);
    cursor: help;
  }
</style>
