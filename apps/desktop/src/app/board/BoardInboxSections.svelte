<script lang="ts">
  import { untrack } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import { t } from '../../features/locale/language';
  import { Button, toasts } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { harnessMeta } from '../harnessMeta';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import type { BoardActorV1, BoardProposalV1, PendingStartV1 } from '../../host-api/boardClient';
  import { boards, type BoardStore } from './boardStore.svelte';
  import { operationCopy, STATUS_LABEL } from './boardModel';

  /**
   * Inbox sections of project boards (ADR-041): agent proposals waiting for
   * Accept/Reject and runs waiting for the person to start them.
   */
  const store = useWorkspace();
  const projectIds = $derived(store.catalog.workspaces.filter((item) => !item.personal && !item.missing).map((item) => item.id));
  $effect(() => {
    const ids = projectIds;
    untrack(() => {
      boards.ensure(ids);
      for (const id of ids) void teammates.ensure(id);
    });
  });

  const attention = $derived(boards.attention());
  const proposals = $derived(attention.flatMap((item) => item.proposals.map((proposal) => ({ ...item, proposal }))));
  const starts = $derived(attention.flatMap((item) => item.pendingStarts.map((pending) => ({ ...item, pending }))));
  let busy = $state<string | undefined>();

  const STATUS_NAMES = new Set<string>(Object.values(STATUS_LABEL));

  function projectName(workspaceId: string): string {
    return store.catalog.workspaces.find((item) => item.id === workspaceId)?.name ?? '';
  }

  function handleOf(workspaceId: string, teammateId: string | undefined): string {
    const teammate = teammates.get(workspaceId, teammateId);
    return teammate ? `@${teammate.handle}` : $t('a removed teammate');
  }

  function describe(board: BoardStore, proposal: BoardProposalV1): string {
    const copy = operationCopy(proposal.operation, board.board, (id) => handleOf(board.workspaceId, id));
    return $t(copy.text, copy.params.map((value) => (typeof value === 'string' && STATUS_NAMES.has(value) ? $t(value) : value)));
  }

  function actorText(actor: BoardActorV1, workspaceId: string): string {
    switch (actor.kind) {
      case 'person':
        return $t('You');
      case 'chatAgent':
        return $t('{0} in a chat', [harnessMeta(actor.harness).label]);
      case 'runMember':
        return actor.teammateId ? handleOf(workspaceId, actor.teammateId) : $t('A pipeline run');
      case 'host':
        return 'PiUI';
      default: {
        const exhaustive: never = actor;
        return exhaustive;
      }
    }
  }

  function cardLabel(board: BoardStore, cardId: string | undefined): string {
    const card = board.card(cardId);
    return card ? `#${card.number} ${card.title}` : '';
  }

  async function act(key: string, action: () => Promise<unknown>, failure: string): Promise<void> {
    busy = key;
    try {
      await action();
    } catch (error) {
      toasts.error($t(failure), $t(errorMessage(error)));
    } finally {
      busy = undefined;
    }
  }

  function openCard(workspaceId: string, cardId: string | undefined): void {
    store.selectWorkspace(workspaceId);
    store.navigate(cardId ? { name: 'board', workspaceId, cardId } : { name: 'board', workspaceId });
  }

  const pendingTeammate = (item: { workspaceId: string; pending: PendingStartV1 }) => teammates.get(item.workspaceId, item.pending.teammateId);
</script>

{#if proposals.length}
  <h2>{$t('Board proposals')} <span class="count">{proposals.length}</span></h2>
  <ul class="rows">
    {#each proposals as item (item.proposal.id)}
      <li class="row">
        <div class="row__text">
          <button type="button" class="row__title" onclick={() => openCard(item.workspaceId, item.proposal.cardId)}>{describe(item.store, item.proposal)}</button>
          <span class="muted">{actorText(item.proposal.actor, item.workspaceId)} · {projectName(item.workspaceId)}{item.proposal.cardId ? ` · ${cardLabel(item.store, item.proposal.cardId)}` : ''}</span>
        </div>
        <Button size="sm" variant="primary" disabled={busy !== undefined || store.safeMode} loading={busy === `a:${item.proposal.id}`} onclick={() => void act(`a:${item.proposal.id}`, () => item.store.resolveProposal(item.proposal.id, true), 'Could not accept the proposal')}>{$t('Accept')}</Button>
        <Button size="sm" variant="ghost" disabled={busy !== undefined || store.safeMode} onclick={() => void act(`r:${item.proposal.id}`, () => item.store.resolveProposal(item.proposal.id, false), 'Could not reject the proposal')}>{$t('Reject')}</Button>
      </li>
    {/each}
  </ul>
{/if}

{#if starts.length}
  <h2>{$t('Runs waiting to start')} <span class="count">{starts.length}</span></h2>
  <ul class="rows">
    {#each starts as item (item.pending.id)}
      {@const teammate = pendingTeammate(item)}
      <li class="row">
        {#if teammate}<TeammateAvatar avatar={teammate.avatar} color={teammate.color} size={22} />{/if}
        <div class="row__text">
          <button type="button" class="row__title" onclick={() => openCard(item.workspaceId, item.pending.cardId)}>
            {$t('Start {0} on {1}?', [handleOf(item.workspaceId, item.pending.teammateId), cardLabel(item.store, item.pending.cardId)])}
          </button>
          <span class="muted">{projectName(item.workspaceId)}</span>
        </div>
        <Button size="sm" variant="primary" disabled={busy !== undefined || store.safeMode} loading={busy === `s:${item.pending.id}`} onclick={() => void act(`s:${item.pending.id}`, () => item.store.resolvePendingStart(item.pending.id, true), 'Could not start the run')}>
          {#snippet leading()}<Play size={13} />{/snippet}{$t('Start')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== undefined || store.safeMode} onclick={() => void act(`d:${item.pending.id}`, () => item.store.resolvePendingStart(item.pending.id, false), 'Could not dismiss the start')}>{$t('Dismiss')}</Button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    margin: var(--piui-space-6) 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .count {
    padding: 0 6px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text);
    font-size: var(--piui-text-xs);
    letter-spacing: 0;
  }
  .rows {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 8px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-chaos-streak);
  }
  .row__text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .row__title {
    overflow: hidden;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-text);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row__title:hover {
    text-decoration: underline;
  }
  .muted {
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
