<script lang="ts">
  import { tick, untrack } from 'svelte';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Link from '@lucide/svelte/icons/link';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import { t } from '../../features/locale/language';
  import { Button, EmptyState, IconButton, Input, Skeleton, StatusDot, toasts } from '../../lib/ui';
  import type { CardStatusV1, CardV1 } from '../../host-api/boardClient';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';
  import { boards } from './boardStore.svelte';
  import { boardIntents } from './intents.svelte';
  import { COLLAPSIBLE, columnsOf, hasLiveRun, linkCount, orderAt, PRIORITY_LABEL, STATUS_LABEL, type BoardFilter } from './boardModel';
  import { boardKey, clampFocus, focusOf, type BoardFocus, type KeyColumn } from './boardKeyboard';
  import BoardSettings from './BoardSettings.svelte';
  import CardDrawer from './CardDrawer.svelte';

  interface Props {
    workspaceId: string;
    cardId?: string;
  }
  let { workspaceId, cardId }: Props = $props();

  const store = useWorkspace();
  // The shell keys this view by project, so the store is picked once (creating it writes state).
  // svelte-ignore state_referenced_locally
  const board = boards.get(workspaceId);
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === workspaceId));
  const team = $derived(teammates.list(workspaceId));
  $effect(() => {
    const id = workspaceId;
    untrack(() => void teammates.ensure(id));
  });
  // Availability follows board runs: refresh the team when the board changes.
  $effect(() => {
    if (board.board?.revision !== undefined) untrack(() => void teammates.load(workspaceId));
  });

  let filter = $state<BoardFilter>({ text: '', teammate: '' });
  let expanded = $state<CardStatusV1[]>([]);
  let newCardStatus = $state<CardStatusV1 | undefined>();
  let newCardTitle = $state('');
  let creating = $state(false);
  let focus = $state<BoardFocus | undefined>();
  let announcement = $state('');
  let filterInput = $state<HTMLInputElement | null>(null);
  let newCardInput = $state<HTMLInputElement | null>(null);
  let columnsElement = $state<HTMLElement | null>(null);
  let dragging = $state<string | undefined>();
  let dropStatus = $state<CardStatusV1 | undefined>();

  const columns = $derived(columnsOf(board.board, filter));
  const keyColumns = $derived<KeyColumn[]>(
    columns.map((column) => ({
      status: column.status,
      cardIds: COLLAPSIBLE.has(column.status) && !expanded.includes(column.status) ? [] : column.cards.map((card) => card.id),
    })),
  );
  const activeFocus = $derived(clampFocus(keyColumns, focus));
  const tabStop = $derived(activeFocus ? keyColumns[activeFocus.column]?.cardIds[activeFocus.row] : undefined);
  const openCard = $derived(board.card(cardId));
  const pendingByCard = $derived(new Set((board.board?.pendingStarts ?? []).map((item) => item.cardId)));
  const filtered = $derived(filter.text.trim() !== '' || filter.teammate !== '');

  $effect(() => {
    if (board.enabled && boardIntents.newCard === workspaceId) untrack(() => {
      if (boardIntents.takeNewCard(workspaceId)) void startNewCard('todo');
    });
  });

  function announce(text: string): void {
    // Re-announce identical text by clearing first.
    announcement = '';
    void tick().then(() => (announcement = text));
  }

  function statusText(status: CardStatusV1): string {
    return $t(STATUS_LABEL[status]);
  }

  function focusCard(id: string): void {
    const found = focusOf(keyColumns, id);
    if (found) focus = found;
    void tick().then(() => columnsElement?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus());
  }

  function open(card: CardV1): void {
    focus = focusOf(keyColumns, card.id) ?? focus;
    store.navigate({ name: 'board', workspaceId, cardId: card.id });
  }

  function closeDrawer(): void {
    const id = cardId;
    store.navigate({ name: 'board', workspaceId });
    if (id) focusCard(id);
  }

  async function move(card: CardV1, to: CardStatusV1, order: number | undefined = undefined): Promise<void> {
    if (card.status === to && order === undefined) return;
    if (COLLAPSIBLE.has(to) && !expanded.includes(to)) expanded = [...expanded, to];
    const label = statusText(to);
    announce($t('Moved #{0} to {1}', [card.number, label]));
    focusCard(card.id);
    try {
      await board.moveCard(card.id, to, order);
    } catch (error) {
      announce($t('Could not move #{0}; it is back in {1}', [card.number, statusText(card.status)]));
      toasts.error($t('Could not move the card'), $t(errorMessage(error)));
    }
  }

  async function startNewCard(status: CardStatusV1): Promise<void> {
    newCardStatus = status;
    newCardTitle = '';
    await tick();
    newCardInput?.focus();
  }

  async function createCard(): Promise<void> {
    const title = newCardTitle.trim();
    if (!title || creating || newCardStatus === undefined) return;
    creating = true;
    try {
      const card = await board.createCard({ title }, newCardStatus);
      newCardTitle = '';
      if (card) announce($t('Created #{0} in {1}', [card.number, statusText(card.status)]));
    } catch (error) {
      toasts.error($t('Could not create the card'), $t(errorMessage(error)));
    } finally {
      creating = false;
    }
  }

  function cancelNewCard(): void {
    newCardStatus = undefined;
    newCardTitle = '';
  }

  async function enable(): Promise<void> {
    try {
      await board.setEnabled(true);
    } catch (error) {
      toasts.error($t('Could not enable the board'), $t(errorMessage(error)));
    }
  }

  function isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !board.enabled) return;
    if (isTyping(event.target)) {
      if (event.key === 'Escape' && event.target === filterInput) {
        event.preventDefault();
        if (filter.text) filter.text = '';
        else if (tabStop) focusCard(tabStop);
      }
      return;
    }
    // Arrows, Enter and Escape act on the focused card; buttons keep their own keys.
    const onTile = event.target instanceof HTMLElement && event.target.closest('[data-card-id]') !== null;
    if (!onTile && !['n', 'N', '/'].includes(event.key)) return;
    const action = boardKey(event, keyColumns, activeFocus);
    switch (action.type) {
      case 'none':
        return;
      case 'focus':
        event.preventDefault();
        focus = action.focus;
        focusCard(action.cardId);
        return;
      case 'move': {
        event.preventDefault();
        const card = board.card(action.cardId);
        if (card) void move(card, action.to);
        return;
      }
      case 'open': {
        event.preventDefault();
        const card = board.card(action.cardId);
        if (card) open(card);
        return;
      }
      case 'new':
        event.preventDefault();
        void startNewCard(action.status);
        return;
      case 'filter':
        event.preventDefault();
        filterInput?.focus();
        return;
      case 'close':
        if (openCard) {
          event.preventDefault();
          closeDrawer();
        } else if (newCardStatus) {
          event.preventDefault();
          cancelNewCard();
        }
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  function toggleColumn(status: CardStatusV1): void {
    expanded = expanded.includes(status) ? expanded.filter((item) => item !== status) : [...expanded, status];
  }

  // ---- drag and drop (an enhancement over Shift+Arrow) ----------------------

  const DRAG_TYPE = 'application/x-piui-card';

  function dragStart(event: DragEvent, card: CardV1): void {
    dragging = card.id;
    event.dataTransfer?.setData(DRAG_TYPE, card.id);
    event.dataTransfer?.setData('text/plain', `#${card.number} ${card.title}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function dragOver(event: DragEvent, status: CardStatusV1): void {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropStatus = status;
  }

  function drop(event: DragEvent, status: CardStatusV1, cards: readonly CardV1[]): void {
    event.preventDefault();
    const id = event.dataTransfer?.getData(DRAG_TYPE) || dragging;
    dragging = undefined;
    dropStatus = undefined;
    const card = id ? board.card(id) : undefined;
    if (!card) return;
    const list = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const items = list ? [...list.querySelectorAll<HTMLElement>('[data-card-id]')].filter((item) => item.dataset.cardId !== card.id) : [];
    const index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    const order = index < 0 ? undefined : orderAt(cards, index, card.id);
    void move(card, status, order);
  }

  function assigneeOf(card: CardV1) {
    return card.assignee ? teammates.get(workspaceId, card.assignee) : undefined;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (The board's keyboard model handles keys bubbling from its cards.) -->
<section class="board" aria-labelledby="board-title" onkeydown={keydown}>
  <header class="head">
    <div class="head__title">
      <KanbanSquare size={18} aria-hidden="true" />
      <h1 id="board-title">{$t('Board')}</h1>
      {#if workspace}<span class="head__project">{workspace.name}</span>{/if}
    </div>
    {#if board.enabled}
      <div class="head__tools">
        <div class="filter">
          <Input
            bind:ref={filterInput}
            bind:value={filter.text}
            size="sm"
            placeholder={$t('Filter cards')}
            aria-label={$t('Filter cards by text or #number')}
          >
            {#snippet leading()}<Search size={14} />{/snippet}
          </Input>
        </div>
        <label class="visually-hidden" for="board-teammate-filter">{$t('Filter by teammate')}</label>
        <select id="board-teammate-filter" class="select" bind:value={filter.teammate}>
          <option value="">{$t('Everyone')}</option>
          <option value="unassigned">{$t('Unassigned')}</option>
          {#each team as teammate (teammate.id)}
            <option value={teammate.id}>@{teammate.handle}</option>
          {/each}
        </select>
        <IconButton label={$t('Team')} onclick={() => store.navigate({ name: 'team', workspaceId })}><UsersRound size={16} /></IconButton>
        <BoardSettings {board} />
        <Button size="sm" variant="primary" onclick={() => void startNewCard('todo')} disabled={store.safeMode} title={$t('New card (N)')}>
          {#snippet leading()}<Plus size={14} />{/snippet}
          {$t('New card')}
        </Button>
      </div>
    {/if}
  </header>

  {#if board.loading && !board.board}
    <div class="loading"><Skeleton lines={6} /></div>
  {:else if board.error && !board.board}
    <EmptyState title={$t('The board could not be loaded')} description={$t(board.error)}>
      {#snippet actions()}<Button onclick={() => void board.load()}>{$t('Retry')}</Button>{/snippet}
    </EmptyState>
  {:else if !board.enabled}
    <div class="disabled">
      <EmptyState
        icon={KanbanSquare}
        title={$t('Plan work on a board')}
        description={$t('Cards are durable intent for you and every agent of this project. Hand a card to a teammate, and agents in chats keep it up to date.')}
      >
        {#snippet actions()}
          <Button variant="primary" onclick={() => void enable()} disabled={store.safeMode}>{$t('Enable board')}</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <p class="hint">{$t('Arrows move between cards, Shift+Left or Right moves a card, Enter opens it, N adds a card and / filters.')}</p>
    <div class="columns" bind:this={columnsElement}>
      {#each columns as column (column.status)}
        {@const collapsible = COLLAPSIBLE.has(column.status)}
        {@const collapsed = collapsible && !expanded.includes(column.status)}
        {@const headingId = `board-col-${column.status}`}
        <section class="column" class:column--collapsed={collapsed} class:column--drop={dropStatus === column.status} aria-labelledby={headingId} data-status={column.status}>
          <header class="column__head">
            {#if collapsible}
              <button type="button" class="column__toggle" aria-expanded={!collapsed} onclick={() => toggleColumn(column.status)}>
                <span class="chevron" class:chevron--open={!collapsed}><ChevronRight size={12} /></span>
                <h2 id={headingId}>{statusText(column.status)}</h2>
              </button>
            {:else}
              <h2 id={headingId}>{statusText(column.status)}</h2>
            {/if}
            <span class="column__count" aria-label={filtered ? $t('{0} of {1} cards shown', [column.cards.length, column.total]) : $t('{0} cards', [column.total])}>
              {filtered ? `${column.cards.length}/${column.total}` : column.total}
            </span>
            {#if !collapsed}
              <button type="button" class="column__add" aria-label={$t('Add a card to {0}', [statusText(column.status)])} onclick={() => void startNewCard(column.status)} disabled={store.safeMode}>
                <Plus size={13} />
              </button>
            {/if}
          </header>

          {#if newCardStatus === column.status}
            <form class="new-card" onsubmit={(event) => { event.preventDefault(); void createCard(); }}>
              <Input
                bind:ref={newCardInput}
                bind:value={newCardTitle}
                size="sm"
                maxlength={200}
                placeholder={$t('Card title')}
                aria-label={$t('Title of the new card in {0}', [statusText(column.status)])}
                onkeydown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelNewCard();
                  }
                }}
              />
              <div class="new-card__actions">
                <Button size="sm" variant="ghost" onclick={cancelNewCard}>{$t('Cancel')}</Button>
                <Button size="sm" variant="primary" type="submit" loading={creating} disabled={!newCardTitle.trim()}>{$t('Add card')}</Button>
              </div>
            </form>
          {/if}

          {#if !collapsed}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Drop target; Shift+Left/Right is the keyboard path.) -->
            <ul
              class="column__list"
              aria-label={$t('{0} cards', [statusText(column.status)])}
              ondragover={(event) => dragOver(event, column.status)}
              ondragleave={() => (dropStatus = dropStatus === column.status ? undefined : dropStatus)}
              ondrop={(event) => drop(event, column.status, column.cards)}
            >
              {#each column.cards as card (card.id)}
                {@const assignee = assigneeOf(card)}
                {@const live = hasLiveRun(card)}
                {@const waiting = pendingByCard.has(card.id)}
                {@const links = linkCount(card)}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <li
                  class="tile"
                  class:tile--current={cardId === card.id}
                  class:tile--dragging={dragging === card.id}
                  data-card-id={card.id}
                  data-priority={card.priority}
                  tabindex={tabStop === card.id ? 0 : -1}
                  draggable={!store.safeMode}
                  aria-label={`#${card.number} ${card.title}`}
                  aria-describedby={`tile-meta-${card.id}`}
                  onfocus={() => (focus = focusOf(keyColumns, card.id) ?? focus)}
                  onclick={() => open(card)}
                  ondragstart={(event) => dragStart(event, card)}
                  ondragend={() => { dragging = undefined; dropStatus = undefined; }}
                >
                  <span class="tile__blade" aria-hidden="true"></span>
                  <div class="tile__top">
                    <span class="tile__number">#{card.number}</span>
                    {#if live}
                      <StatusDot status="running" label={$t('A run is working on it')} />
                    {:else if card.claim}
                      <StatusDot status="waiting" label={$t('Claimed')} />
                    {:else if waiting}
                      <StatusDot status="waiting" label={$t('Waiting for you to start a run')} />
                    {/if}
                    <span class="tile__spacer"></span>
                    {#if assignee}
                      <TeammateAvatar avatar={assignee.avatar} color={assignee.color} size={18} label={`@${assignee.handle}`} />
                    {/if}
                  </div>
                  <p class="tile__title">{card.title}</p>
                  <div class="tile__meta" id={`tile-meta-${card.id}`}>
                    {#if card.priority !== 'normal'}
                      <span class="priority priority--{card.priority}">{$t(PRIORITY_LABEL[card.priority])}</span>
                    {/if}
                    {#each card.labels.slice(0, 3) as label (label)}
                      <span class="label">{label}</span>
                    {/each}
                    {#if card.labels.length > 3}<span class="label">+{card.labels.length - 3}</span>{/if}
                    {#if links > 0}
                      <span class="links" title={$t('{0} linked chats and runs', [links])}><Link size={11} aria-hidden="true" />{links}</span>
                    {/if}
                    <span class="visually-hidden">{statusText(card.status)}{assignee ? `, @${assignee.handle}` : ''}</span>
                  </div>
                </li>
              {/each}
              {#if column.cards.length === 0}
                <li class="column__empty">{filtered && column.total > 0 ? $t('No matching cards') : $t('No cards')}</li>
              {/if}
            </ul>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  <div class="visually-hidden" aria-live="polite" role="status">{announcement}</div>
</section>

{#if openCard}
  <CardDrawer {board} card={openCard} {workspaceId} onClose={closeDrawer} onAnnounce={announce} />
{/if}

<style>
  .board {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    flex-wrap: wrap;
    padding: var(--piui-space-4) var(--piui-space-6) var(--piui-space-2);
    flex: none;
  }
  .head__title {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
    color: var(--piui-chaos);
  }
  h1 {
    margin: 0;
    color: var(--piui-text);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .head__project {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .head__tools {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    flex-wrap: wrap;
  }
  .filter {
    width: 220px;
  }
  .select {
    height: var(--piui-control-sm, 28px);
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .hint {
    margin: 0;
    padding: 0 var(--piui-space-6) var(--piui-space-2);
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .loading,
  .disabled {
    width: min(640px, calc(100% - 48px));
    margin: var(--piui-space-12) auto;
  }
  .columns {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(232px, 1fr);
    gap: var(--piui-space-3);
    flex: 1;
    min-height: 0;
    padding: var(--piui-space-2) var(--piui-space-6) var(--piui-space-6);
    overflow-x: auto;
  }
  .column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-sunken);
    border: 1px solid var(--piui-border-subtle);
  }
  .column--collapsed {
    align-self: start;
  }
  .column--drop {
    border-color: var(--piui-chaos);
    box-shadow: 0 0 0 1px var(--piui-chaos-glow);
  }
  .column__head {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 10px 10px 8px 12px;
  }
  .column__head::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 40%;
    bottom: 0;
    height: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--piui-chaos) 45%, transparent), transparent);
  }
  .column[data-status='inProgress'] .column__head::after {
    height: 2px;
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold) 55%, transparent);
    clip-path: polygon(0 0, 100% 0, 96% 100%, 0 100%);
  }
  h2 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: 11px;
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .column__toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
  }
  .chevron {
    display: inline-flex;
    color: var(--piui-text-faint);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
  .column__count {
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
    font-variant-numeric: tabular-nums;
  }
  .column__add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: auto;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
  }
  .column__add:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .new-card {
    display: grid;
    gap: 6px;
    padding: 8px 8px 0;
  }
  .new-card__actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }
  .column__list {
    display: grid;
    align-content: start;
    gap: 6px;
    flex: 1;
    min-height: 48px;
    margin: 0;
    padding: 8px;
    overflow-y: auto;
    list-style: none;
  }
  .column__empty {
    padding: 10px 4px;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-sm);
    text-align: center;
  }
  .tile {
    position: relative;
    display: grid;
    gap: 4px;
    padding: 8px 10px 8px 12px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-raised);
    cursor: pointer;
    outline: none;
    transition: border-color var(--piui-duration-fast) var(--piui-ease-out), background var(--piui-duration-fast) var(--piui-ease-out);
  }
  .tile:hover {
    border-color: var(--piui-border);
  }
  .tile:focus-visible {
    border-color: var(--piui-focus);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--piui-focus) 45%, transparent);
  }
  .tile--current {
    background: var(--piui-chaos-streak), var(--piui-bg-raised);
    border-color: color-mix(in srgb, var(--piui-chaos) 45%, var(--piui-border));
  }
  .tile--dragging {
    opacity: 0.5;
  }
  /* Priority is a slanted blade on the left edge. */
  .tile__blade {
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 3px;
    width: 3px;
    clip-path: polygon(40% 0, 100% 0, 60% 100%, 0 100%);
  }
  .tile[data-priority='urgent'] .tile__blade {
    background: linear-gradient(180deg, var(--piui-chaos-gold), var(--piui-chaos));
    box-shadow: 0 0 8px var(--piui-chaos-glow);
  }
  .tile[data-priority='high'] .tile__blade {
    background: var(--piui-chaos-gold);
  }
  .tile__top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 18px;
  }
  .tile__number {
    color: var(--piui-text-faint);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .tile__spacer {
    flex: 1;
  }
  .tile__title {
    margin: 0;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-tight);
    overflow-wrap: anywhere;
  }
  .tile__meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tile__meta:empty {
    display: none;
  }
  .priority,
  .label,
  .links {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 6px;
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: 11px;
    line-height: 18px;
  }
  .priority--urgent {
    background: color-mix(in srgb, var(--piui-chaos) 18%, transparent);
    color: var(--piui-chaos);
  }
  .priority--high {
    color: var(--piui-chaos-gold);
  }
  .priority--low {
    color: var(--piui-text-faint);
  }
  .links {
    background: transparent;
  }
</style>
