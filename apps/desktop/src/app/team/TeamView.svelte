<script lang="ts">
  import { untrack } from 'svelte';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import Route from '@lucide/svelte/icons/route';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Dialog, EmptyState, Skeleton, StatusDot, Switch, toasts } from '../../lib/ui';
  import type { TeammateStatusV1, TeammateV1 } from '../../host-api/teammatesClient';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { chatPipelines } from '../chatPipelines/chatPipelines.svelte';
  import { boards } from '../board/boardStore.svelte';
  import { boardIntents } from '../board/intents.svelte';
  import { byPriority, isClosed, STATUS_LABEL } from '../board/boardModel';
  import TeammateAvatar from './TeammateAvatar.svelte';
  import TeammateDialog from './TeammateDialog.svelte';
  import { teammates } from './teammatesStore.svelte';

  interface Props {
    workspaceId: string;
    teammateId?: string;
  }
  let { workspaceId, teammateId }: Props = $props();

  const store = useWorkspace();
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === workspaceId));
  const list = $derived(teammates.list(workspaceId));
  const loading = $derived(teammates.loading[workspaceId] === true && teammates.teams[workspaceId] === undefined);
  const loadError = $derived(teammates.errors[workspaceId]);
  const selected = $derived(list.find((item) => item.id === teammateId) ?? list[0]);
  const selectedStatus = $derived(selected ? teammates.status(workspaceId, selected.id) : undefined);
  // The shell keys this view by project, so the store is picked once (creating it writes state).
  // svelte-ignore state_referenced_locally
  const board = boards.get(workspaceId);
  const assigned = $derived(selected ? (board.board?.cards ?? []).filter((card) => card.assignee === selected.id).sort(byPriority) : []);
  const openAssigned = $derived(assigned.filter((card) => !isClosed(card.status)));
  const runLinks = $derived(
    selected
      ? (board.board?.cards ?? [])
          .flatMap((card) => card.links.filter((link) => link.kind === 'run' && link.teammateId === selected.id).map((link) => ({ card, link })))
          .sort((left, right) => right.link.since.localeCompare(left.link.since))
          .slice(0, 10)
      : [],
  );

  let dialog = $state<{ teammate: TeammateV1 | undefined } | undefined>();
  let deleteTarget = $state<TeammateV1 | undefined>();
  let deleting = $state(false);

  $effect(() => {
    const id = workspaceId;
    untrack(() => {
      void teammates.ensure(id);
      if (chatPipelines.commands[id] === undefined) void chatPipelines.loadProject(id);
    });
  });
  // Availability follows board runs.
  $effect(() => {
    if (board.board?.revision !== undefined) untrack(() => void teammates.load(workspaceId));
  });
  $effect(() => {
    if (boardIntents.newTeammate === workspaceId && untrack(() => boardIntents.takeNewTeammate(workspaceId))) dialog = { teammate: undefined };
  });

  function select(teammate: TeammateV1): void {
    store.navigate({ name: 'team', workspaceId, teammateId: teammate.id });
  }

  function commandName(teammate: TeammateV1): string {
    return chatPipelines.commands[workspaceId]?.find((command) => command.id === teammate.launchCommandId)?.name ?? $t('A saved pipeline');
  }

  function statusLabel(status: TeammateStatusV1 | undefined): string {
    switch (status?.availability) {
      case 'working':
        return $t('Working');
      case 'queued':
        return $t('Queued');
      default:
        return $t('Idle');
    }
  }

  function ruleText(teammate: TeammateV1): string {
    switch (teammate.wake.onAssign) {
      case 'ask':
        return $t('Asks before starting');
      case 'always':
        return $t('Starts when assigned');
      case 'never':
        return $t('Starts only when you press Start run');
      default: {
        const exhaustive: never = teammate.wake.onAssign;
        return exhaustive;
      }
    }
  }

  async function toggle(teammate: TeammateV1, enabled: boolean): Promise<void> {
    try {
      await teammates.setEnabled(workspaceId, teammate.id, enabled);
    } catch (error) {
      toasts.error($t('Could not update the teammate'), $t(errorMessage(error)));
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target || deleting) return;
    deleting = true;
    try {
      await teammates.remove(workspaceId, target);
      void chatPipelines.loadProject(workspaceId);
      toasts.success($t('Deleted @{0}', [target.handle]));
      deleteTarget = undefined;
      store.navigate({ name: 'team', workspaceId });
    } catch (error) {
      toasts.error($t('Could not delete the teammate'), $t(errorMessage(error)));
    } finally {
      deleting = false;
    }
  }

  function closeDialog(saved: TeammateV1 | undefined): void {
    dialog = undefined;
    if (saved) {
      toasts.success($t('Saved @{0}', [saved.handle]));
      select(saved);
    }
  }
</script>

