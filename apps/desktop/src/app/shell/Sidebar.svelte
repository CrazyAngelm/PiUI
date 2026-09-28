<script lang="ts">
  import { untrack } from 'svelte';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import Search from '@lucide/svelte/icons/search';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import Workflow from '@lucide/svelte/icons/workflow';
  import History from '@lucide/svelte/icons/history';
  import Clock from '@lucide/svelte/icons/clock-3';
  import Folder from '@lucide/svelte/icons/folder';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import FolderMinus from '@lucide/svelte/icons/folder-minus';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import type { BoardRegistry } from '../board/boardStore.svelte';
  import { t, language } from '../../features/locale/language';
  import { placements } from '../worktrees/placements.svelte';
  import { Kbd, Menu, StatusDot, Skeleton, toasts, type MenuEntry, type Status } from '../../lib/ui';
  import type { WorkspaceSession, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { relativeTime } from '../format';
  import { isPinned, type ProjectDialogRequest } from '../projects/projectActions';
  import { useWorkspace } from './context';

  interface Props {
    onSearch: () => void;
    onTrust: (workspace: WorkspaceSummary) => void;
    onNavigate?: () => void;
  }
  let { onSearch, onTrust, onNavigate = () => {} }: Props = $props();
  const store = useWorkspace();

  const projects = $derived(store.catalog.workspaces.filter((workspace) => !workspace.personal));
  const personal = $derived(store.catalog.workspaces.find((workspace) => workspace.personal));
  const approvalsBySession = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of store.inboxApprovals) counts.set(item.session.id, (counts.get(item.session.id) ?? 0) + 1);
    return counts;
  });
  const inboxCount = $derived(store.inboxApprovals.length);
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  // Worktree markers: placement v1 is loaded whenever the chat list changes.
  $effect(() => placements.sync(store.catalog.sessions.map((session) => session.id)));

  function sessionStatus(session: WorkspaceSession): Status | undefined {
    if (approvalsBySession.has(session.id)) return 'waiting';
    if (['starting', 'running', 'stopping'].includes(session.status)) return 'running';
    if (session.status === 'failed') return 'failed';
    return undefined;
  }

  function go(action: () => void): void {
    action();
    onNavigate();
  }

  /** Read-only native history the index found in this folder (or personal chats). */
  function historyItem(workspace: WorkspaceSummary): MenuEntry {
    const prime = store.projectSummaries.some((project) => project.id === workspace.id && project.agentKind === 'prime-agent');
    return {
      label: $t('{0} session history', [prime ? 'Prime Agent' : 'Pi']),
      icon: ScrollText,
      onSelect: () => go(() => store.navigate({ name: 'history', workspaceId: workspace.id })),
    };
  }

  // Board state per project (ADR-041) loads after first paint, in its own chunk.
  let boards = $state.raw<BoardRegistry | undefined>();
  // Loaded once: project updates (a streaming chat) must not keep postponing it.
  $effect(() => {
    const timer = setTimeout(() => {
      void import('../board/boardStore.svelte')
        .then((module) => {
          boards = module.boards;
        })
        .catch(() => undefined);
    }, 1200);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    const ids = projects.filter((workspace) => !workspace.missing).map((workspace) => workspace.id);
    const registry = boards;
    if (registry !== undefined) untrack(() => registry.ensure(ids));
  });

  /** "Board" when the project's board is on, else "Enable board"; then "Team". */
  function boardItems(workspace: WorkspaceSummary): MenuEntry[] {
    const open = (): void => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'board', workspaceId: workspace.id }); });
    const registry = boards;
    const board: MenuEntry = registry?.enabled(workspace.id)
      ? { label: $t('Board'), icon: KanbanSquare, onSelect: open }
      : {
          label: $t('Enable board'),
          icon: KanbanSquare,
          disabled: store.safeMode,
          onSelect: () =>
            void import('../board/boardStore.svelte')
              .then((module) => module.boards.get(workspace.id).setEnabled(true))
              .then(open, () => toasts.error($t('Could not enable the board'))),
        };
    return [
      board,
      { label: $t('Team'), icon: UsersRound, onSelect: () => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'team', workspaceId: workspace.id }); }) },
    ];
  }

  let projectDialog = $state<ProjectDialogRequest | undefined>();
  /** Rename, pin and remove act on PiUI's registry only, never on the folder. */
  function manageItems(workspace: WorkspaceSummary): MenuEntry[] {
    const pinned = isPinned(store.projectSummaries, workspace.id);
    return [
      { type: 'separator' },
      { label: $t('Rename…'), icon: Pencil, onSelect: () => (projectDialog = { kind: 'rename', workspace }) },
      {
        label: pinned ? $t('Unpin') : $t('Pin to top'),
        icon: pinned ? PinOff : Pin,
        onSelect: () => void store.setProjectPinned(workspace.id, !pinned).catch(() => toasts.error($t('Could not update the project'))),
      },
      { label: $t('Remove from PiUI…'), icon: FolderMinus, danger: true, disabled: store.safeMode, onSelect: () => (projectDialog = { kind: 'remove', workspace }) },
    ];
  }

  const route = $derived(store.route);
