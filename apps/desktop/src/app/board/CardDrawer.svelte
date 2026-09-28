<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import Trash from '@lucide/svelte/icons/trash';
  import Play from '@lucide/svelte/icons/play';
  import LockOpen from '@lucide/svelte/icons/lock-open';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Route from '@lucide/svelte/icons/route';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, IconButton, Input, Picker, StatusDot, Textarea, toasts, type PickerItem } from '../../lib/ui';
  import {
    CARD_STATUSES,
    MAX_CARD_TITLE_CHARS,
    MAX_LABELS_PER_CARD,
    type CardEditableFieldsV1,
    type CardLinkV1,
    type CardPriorityV1,
    type CardStartModeV1,
    type CardStatusV1,
    type CardV1,
    type CommentMentionV1,
  } from '../../host-api/boardClient';
  import type { TeammateV1 } from '../../host-api/teammatesClient';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import MentionTextarea from '../team/MentionTextarea.svelte';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import type { BoardStore } from './boardStore.svelte';
  import { cardByNumber, isClosed, operationCopy, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL } from './boardModel';
  import CardTimeline from './CardTimeline.svelte';

  interface Props {
    board: BoardStore;
    card: CardV1;
    workspaceId: string;
    onClose: () => void;
    onAnnounce: (text: string) => void;
  }
  let { board, card, workspaceId, onClose, onAnnounce }: Props = $props();

  const store = useWorkspace();
  const team = $derived(teammates.list(workspaceId));
  const assignee = $derived(teammates.get(workspaceId, card.assignee));
  const closed = $derived(isClosed(card.status));
  const proposals = $derived((board.board?.proposals ?? []).filter((item) => item.status === 'pending' && item.cardId === card.id));
  const pendingStart = $derived(board.board?.pendingStarts.find((item) => item.cardId === card.id));
  type SessionLink = Extract<CardLinkV1, { kind: 'session' }>;
  type RunLink = Extract<CardLinkV1, { kind: 'run' }>;
  const sessions = $derived(card.links.filter((link): link is SessionLink => link.kind === 'session'));
  const runs = $derived(card.links.filter((link): link is RunLink => link.kind === 'run'));
  const blockers = $derived(card.blockedBy.map((id) => board.card(id)).filter((item): item is CardV1 => item !== undefined));
  const parent = $derived(board.card(card.parentId ?? undefined));
  const liveRun = $derived(card.claim?.runId);

  let title = $state('');
  let description = $state('');
  let labels = $state('');
  let blockerInput = $state('');
  let parentInput = $state('');
  let busy = $state(false);
  let deleteOpen = $state(false);
  let assignOpen = $state(false);
  let pendingAssignee = $state<TeammateV1 | undefined>();
  let heading = $state<HTMLHeadingElement | null>(null);

  // Drafts follow the card whenever the host saved a new revision; an
  // unsaved description edit is kept unless the saved text it started from changed.
  let syncedId = '';
  let syncedRevision = -1;
  let savedDescription = '';
  $effect(() => {
    const next = card;
    untrack(() => {
      if (next.id === syncedId && next.revision === syncedRevision) return;
      const sameCard = next.id === syncedId;
      syncedId = next.id;
      syncedRevision = next.revision;
      title = next.title;
      labels = next.labels.join(', ');
      if (!sameCard || description === savedDescription) description = next.description;
      savedDescription = next.description;
    });
  });
  const descriptionDirty = $derived(description !== card.description);

  onMount(() => {
    void tick().then(() => heading?.focus());
  });

  async function act(action: () => Promise<unknown>, failure: string, success: string | undefined = undefined): Promise<boolean> {
    busy = true;
    try {
      await action();
      if (success) onAnnounce(success);
      return true;
    } catch (error) {
      toasts.error($t(failure), $t(errorMessage(error)));
      return false;
    } finally {
      busy = false;
    }
  }

  function patch(value: Partial<CardEditableFieldsV1>): Promise<boolean> {
    return act(() => board.updateCard(card, value), 'Could not update the card');
  }

  function commitTitle(): void {
    const next = title.trim();
    if (!next) {
      title = card.title;
      return;
    }
    if (next !== card.title) void patch({ title: next });
  }

  function commitLabels(): void {
    const next = [...new Set(labels.split(',').map((label) => label.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_LABELS_PER_CARD);
    if (JSON.stringify(next) !== JSON.stringify(card.labels)) void patch({ labels: next });
  }

  async function changeStatus(to: CardStatusV1): Promise<void> {
    if (to === card.status) return;
    await act(() => board.moveCard(card.id, to), 'Could not move the card', $t('Moved #{0} to {1}', [card.number, $t(STATUS_LABEL[to])]));
  }

  /** `#12`, `12` → a card of this board other than this one. */
  function parseCard(value: string): CardV1 | undefined {
    const number = Number.parseInt(value.trim().replace(/^#/u, ''), 10);
    if (!Number.isSafeInteger(number)) return undefined;
    const found = cardByNumber(board.board, number);
    return found?.id === card.id ? undefined : found;
  }

  async function addBlocker(): Promise<void> {
    const found = parseCard(blockerInput);
    if (!found) {
      toasts.error($t('No such card on this board'), blockerInput);
      return;
    }
    if (card.blockedBy.includes(found.id)) return;
    if (await patch({ blockedBy: [...card.blockedBy, found.id] })) blockerInput = '';
  }

  async function setParent(): Promise<void> {
    const found = parseCard(parentInput);
    if (!found) {
      toasts.error($t('No such card on this board'), parentInput);
      return;
    }
    if (await patch({ parentId: found.id })) parentInput = '';
  }

  // ---- assignee --------------------------------------------------------------

  const assigneeItems = $derived.by<PickerItem[]>(() => {
    const items: PickerItem[] = [{ value: 'none', label: $t('Unassigned'), description: $t('Nobody works on it') }];
    for (const teammate of team) {
      const status = teammates.status(workspaceId, teammate.id);
      const reason = !teammate.enabled ? $t('Turned off') : status?.notAssignableReason;
      items.push({
        value: `teammate:${teammate.id}`,
        label: `@${teammate.handle} · ${teammate.name}`,
        description: status ? $t(availabilityLabel(status.availability)) : teammate.role,
        keywords: [teammate.handle, teammate.name, teammate.role],
        disabled: reason !== undefined,
        disabledReason: reason,
      });
    }
    return items;
  });

  function availabilityLabel(value: 'idle' | 'queued' | 'working'): string {
    return value === 'working' ? 'Working' : value === 'queued' ? 'Queued' : 'Idle';
  }

  function ruleLabel(teammate: TeammateV1): string {
    switch (teammate.wake.onAssign) {
      case 'ask':
        return $t('Ask me in the Inbox');
      case 'always':
        return $t('Start at once');
      case 'never':
        return $t('Only assign');
      default: {
        const exhaustive: never = teammate.wake.onAssign;
        return exhaustive;
      }
    }
  }

  function pickAssignee(value: string): void {
    if (value === 'none') {
      pendingAssignee = undefined;
      if (card.assignee !== undefined) void act(() => board.assign(card.id, null, 'later'), 'Could not change the assignee', $t('Unassigned #{0}', [card.number]));
      return;
    }
    pendingAssignee = team.find((teammate) => `teammate:${teammate.id}` === value);
  }

  async function assign(start: CardStartModeV1): Promise<void> {
    const teammate = pendingAssignee;
    if (!teammate) return;
    if (await act(() => board.assign(card.id, teammate.id, start), 'Could not change the assignee', $t('Assigned #{0} to @{1}', [card.number, teammate.handle]))) {
      pendingAssignee = undefined;
    }
  }

  // ---- comments --------------------------------------------------------------

  async function comment(body: string, mentions: CommentMentionV1[]): Promise<void> {
    busy = true;
    try {
      await board.comment(card.id, body, mentions);
      onAnnounce($t('Comment added to #{0}', [card.number]));
    } catch (error) {
      toasts.error($t('Could not add the comment'), $t(errorMessage(error)));
      throw error;
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    const number = card.number;
    if (await act(() => board.deleteCard(card), 'Could not delete the card', $t('Deleted #{0}', [number]))) {
      deleteOpen = false;
      onClose();
    }
  }

  function openChat(sessionId: string): void {
    void store.openSession(sessionId);
  }

  function openRun(runId: string): void {
    store.openRun(workspaceId, runId);
  }

  function handleOf(teammateId: string | undefined): string {
    const teammate = teammates.get(workspaceId, teammateId);
    return teammate ? `@${teammate.handle}` : $t('a removed teammate');
  }

  function sessionTitle(sessionId: string): string {
    return store.catalog.sessions.find((session) => session.id === sessionId)?.title ?? $t('A chat');
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented && !deleteOpen) {
      event.preventDefault();
      onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape closes the drawer from any field inside it.) -->
<aside class="card-drawer" aria-labelledby="card-drawer-title" onkeydown={keydown}>
  <span class="streak" aria-hidden="true"></span>
  <header class="drawer__head">
    <h2 id="card-drawer-title" tabindex="-1" bind:this={heading}>
      <span class="drawer__number">#{card.number}</span>
      <span class="visually-hidden">{card.title}</span>
    </h2>
    {#if liveRun}<StatusDot status="running" label={$t('A run is working on it')} />{/if}
    <span class="drawer__spacer"></span>
    <IconButton label={$t('Delete card')} onclick={() => (deleteOpen = true)} disabled={store.safeMode}><Trash size={15} /></IconButton>
    <IconButton label={$t('Close')} shortcut="Escape" onclick={onClose}><X size={16} /></IconButton>
  </header>

  <div class="drawer__body">
    <label class="field">
      <span class="field__label">{$t('Title')}</span>
      <Input
        bind:value={title}
        maxlength={MAX_CARD_TITLE_CHARS}
        disabled={store.safeMode}
        onblur={commitTitle}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitTitle();
          }
        }}
      />
    </label>

    <div class="row">
      <label class="field">
        <span class="field__label">{$t('Status')}</span>
        <select class="select" value={card.status} disabled={store.safeMode || busy} onchange={(event) => void changeStatus(event.currentTarget.value as CardStatusV1)}>
          {#each CARD_STATUSES as status (status)}
            <option value={status}>{$t(STATUS_LABEL[status])}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span class="field__label">{$t('Priority')}</span>
        <select class="select" value={card.priority} disabled={store.safeMode || busy} onchange={(event) => void patch({ priority: event.currentTarget.value as CardPriorityV1 })}>
          {#each PRIORITIES as priority (priority)}
            <option value={priority}>{$t(PRIORITY_LABEL[priority])}</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="field">
      <span class="field__label" id="card-assignee-label">{$t('Assignee')}</span>
      <Picker
        bind:open={assignOpen}
        items={assigneeItems}
        value={card.assignee ? `teammate:${card.assignee}` : 'none'}
        label={$t('Assignee')}
        searchPlaceholder={$t('Search teammates')}
        emptyText={team.length ? $t('Nothing found') : $t('No teammates yet')}
        onSelect={pickAssignee}
      >
        {#snippet trigger(props)}
          <button type="button" class="assignee" aria-labelledby="card-assignee-label" {...props} disabled={store.safeMode}>
            {#if assignee}
              <TeammateAvatar avatar={assignee.avatar} color={assignee.color} size={18} />
              <span>@{assignee.handle}</span>
              <span class="muted">{assignee.name}</span>
            {:else}
              <span class="muted">{$t('Unassigned')}</span>
            {/if}
            <ChevronDown size={12} />
          </button>
        {/snippet}
        {#snippet footer()}
          <div class="picker-footer">
            <button type="button" class="link" onclick={() => { assignOpen = false; store.navigate({ name: 'team', workspaceId }); }}>{$t('Manage teammates')}</button>
          </div>
        {/snippet}
      </Picker>
      {#if pendingAssignee}
        <div class="start" role="group" aria-label={$t('When should @{0} start?', [pendingAssignee.handle])}>
          <p class="start__text">
            {$t('Assign to @{0}. When should it start?', [pendingAssignee.handle])}
            {#if card.status === 'backlog'}<span class="muted">{$t('Backlog cards never start a run.')}</span>{/if}
          </p>
          <div class="start__actions">
            <Button size="sm" variant="primary" onclick={() => void assign('ask')} loading={busy}>{$t('Follow teammate rule: {0}', [ruleLabel(pendingAssignee)])}</Button>
            <Button size="sm" onclick={() => void assign('now')} disabled={busy || card.status === 'backlog' || closed}>{$t('Start now')}</Button>
            <Button size="sm" onclick={() => void assign('later')} disabled={busy}>{$t("Don't start yet")}</Button>
            <Button size="sm" variant="ghost" onclick={() => (pendingAssignee = undefined)}>{$t('Cancel')}</Button>
          </div>
        </div>
      {/if}
    </div>

    <div class="runbar">
      {#if pendingStart}
        <p class="runbar__text">{$t('{0} waits for you to start a run.', [handleOf(pendingStart.teammateId)])}</p>
        <Button size="sm" variant="primary" onclick={() => void act(() => board.resolvePendingStart(pendingStart.id, true), 'Could not start the run', $t('Started a run for #{0}', [card.number]))} disabled={busy || store.safeMode}>
          {#snippet leading()}<Play size={13} />{/snippet}{$t('Start')}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => void act(() => board.resolvePendingStart(pendingStart.id, false), 'Could not dismiss the start')} disabled={busy || store.safeMode}>{$t('Dismiss')}</Button>
      {:else if card.claim}
        <p class="runbar__text">{liveRun ? $t('A run of {0} is working on it.', [handleOf(assignee?.id)]) : $t('The card is claimed.')}</p>
        {#if liveRun}<Button size="sm" variant="ghost" onclick={() => openRun(liveRun)}>{$t('Open run')}</Button>{/if}
        <Button size="sm" onclick={() => void act(() => board.releaseClaim(card.id), 'Could not release the claim', $t('Released #{0}', [card.number]))} disabled={busy || store.safeMode}>
          {#snippet leading()}<LockOpen size={13} />{/snippet}{liveRun ? $t('Stop run') : $t('Release claim')}
        </Button>
      {:else if assignee && !closed}
        <p class="runbar__text">{$t('Hand this card to @{0} now.', [assignee.handle])}</p>
        <Button size="sm" variant="primary" onclick={() => void act(() => board.startRun(card.id), 'Could not start the run', $t('Started a run for #{0}', [card.number]))} disabled={busy || store.safeMode}>
          {#snippet leading()}<Play size={13} />{/snippet}{$t('Start run')}
        </Button>
      {/if}
    </div>

    {#each proposals as proposal (proposal.id)}
      {@const copy = operationCopy(proposal.operation, board.board, handleOf)}
      <div class="proposal" role="group" aria-label={$t('Proposal')}>
        <span class="proposal__text">{$t('An agent proposes: {0}', [$t(copy.text, copy.params.map((value) => (typeof value === 'string' && Object.values(STATUS_LABEL).includes(value) ? $t(value) : value)))])}</span>
        <Button size="sm" variant="primary" onclick={() => void act(() => board.resolveProposal(proposal.id, true), 'Could not accept the proposal')} disabled={busy || store.safeMode}>{$t('Accept')}</Button>
        <Button size="sm" variant="ghost" onclick={() => void act(() => board.resolveProposal(proposal.id, false), 'Could not reject the proposal')} disabled={busy || store.safeMode}>{$t('Reject')}</Button>
      </div>
    {/each}

    <label class="field">
      <span class="field__label">{$t('Description')}</span>
      <Textarea bind:value={description} minRows={3} maxRows={14} disabled={store.safeMode} placeholder={$t('What should be done, and how will you know it is done?')} />
    </label>
    {#if descriptionDirty}
      <div class="inline-actions">
        <Button size="sm" variant="ghost" onclick={() => (description = card.description)}>{$t('Discard')}</Button>
        <Button size="sm" variant="primary" onclick={() => void patch({ description })} loading={busy}>{$t('Save description')}</Button>
      </div>
    {/if}

    <label class="field">
      <span class="field__label">{$t('Labels')}</span>
      <Input bind:value={labels} placeholder={$t('bug, docs')} disabled={store.safeMode} onblur={commitLabels} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitLabels(); } }} />
    </label>

    <div class="field">
      <span class="field__label" id="card-blockers">{$t('Blocked by')}</span>
      {#if blockers.length}
        <ul class="chips" aria-labelledby="card-blockers">
          {#each blockers as blocker (blocker.id)}
            <li class="chip">
              <button type="button" class="chip__open" onclick={() => store.navigate({ name: 'board', workspaceId, cardId: blocker.id })}>#{blocker.number} {blocker.title}</button>
              {#if isClosed(blocker.status)}<span class="muted">{$t(STATUS_LABEL[blocker.status])}</span>{/if}
              <button type="button" class="chip__remove" aria-label={$t('Remove blocker #{0}', [blocker.number])} onclick={() => void patch({ blockedBy: card.blockedBy.filter((id) => id !== blocker.id) })} disabled={busy || store.safeMode}><X size={12} /></button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="add" onsubmit={(event) => { event.preventDefault(); void addBlocker(); }}>
        <Input bind:value={blockerInput} size="sm" placeholder="#12" aria-label={$t('Add a blocker by card number')} disabled={store.safeMode} />
        <Button size="sm" type="submit" disabled={!blockerInput.trim() || busy}>{$t('Add')}</Button>
      </form>
    </div>

    <div class="field">
      <span class="field__label">{$t('Parent card')}</span>
      {#if parent}
        <div class="chip">
          <button type="button" class="chip__open" onclick={() => store.navigate({ name: 'board', workspaceId, cardId: parent.id })}>#{parent.number} {parent.title}</button>
          <button type="button" class="chip__remove" aria-label={$t('Remove parent card')} onclick={() => void patch({ parentId: null })} disabled={busy || store.safeMode}><X size={12} /></button>
        </div>
      {:else}
        <form class="add" onsubmit={(event) => { event.preventDefault(); void setParent(); }}>
          <Input bind:value={parentInput} size="sm" placeholder="#3" aria-label={$t('Set the parent card by number')} disabled={store.safeMode} />
          <Button size="sm" type="submit" disabled={!parentInput.trim() || busy}>{$t('Set')}</Button>
        </form>
      {/if}
    </div>

    {#if sessions.length || runs.length}
      <div class="field">
        <span class="field__label">{$t('Linked chats and runs')}</span>
        <ul class="links">
          {#each sessions as link (link.sessionId)}
              <li>
                <HarnessMark kind={link.harness} size={14} />
                <button type="button" class="link" onclick={() => openChat(link.sessionId)}>{sessionTitle(link.sessionId)}</button>
                <span class="muted">{harnessMeta(link.harness).label}</span>
                <button type="button" class="chip__remove" aria-label={$t('Unlink this chat')} onclick={() => void act(() => board.unlinkSession(card.id, link.sessionId), 'Could not unlink the chat')} disabled={busy || store.safeMode}><X size={12} /></button>
              </li>
          {/each}
          {#each runs as link (link.runId)}
              <li>
                <Route size={14} aria-hidden="true" />
                <button type="button" class="link" onclick={() => openRun(link.runId)}>{$t('Run {0}', [link.runId.slice(0, 8)])}</button>
                {#if link.teammateId}<span class="muted">{handleOf(link.teammateId)}</span>{/if}
                {#if card.claim?.runId === link.runId}<StatusDot status="running" label={$t('Running')} />{/if}
              </li>
          {/each}
        </ul>
      </div>
    {/if}

    <section class="activity" aria-labelledby="card-activity-title">
      <h3 id="card-activity-title"><MessageSquare size={13} aria-hidden="true" />{$t('Activity')}</h3>
      <CardTimeline
        {card}
        teammates={team}
        {busy}
        onUndo={(activityId) => void act(() => board.undo(card.id, activityId), 'Could not undo the change', $t('Undid a change on #{0}', [card.number]))}
        onOpenChat={openChat}
        onOpenRun={openRun}
      />
      <MentionTextarea
        teammates={team}
        label={$t('Comment on #{0}', [card.number])}
        placeholder={$t('Leave a note, or @mention a teammate…')}
        submitLabel={$t('Comment')}
        disabled={store.safeMode}
        {busy}
        onSubmit={comment}
      />
    </section>
  </div>
</aside>

<Dialog
  open={deleteOpen}
  title={$t('Delete #{0}?', [card.number])}
  description={card.title}
  size="sm"
  onOpenChange={(open) => {
    if (!open && !busy) deleteOpen = false;
  }}
>
  <p class="dialog-text">{$t('The card, its comments and its activity are removed from the board. Linked chats and runs stay.')}</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="danger" onclick={() => void remove()} loading={busy}>{$t('Delete card')}</Button>
  {/snippet}
</Dialog>

<style>
  .card-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: var(--piui-z-overlay);
    display: flex;
    flex-direction: column;
    width: min(460px, 100vw);
    border-left: 1px solid var(--piui-border);
    background: var(--piui-bg-raised);
    box-shadow: var(--piui-shadow-3);
    animation: drawer-in var(--piui-duration) var(--piui-ease-out);
  }
  @keyframes drawer-in {
    from {
      transform: translateX(16px);
      opacity: 0;
    }
  }
  .streak {
    position: absolute;
    top: 0;
    left: 0;
    width: 62%;
    height: 2px;
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold) 55%, transparent);
    clip-path: polygon(0 0, 100% 0, 96% 100%, 0 100%);
  }
  .drawer__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h2 {
    margin: 0;
    outline: none;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .drawer__number {
    font-family: var(--piui-font-mono);
    color: var(--piui-chaos);
  }
  .drawer__spacer {
    flex: 1;
  }
  .drawer__body {
    display: grid;
    align-content: start;
    gap: var(--piui-space-4);
    flex: 1;
    min-height: 0;
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  .field {
    display: grid;
    gap: 4px;
  }
  .field__label,
  h3 {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--piui-space-3);
  }
  .select {
    height: 30px;
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
  .assignee {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    justify-self: start;
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .picker-footer {
    display: flex;
    justify-content: flex-end;
    padding: 6px 8px;
    border-top: 1px solid var(--piui-border-subtle);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .start,
  .proposal,
  .runbar:not(:empty) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-chaos-streak), var(--piui-bg);
  }
  .start {
    display: grid;
  }
  .start__text,
  .runbar__text,
  .proposal__text {
    flex: 1 1 100%;
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  .start__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .inline-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: calc(-1 * var(--piui-space-2));
  }
  .chips,
  .links {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .links li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 8px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-2);
  }
  .chip__open {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip__remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
  }
  .chip__remove:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .add {
    display: flex;
    gap: 6px;
  }
  .activity {
    display: grid;
    gap: var(--piui-space-3);
  }
  .dialog-text {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
</style>