<section class="team" aria-labelledby="team-title">
  <header class="head">
    <div class="head__title">
      <UsersRound size={18} aria-hidden="true" />
      <h1 id="team-title">{$t('Team')}</h1>
      {#if workspace}<span class="head__project">{workspace.name}</span>{/if}
    </div>
    <div class="head__tools">
      <Button size="sm" variant="ghost" onclick={() => store.navigate({ name: 'board', workspaceId })}>
        {#snippet leading()}<KanbanSquare size={14} />{/snippet}{$t('Board')}
      </Button>
      <Button size="sm" variant="primary" onclick={() => (dialog = { teammate: undefined })} disabled={store.safeMode}>
        {#snippet leading()}<UserPlus size={14} />{/snippet}{$t('New teammate')}
      </Button>
    </div>
  </header>

  {#if loading}
    <div class="loading"><Skeleton lines={5} /></div>
  {:else if loadError && list.length === 0}
    <EmptyState title={$t('The team could not be loaded')} description={$t(loadError)}>
      {#snippet actions()}<Button onclick={() => void teammates.load(workspaceId)}>{$t('Retry')}</Button>{/snippet}
    </EmptyState>
  {:else if list.length === 0}
    <div class="empty">
      <EmptyState
        icon={UsersRound}
        title={$t('No teammates yet')}
        description={$t('A teammate is an @handle for one agent or one saved pipeline. Assign it cards, or mention it in a comment.')}
      >
        {#snippet actions()}
          <Button variant="primary" onclick={() => (dialog = { teammate: undefined })} disabled={store.safeMode}>{$t('New teammate')}</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <div class="layout">
      <ul class="list" aria-label={$t('Teammates')}>
        {#each list as teammate (teammate.id)}
          {@const status = teammates.status(workspaceId, teammate.id)}
          <li class="row" class:row--current={selected?.id === teammate.id}>
            <button type="button" class="row__main" aria-current={selected?.id === teammate.id ? 'true' : undefined} onclick={() => select(teammate)}>
              <TeammateAvatar avatar={teammate.avatar} color={teammate.color} size={28} />
              <span class="row__text">
                <span class="row__handle">@{teammate.handle}<span class="row__name">{teammate.name}</span></span>
                <span class="row__role">{teammate.role || $t('No role yet')}</span>
              </span>
              <span class="pill pill--{status?.availability ?? 'idle'}">
                {#if status?.availability === 'working'}<StatusDot status="running" />{/if}
                {statusLabel(status)}
              </span>
            </button>
            <Switch label={$t('@{0} enabled', [teammate.handle])} hideLabel checked={teammate.enabled} disabled={store.safeMode} onCheckedChange={(value) => void toggle(teammate, value)} />
          </li>
        {/each}
      </ul>

      {#if selected}
        <article class="detail" aria-labelledby="teammate-detail-title">
          <header class="detail__head">
            <TeammateAvatar avatar={selected.avatar} color={selected.color} size={40} />
            <div class="detail__title">
              <h2 id="teammate-detail-title">@{selected.handle}</h2>
              <span class="muted">{selected.name}</span>
            </div>
            <Badge tone={selected.kind.type === 'simple' ? 'accent' : 'info'}>{selected.kind.type === 'simple' ? $t('One agent') : $t('Pipeline')}</Badge>
            {#if !selected.enabled}<Badge tone="warning">{$t('Turned off')}</Badge>{/if}
            <span class="spacer"></span>
            <Button size="sm" onclick={() => (dialog = { teammate: selected })} disabled={store.safeMode}>
              {#snippet leading()}<Pencil size={13} />{/snippet}{$t('Edit')}
            </Button>
            <Button size="sm" variant="ghost" onclick={() => (deleteTarget = selected)} disabled={store.safeMode}>
              {#snippet leading()}<Trash size={13} />{/snippet}{$t('Delete')}
            </Button>
          </header>

          {#if selectedStatus?.notAssignableReason}
            <p class="warning" role="status"><TriangleAlert size={14} aria-hidden="true" />{$t('Cannot take cards: {0}', [$t(selectedStatus.notAssignableReason)])}</p>
          {/if}

          <p class="role">{selected.role || $t('No role yet')}</p>
          <dl class="facts">
            <dt>{$t('Runs')}</dt>
            <dd><Route size={13} aria-hidden="true" />{commandName(selected)}</dd>
            <dt>{$t('When assigned')}</dt>
            <dd>{ruleText(selected)}{selected.wake.onMention ? ` · ${$t('wakes on @mention')}` : ''}</dd>
            <dt>{$t('Runs at the same time')}</dt>
            <dd>{selected.maxConcurrentRuns}</dd>
            <dt>{$t('Status')}</dt>
            <dd>{statusLabel(selectedStatus)}{selectedStatus?.queued ? ` · ${$t('{0} waiting', [selectedStatus.queued])}` : ''}</dd>
          </dl>

          <h3>{$t('Assigned cards')} <span class="count">{openAssigned.length}</span></h3>
          {#if assigned.length === 0}
            <p class="muted">{board.enabled ? $t('Nothing assigned. Assign a card from the board.') : $t('The board of this project is off.')}</p>
          {:else}
            <ul class="cards">
              {#each assigned as card (card.id)}
                <li>
                  <button type="button" class="cards__item" onclick={() => store.navigate({ name: 'board', workspaceId, cardId: card.id })}>
                    <span class="cards__number">#{card.number}</span>
                    <span class="cards__title">{card.title}</span>
                    {#if card.claim?.runId}<StatusDot status="running" label={$t('A run is working on it')} />{/if}
                    <span class="muted">{$t(STATUS_LABEL[card.status])}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          <h3>{$t('Runs')} <span class="count">{runLinks.length}</span></h3>
          {#if runLinks.length === 0}
            <p class="muted">{$t('No board runs yet.')}</p>
          {:else}
            <ul class="cards">
              {#each runLinks as entry (entry.link.kind === 'run' ? entry.link.runId : entry.card.id)}
                {#if entry.link.kind === 'run'}
                  {@const runId = entry.link.runId}
                  <li>
                    <button type="button" class="cards__item" onclick={() => store.openRun(workspaceId, runId)}>
                      <Route size={13} aria-hidden="true" />
                      <span class="cards__title">{$t('Run {0} for #{1}', [runId.slice(0, 8), entry.card.number])}</span>
                      {#if selectedStatus?.liveRunIds.includes(runId)}<StatusDot status="running" label={$t('Running')} />{/if}
                    </button>
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}
        </article>
      {/if}
    </div>
  {/if}
</section>

{#if dialog}
  <TeammateDialog {workspaceId} teammate={dialog.teammate} onClose={closeDialog} />
{/if}

<Dialog
  open={deleteTarget !== undefined}
  title={deleteTarget ? $t('Delete @{0}?', [deleteTarget.handle]) : ''}
  size="sm"
  onOpenChange={(open) => {
    if (!open && !deleting) deleteTarget = undefined;
  }}
>
  <p class="dialog-text">
    {deleteTarget?.kind.type === 'simple'
      ? $t('The agent, team, pipeline and launch command PiUI created for it are deleted too. Cards keep their history and become unassigned.')
      : $t('The pipeline it wraps stays. Cards keep their history and become unassigned.')}
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteTarget = undefined)} disabled={deleting}>{$t('Cancel')}</Button>
    <Button variant="danger" onclick={() => void confirmDelete()} loading={deleting}>{$t('Delete teammate')}</Button>
  {/snippet}
</Dialog>

<style>
  .team {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    flex-wrap: wrap;
    padding: var(--piui-space-4) var(--piui-space-6) var(--piui-space-3);
  }
  .head__title {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-chaos);
  }
  h1 {
    margin: 0;
    color: var(--piui-text);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .head__project,
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .head__tools {
    display: flex;
    gap: var(--piui-space-2);
  }
  .loading,
  .empty {
    width: min(640px, calc(100% - 48px));
    margin: var(--piui-space-12) auto;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
    gap: var(--piui-space-4);
    padding: 0 var(--piui-space-6) var(--piui-space-6);
  }
  @media (max-width: 860px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .list {
    display: grid;
    align-content: start;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 8px;
    border-radius: var(--piui-radius-sm);
  }
  .row--current {
    background: var(--piui-chaos-streak), var(--piui-selected);
  }
  .row__main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .row__main:hover {
    background: var(--piui-hover);
  }
  .row__text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .row__handle {
    font-weight: var(--piui-weight-medium);
  }
  .row__name {
    margin-left: 6px;
    color: var(--piui-text-muted);
    font-weight: var(--piui-weight-regular);
    font-size: var(--piui-text-sm);
  }
  .row__role {
    overflow: hidden;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    color: var(--piui-text-muted);
    font-size: 11px;
    line-height: 20px;
    background: var(--piui-surface-2);
    clip-path: polygon(8% 0, 100% 0, 92% 100%, 0 100%);
  }
  .pill--working {
    background: color-mix(in srgb, var(--piui-chaos-spark) 18%, transparent);
    color: var(--piui-chaos-spark);
  }
  .pill--queued {
    background: color-mix(in srgb, var(--piui-chaos-gold) 18%, transparent);
    color: var(--piui-chaos-gold);
  }
  .detail {
    display: grid;
    align-content: start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-lg);
    background: var(--piui-bg-raised);
  }
  .detail__head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--piui-space-3);
  }
  .detail__title {
    display: grid;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .spacer {
    flex: 1;
  }
  .warning {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 6px 10px;
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .role {
    margin: 0;
    line-height: var(--piui-leading-normal);
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  dt {
    color: var(--piui-text-muted);
  }
  dd {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: var(--piui-space-2) 0 0;
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
    letter-spacing: 0;
  }
  .cards {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cards__item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .cards__item:hover {
    background: var(--piui-hover);
  }
  .cards__number {
    color: var(--piui-text-faint);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .cards__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dialog-text {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
</style>
