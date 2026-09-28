<script lang="ts">
  import { untrack } from 'svelte';
  import SquareKanban from '@lucide/svelte/icons/square-kanban';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import { t } from '../../features/locale/language';
  import { Button, IconButton, toasts } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import type { BoardProposalV1 } from '../../host-api/boardClient';
  import { boards } from './boardStore.svelte';
  import { changeCopy, operationCopy, STATUS_LABEL } from './boardModel';
  import { chatProposals, lastUserMessageAt, recentAgentChanges, type ChatBoardChange } from './chatBoard';

  /**
   * Board activity of this chat's agent near the composer (docs/BOARD.md
   * "Chat ↔ card"): its pending proposals with Accept/Reject, and a collapsible
   * strip of the changes it applied since the person last wrote, with Undo.
   */
  interface Props {
    workspaceId: string;
    sessionId: string;
    blocks: readonly { kind: string; createdAt?: string }[];
  }
  let { workspaceId, sessionId, blocks }: Props = $props();
  const store = useWorkspace();

  $effect(() => {
    const id = workspaceId;
    untrack(() => {
      boards.ensure([id]);
      void teammates.ensure(id);
    });
  });
  const board = $derived(boards.stores.get(workspaceId));
  const enabled = $derived(board?.enabled === true);
  const proposals = $derived(enabled ? chatProposals(board?.board, sessionId) : []);
  const since = $derived(lastUserMessageAt(blocks));
  const changes = $derived(enabled ? recentAgentChanges(board?.board, sessionId, since) : []);
  let expanded = $state(false);
  let busy = $state<string | undefined>();

  const STATUS_NAMES = new Set<string>(Object.values(STATUS_LABEL));
  const localize = (params: readonly (string | number)[]): (string | number)[] =>
    params.map((value) => (typeof value === 'string' && STATUS_NAMES.has(value) ? $t(value) : value));

  function handleOf(teammateId: string | undefined): string {
    const teammate = teammates.get(workspaceId, teammateId);
    return teammate ? `@${teammate.handle}` : $t('a removed teammate');
  }

  function describe(proposal: BoardProposalV1): string {
    const copy = operationCopy(proposal.operation, board?.board, handleOf);
    return $t(copy.text, localize(copy.params));
  }

  function reason(proposal: BoardProposalV1): string | undefined {
    return proposal.operation.op === 'move' ? proposal.operation.reason : undefined;
  }

  function changeText(change: ChatBoardChange): string {
    const copy = changeCopy(change.activity.change, handleOf);
    return `#${change.card.number} · ${$t(copy.text, localize(copy.params))}`;
  }

  async function act(key: string, action: () => Promise<unknown>, failure: string, done: string): Promise<void> {
    busy = key;
    try {
      await action();
      toasts.success(done);
    } catch (error) {
      toasts.error($t(failure), $t(errorMessage(error)));
    } finally {
      busy = undefined;
    }
  }

  function resolve(proposal: BoardProposalV1, accept: boolean): void {
    const target = board;
    if (!target) return;
    void act(
      `${accept ? 'a' : 'r'}:${proposal.id}`,
      () => target.resolveProposal(proposal.id, accept),
      accept ? 'Could not accept the proposal' : 'Could not reject the proposal',
      accept ? $t('Accepted: {0}', [describe(proposal)]) : $t('Rejected: {0}', [describe(proposal)]),
    );
  }

  function undo(change: ChatBoardChange): void {
    const target = board;
    if (!target) return;
    void act(`u:${change.activity.id}`, () => target.undo(change.card.id, change.activity.id), 'Could not undo the change', $t('Undid a change on #{0}', [change.card.number]));
  }
</script>

{#if proposals.length}
  <ul class="proposals" aria-label={$t('Board proposals from this chat')}>
    {#each proposals as proposal (proposal.id)}
      {@const text = describe(proposal)}
      {@const why = reason(proposal)}
      <li class="proposal">
        <SquareKanban size={14} aria-hidden="true" />
        <div class="proposal__text">
          <span>{$t('Agent proposes: {0}', [text])}</span>
          {#if why}<span class="muted">{why}</span>{/if}
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== undefined || store.safeMode}
          loading={busy === `a:${proposal.id}`}
          aria-label={$t('Accept: {0}', [text])}
          onclick={() => resolve(proposal, true)}>{$t('Accept')}</Button
        >
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== undefined || store.safeMode}
          loading={busy === `r:${proposal.id}`}
          aria-label={$t('Reject: {0}', [text])}
          onclick={() => resolve(proposal, false)}>{$t('Reject')}</Button
        >
      </li>
    {/each}
  </ul>
{/if}

{#if changes.length}
  <section class="updates" aria-label={$t('Board updates from this chat')}>
    <button type="button" class="updates__toggle" aria-expanded={expanded} aria-controls={`board-updates-${sessionId}`} onclick={() => (expanded = !expanded)}>
      <ChevronRight size={12} class={expanded ? 'rotated' : ''} aria-hidden="true" />
      <span>{$t('Board updates')}</span>
      <span class="count">{changes.length}</span>
      {#if !expanded && changes[0]}<span class="muted updates__last">{changeText(changes[0])}</span>{/if}
    </button>
    {#if expanded}
      <ul class="updates__list" id={`board-updates-${sessionId}`}>
        {#each changes as change (change.activity.id)}
          {@const text = changeText(change)}
          <li class="update">
            <span class="update__text">{text}</span>
            <IconButton size="sm" label={$t('Undo: {0}', [text])} disabled={busy !== undefined || store.safeMode} onclick={() => undo(change)}><Undo2 /></IconButton>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .proposals,
  .updates__list {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .proposal {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 8px 6px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-left: 2px solid var(--piui-accent);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-raised);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .proposal__text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .proposal__text > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .updates {
    display: grid;
    gap: 4px;
  }
  .updates__toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-align: left;
  }
  .updates__toggle:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .updates__toggle :global(.rotated) {
    transform: rotate(90deg);
  }
  .updates__last {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    padding: 0 6px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text);
  }
  .update {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 2px 6px 2px 24px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .update__text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