</script>

{#if projectDialog}
  <!-- Loaded on first use so the first paint keeps its asset budget. -->
  {#await import('../projects/ProjectDialogs.svelte') then dialogs}
    {#key projectDialog}
      <dialogs.default request={projectDialog} onClose={() => (projectDialog = undefined)} />
    {/key}
  {/await}
{/if}

<nav class="sidebar" aria-label={$t('Workspace navigation')}>
  <div class="brand">
    <span class="brand__mark" aria-hidden="true">π</span>
    <span class="brand__name">PiUI</span>
  </div>

  <div class="primary">
    <button type="button" class="nav-item nav-item--strong" onclick={() => go(() => store.goHome())} aria-current={route.name === 'home' ? 'page' : undefined}>
      <SquarePen size={16} />
      <span class="nav-item__label">{$t('New chat')}</span>
      <Kbd keys="Mod+N" />
    </button>
    <button type="button" class="nav-item" onclick={onSearch}>
      <Search size={16} />
      <span class="nav-item__label">{$t('Search')}</span>
      <Kbd keys="Mod+K" />
    </button>
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'inbox' }))} aria-current={route.name === 'inbox' ? 'page' : undefined}>
      <InboxIcon size={16} />
      <span class="nav-item__label">{$t('Inbox')}</span>
      {#if inboxCount > 0}<span class="count" aria-label={$t('{0} waiting', [inboxCount])}>{inboxCount}</span>{/if}
    </button>
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'pipelines', section: 'systems' }))} aria-current={route.name === 'pipelines' && route.section === 'systems' ? 'page' : undefined}>
      <Workflow size={16} />
      <span class="nav-item__label">{$t('Pipelines')}</span>
    </button>
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'pipelines', section: 'runs' }))} aria-current={route.name === 'pipelines' && route.section === 'runs' ? 'page' : undefined}>
      <History size={16} />
      <span class="nav-item__label">{$t('Runs')}</span>
      {#if store.runningSessions.some((session) => session.runId)}<StatusDot status="running" />{/if}
    </button>
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'pipelines', section: 'schedules' }))} aria-current={route.name === 'pipelines' && route.section === 'schedules' ? 'page' : undefined}>
      <Clock size={16} />
      <span class="nav-item__label">{$t('Automations')}</span>
    </button>
  </div>

  <div class="section-head">
    <span>{$t('Projects')}</span>
    <div class="section-head__actions">
      <Menu
        align="end"
        items={[
          { label: $t('Add project…'), icon: Plus, onSelect: () => void store.addProject() },
          { label: $t('Refresh projects'), icon: RefreshCw, onSelect: () => void store.loadCatalog() },
        ]}
      >
        {#snippet trigger(props)}
          <button type="button" class="tiny-action" aria-label={$t('Project options')} {...props}><Ellipsis size={14} /></button>
        {/snippet}
      </Menu>
      <button type="button" class="tiny-action" aria-label={$t('Add project')} onclick={() => void store.addProject()} disabled={store.addingProject}>
        <Plus size={14} />
      </button>
    </div>
  </div>

  <div class="tree" role="list">
    {#if store.catalogLoading}
      <div class="loading"><Skeleton lines={4} height="14px" /></div>
    {:else}
      {#each projects as workspace (workspace.id)}
        {@render project(workspace, Folder, workspace.name)}
      {/each}
      {#if personal}{@render project(personal, MessagesSquare, $t('Personal chats'))}{/if}
      {#if projects.length === 0}
        <div class="hint">
          <p>{$t('Add a project folder to work with agents on its files.')}</p>
          <button type="button" class="link" onclick={() => void store.addProject()}>{$t('Add project…')}</button>
        </div>
      {/if}
    {/if}
  </div>

  <div class="footer">
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'settings', section: 'general' }))} aria-current={route.name === 'settings' ? 'page' : undefined}>
      <Settings size={16} />
      <span class="nav-item__label">{$t('Settings')}</span>
      <Kbd keys="Mod+," />
    </button>
  </div>
</nav>

{#snippet project(workspace: WorkspaceSummary, Icon: typeof Folder, name: string)}
  {@const collapsed = store.collapsedProjects.includes(workspace.id)}
  {@const sessions = store.sessionsFor(workspace.id)}
  <div class="project" role="listitem">
    <div class="project__row" class:project__row--current={workspace.id === store.selectedWorkspaceId}>
      <button
        type="button"
        class="project__toggle"
        aria-expanded={!collapsed}
        onclick={() => store.toggleProject(workspace.id)}
        title={name}
      >
        <span class="chevron" class:chevron--open={!collapsed}><ChevronRight size={12} /></span>
        <Icon size={15} />
        <span class="project__name">{name}</span>
        {#if workspace.missing}
          <span class="tag">{$t('Missing')}</span>
        {:else if workspace.trust === 'restricted' && !workspace.personal}
          <span class="tag tag--warn" title={$t('Restricted until you trust this folder')}><ShieldAlert size={11} /></span>
        {/if}
      </button>
      <div class="project__actions">
        {#if !workspace.personal}
          <Menu
            align="end"
            items={[
              ...(workspace.trust === 'restricted'
                ? [{ label: $t('Trust this folder…'), icon: ShieldCheck, onSelect: () => onTrust(workspace) }]
                : []),
              ...boardItems(workspace),
              { label: $t('Pipelines'), icon: Workflow, onSelect: () => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'pipelines', section: 'systems' }); }) },
              historyItem(workspace),
              { label: $t('Refresh projects'), icon: RefreshCw, onSelect: () => void store.loadCatalog(workspace.id) },
              ...manageItems(workspace),
            ]}
          >
            {#snippet trigger(props)}
              <button type="button" class="tiny-action" aria-label={$t('Options for {0}', [name])} {...props}><Ellipsis size={14} /></button>
            {/snippet}
          </Menu>
        {:else}
          <Menu align="end" items={[historyItem(workspace)]}>
            {#snippet trigger(props)}
              <button type="button" class="tiny-action" aria-label={$t('Options for {0}', [name])} {...props}><Ellipsis size={14} /></button>
            {/snippet}
          </Menu>
        {/if}
        {#if !workspace.personal && boards?.enabled(workspace.id)}
          <button
            type="button"
            class="tiny-action"
            aria-label={$t('Board of {0}', [name])}
            aria-current={route.name === 'board' && route.workspaceId === workspace.id ? 'page' : undefined}
            onclick={() => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'board', workspaceId: workspace.id }); })}
          >
            <KanbanSquare size={13} />
          </button>
        {/if}
        <button
          type="button"
          class="tiny-action"
          aria-label={$t('New chat in {0}', [name])}
          onclick={() => go(() => store.goHome(workspace.id))}
          disabled={workspace.missing}
        >
          <SquarePen size={13} />
        </button>
      </div>
    </div>
    {#if !collapsed}
      <ul class="chats">
        {#each sessions as session (session.id)}
          {@const status = sessionStatus(session)}
          {@const worktree = placements.get(session.id)?.worktree}
          <li><button
            type="button"
            class="chat"
            class:chat--current={store.selectedSessionId === session.id}
            aria-current={store.selectedSessionId === session.id ? 'page' : undefined}
            onclick={() => go(() => void store.openSession(session.id))}
            title={worktree ? `${session.title} · ${worktree.branch}` : session.title}
          >
            {#if worktree}
              <span class="chat__worktree" class:chat__worktree--gone={worktree.state !== 'ready'}><GitBranch size={12} /></span>
            {/if}
            <span class="chat__title">{session.title}</span>
            {#if worktree}<span class="visually-hidden">{$t('in worktree {0}', [worktree.branch])}</span>{/if}
            {#if status}
              <StatusDot {status} label={status === 'waiting' ? $t('Needs your decision') : status === 'running' ? $t('Running') : $t('Failed')} />
            {:else}
              <span class="chat__time">{relativeTime(session.updatedAt, $language, now)}</span>
            {/if}
          </button></li>
        {/each}
        {#if sessions.length === 0}
          <li class="chats__empty">{$t('No chats yet')}</li>
        {/if}
      </ul>
    {/if}
  </div>
{/snippet}

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 0 var(--piui-space-2);
    background: var(--piui-bg-raised);
    border-right: 1px solid var(--piui-border-subtle);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-2);
    flex: none;
  }
  .brand__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--piui-action);
    color: var(--piui-action-ink);
    font-size: 14px;
    font-weight: var(--piui-weight-semibold);
  }
  .brand__name {
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: -0.01em;
  }
  .primary,
  .footer {
    display: grid;
    gap: 1px;
    flex: none;
  }
  .footer {
    padding: var(--piui-space-2) 0;
    border-top: 1px solid var(--piui-border-subtle);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 30px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    text-align: left;
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .nav-item:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .nav-item[aria-current='page'] {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  .nav-item--strong {
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .nav-item__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nav-item :global(.kbd) {
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .nav-item:hover :global(.kbd),
  .nav-item:focus-visible :global(.kbd) {
    opacity: 1;
  }
  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-action);
    color: var(--piui-action-ink);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    line-height: 18px;
    text-align: center;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    margin-top: var(--piui-space-4);
    padding: 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex: none;
  }
  .section-head__actions,
  .project__actions {
    display: flex;
    gap: 2px;
  }
  .tiny-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
  }
  .tiny-action:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .tree {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-bottom: var(--piui-space-3);
    scrollbar-width: thin;
  }
  .loading {
    padding: var(--piui-space-2);
  }
  .project {
    margin-top: 2px;
  }
  .project__row {
    display: flex;
    align-items: center;
    border-radius: var(--piui-radius-sm);
  }
  .project__row:hover {
    background: var(--piui-hover);
  }
  .project__row .project__actions {
    padding-right: 4px;
    opacity: 0;
  }
  .project__row:hover .project__actions,
  .project__row:focus-within .project__actions {
    opacity: 1;
  }
  .project__toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 var(--piui-space-1) 0 2px;
    border: 0;
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .project__toggle :global(svg) {
    flex: none;
    color: var(--piui-text-muted);
  }
  .project__name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chevron {
    display: inline-flex;
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    padding: 0 4px;
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .tag--warn {
    background: var(--piui-warning-surface);
    color: var(--piui-warning);
  }
  .chats {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1px;
    margin: 0;
    padding: 1px 0 4px 22px;
    list-style: none;
  }
  .chat {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    width: 100%;
    height: 28px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    text-align: left;
  }
  .chat:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chat--current {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  .chat__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat__time {
    flex: none;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .chat__worktree {
    display: inline-flex;
    flex: none;
    color: var(--piui-accent);
  }
  .chat__worktree--gone {
    color: var(--piui-text-faint);
  }
  .chats__empty {
    margin: 2px 0 6px;
    padding: 0 var(--piui-space-2);
    color: var(--piui-text-faint);
    font-size: var(--piui-text-sm);
  }
  .hint {
    padding: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .hint p {
    margin: 0 0 var(--piui-space-2);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
</style>
