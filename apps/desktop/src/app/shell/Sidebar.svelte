<script lang="ts">
  import { untrack } from 'svelte';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import Workflow from '@lucide/svelte/icons/workflow';
  import Folder from '@lucide/svelte/icons/folder';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import FolderMinus from '@lucide/svelte/icons/folder-minus';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import UserRound from '@lucide/svelte/icons/user-round';
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import Trash from '@lucide/svelte/icons/trash-2';
  import type { BoardRegistry } from '../board/boardStore.svelte';
  import { t, language } from '../../features/locale/language';
  import { placements } from '../worktrees/placements.svelte';
  import { IconButton, Kbd, Menu, StatusDot, Skeleton, toasts, type MenuEntry, type Status } from '../../lib/ui';
  import type { WorkspaceSession, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { relativeTime } from '../format';
  import { isPinned, type ProjectDialogRequest } from '../projects/projectActions';
  import { useWorkspace } from './context';
  import { fusionMembership } from '../fusion/fusionMembership.svelte';
  import { chatTree } from './chatTree';
  import { dictationSource } from '../nano/dictationSource.svelte';
  import { nanoAccount } from '../nano/nanoAccount.svelte';
  import { remoteMode, hostSupports, pipelineSectionAvailable } from '../nano/remoteMode';
  import { remoteShell } from '../nano/remoteShell.svelte';
  import { chipFor, creditsText } from '../nano/nanoView';
  import Mark from '../marks/Mark.svelte';
  import { marks } from '../marks/marks.svelte';

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
    onNavigate?: () => void;
    onDeleteSession: (sessionId: string) => void;
    /** Hides the sidebar; absent in a narrow window, where it is a drawer. */
    onCollapse?: () => void;
    /** Shows a chat in a new pane beside the current one (split panes). */
    onOpenBeside?: (sessionId: string) => void;
    /** Why a chat waits to be seen, if it does. */
    attentionKind?: (sessionId: string) => string | undefined;
    /** The chat a linked child (started by an agent, or a branch) is listed under; arrives after first paint. */
    linkParentOf?: (sessionId: string) => string | undefined;
    /** Asks the host for a chat's linked chats once (cached). */
    linkLoad?: (sessionId: string) => void;
  }
  let { onTrust, onNavigate = () => {}, onDeleteSession, onCollapse = undefined, onOpenBeside = undefined, attentionKind = undefined, linkParentOf = undefined, linkLoad = undefined }: Props = $props();
  const store = useWorkspace();

  const projects = $derived(store.catalog.workspaces.filter((workspace) => !workspace.personal));
  const personal = $derived(store.catalog.workspaces.find((workspace) => workspace.personal));
  const approvalsBySession = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of store.inboxApprovals) counts.set(item.session.id, (counts.get(item.session.id) ?? 0) + 1);
    return counts;
  });
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  // Worktree markers: placement v1 is loaded whenever the chat list changes.
  $effect(() => placements.sync(store.catalog.sessions.map((session) => session.id)));
  // Fusion sidekick chats nest under their lead and linked children under their parent; every chat asks once (cached).
  $effect(() => {
    for (const session of store.catalog.sessions) {
      void fusionMembership.load(session.id);
      linkLoad?.(session.id);
    }
  });
  const parentOf = (sessionId: string): string | undefined => {
    const member = fusionMembership.peek(sessionId);
    return member?.role === 'sidekick' ? member.leadSessionId : linkParentOf?.(sessionId);
  };
  /**
   * Leads whose sidekick chats are shown. A lead opens itself when one of them
   * is current, and once when its pair starts working, so the sidekick's chat
   * is in view without being opened first. After that the person's choice stands.
   */
  let expandedLeads = $state<string[]>([]);
  /** Leads that opened for their pair's work once, or that the person opened or closed by hand. */
  const settledLeads = new Set<string>();
  $effect(() => {
    const lead = store.selectedSessionId ? parentOf(store.selectedSessionId) : undefined;
    if (lead && !untrack(() => expandedLeads).includes(lead)) expandedLeads = [...untrack(() => expandedLeads), lead];
  });
  $effect(() => {
    fusionMembership.watch();
    const fresh = [...fusionMembership.workingLeads].filter((lead) => !settledLeads.has(lead));
    if (fresh.length === 0) return;
    for (const lead of fresh) settledLeads.add(lead);
    const shown = untrack(() => expandedLeads);
    expandedLeads = [...shown, ...fresh.filter((lead) => !shown.includes(lead))];
  });
  function toggleLead(leadId: string): void {
    settledLeads.add(leadId);
    expandedLeads = expandedLeads.includes(leadId) ? expandedLeads.filter((id) => id !== leadId) : [...expandedLeads, leadId];
  }

  function sessionStatus(session: WorkspaceSession): Status | undefined {
    if (approvalsBySession.has(session.id)) return 'waiting';
    if (['starting', 'running', 'stopping'].includes(session.status)) return 'running';
    if (session.status === 'failed') return 'failed';
    return undefined;
  }

  function attentionLabel(kind: string | undefined): string {
    return kind === 'decision' ? $t('Needs your decision') : kind === 'failed' ? $t('Failed') : $t('New result');
  }

  function go(action: () => void): void {
    action();
    onNavigate();
  }

  /** Read-only history of this folder (or personal chats) across the connected harnesses. */
  function historyItem(workspace: WorkspaceSummary): MenuEntry {
    return {
      label: $t('Session history'),
      icon: ScrollText,
      onSelect: () => go(() => store.navigate({ name: 'history', workspaceId: workspace.id })),
    };
  }

  // Board state per project (ADR-041) loads after first paint, in its own chunk.
  let boards = $state.raw<BoardRegistry | undefined>();
  // Loaded once: project updates (a streaming chat) must not keep postponing it.
  $effect(() => {
    if (!hostSupports('board_command_v1', 'teammates_command_v1')) return;
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
    const ids = projects.filter((workspace) => !workspace.missing && (!remoteMode || workspace.trust === 'trusted')).map((workspace) => workspace.id);
    const registry = boards;
    if (registry !== undefined) untrack(() => registry.ensure(ids));
  });

  /** "Board" when the project's board is on, else "Enable board"; then "Team". */
  function boardItems(workspace: WorkspaceSummary): MenuEntry[] {
    const open = (): void => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'board', workspaceId: workspace.id }); });
    const registry = boards;
    const board: MenuEntry = remoteMode || registry?.enabled(workspace.id)
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
  // Both are loaded on first use, like the project dialogs.
  let markTarget = $state<{ kind: 'project' | 'session'; id: string } | undefined>();
  let renaming = $state<WorkspaceSession | undefined>();
  /** Rename, mark and delete for one chat; a sidekick in use and a pipeline member cannot be deleted here. */
  function chatItems(session: WorkspaceSession): MenuEntry[] {
    const running = ['starting', 'running', 'stopping'].includes(session.status);
    const deletable = !session.runId && !fusionMembership.isCurrentSidekick(session.id) && !remoteMode;
    return [
      { label: $t('Rename…'), icon: Pencil, onSelect: () => (renaming = session) },
      { label: $t('Mark…'), icon: SmilePlus, onSelect: () => (markTarget = { kind: 'session', id: session.id }) },
      ...(onOpenBeside ? [{ label: $t('Open to the side'), icon: Columns2, onSelect: () => onOpenBeside?.(session.id) }] : []),
      ...(deletable
        ? [
            { type: 'separator' as const },
            { label: $t('Delete chat…'), icon: Trash, danger: true, disabled: running || store.safeMode, onSelect: () => onDeleteSession(session.id) },
          ]
        : []),
    ];
  }
  /** Rename, pin and remove act on PiUI's registry only, never on the folder. */
  function manageItems(workspace: WorkspaceSummary): MenuEntry[] {
    const pinned = isPinned(store.projectSummaries, workspace.id);
    return [
      { type: 'separator' },
      { label: $t('Mark…'), icon: SmilePlus, onSelect: () => (markTarget = { kind: 'project', id: workspace.id }) },
      { label: $t('Rename…'), icon: Pencil, onSelect: () => (projectDialog = { kind: 'rename', workspace }) },
      {
        label: pinned ? $t('Unpin') : $t('Pin to top'),
        icon: pinned ? PinOff : Pin,
        onSelect: () => void store.setProjectPinned(workspace.id, !pinned).catch(() => toasts.error($t('Could not update the project'))),
      },
      { label: $t('Remove from Nano Desktop…'), icon: FolderMinus, danger: true, disabled: store.safeMode, onSelect: () => (projectDialog = { kind: 'remove', workspace }) },
    ];
  }

  const route = $derived(store.route);

  // Where dictation goes: a local settings read after first paint, never a network call.
  $effect(() => dictationSource.startLater());
  const nanoChip = $derived(chipFor(nanoAccount.status));
</script>

{#if projectDialog}
  <!-- Loaded on first use so the first paint keeps its asset budget. -->
  {#await import('../projects/ProjectDialogs.svelte') then dialogs}
    {#key projectDialog}
      <dialogs.default request={projectDialog} onClose={() => (projectDialog = undefined)} />
    {/key}
  {/await}
{/if}

{#if markTarget}
  {#await import('../marks/MarkPicker.svelte') then picker}
    {#key markTarget}
      <picker.default target={markTarget} onClose={() => (markTarget = undefined)} />
    {/key}
  {/await}
{/if}
{#if renaming}
  {#await import('./SessionRenameDialog.svelte') then dialog}
    {#key renaming}
      <dialog.default sessionId={renaming.id} title={renaming.title} onClose={() => (renaming = undefined)} />
    {/key}
  {/await}
{/if}

<nav class="sidebar" aria-label={$t('Workspace navigation')}>
  {#if remoteShell.Indicator}
    <remoteShell.Indicator onOpen={() => go(() => store.navigate({ name: 'settings', section: 'nano' }))} />
  {/if}

  <div class="section-head">
    <span>{$t('Projects')}</span>
    {#if !remoteMode || onCollapse}
      <div class="section-head__actions">
        {#if !remoteMode}
          <button type="button" class="tiny-action" aria-label={$t('Add project')} onclick={() => void store.addProject()} disabled={store.addingProject}>
            <Plus size={14} />
          </button>
        {/if}
        {#if onCollapse}
          <IconButton label={$t('Hide sidebar')} shortcut="Mod+B" size="sm" data-sidebar-hide="" onclick={() => onCollapse?.()}><PanelLeftClose /></IconButton>
        {/if}
      </div>
    {/if}
  </div>

  <div class="tree">
    {#if store.catalogLoading}
      <div class="loading"><Skeleton lines={4} height="14px" /></div>
    {:else}
      <!-- The list holds project rows only; the empty-state hint stays outside it. -->
      {#if projects.length > 0 || personal}
        <div role="list">
          {#each projects as workspace (workspace.id)}
            {@render project(workspace, Folder, workspace.name)}
          {/each}
          {#if personal}{@render project(personal, MessagesSquare, $t('Personal chats'))}{/if}
        </div>
      {/if}
      {#if projects.length === 0 && !remoteMode}
        <div class="hint">
          <p>{$t('Add a project folder to work with agents on its files.')}</p>
          <button type="button" class="link" onclick={() => void store.addProject()}>{$t('Add project…')}</button>
        </div>
      {/if}
    {/if}
  </div>

  {#if !remoteMode}
  <div class="footer">
    <button
      type="button"
      class="nav-item nano-chip"
      data-tone={nanoChip.tone}
      onclick={() => go(() => store.navigate({ name: 'settings', section: 'nano' }))}
      aria-current={route.name === 'settings' && route.section === 'nano' ? 'page' : undefined}
    >
      <UserRound size={16} />
      <span class="nav-item__label">{nanoChip.translate ? $t(nanoChip.label) : nanoChip.label}</span>
      {#if nanoChip.credits !== undefined}
        <span class="nano-chip__credits">{creditsText(nanoChip.credits, $language === 'ru' ? 'ru-RU' : 'en-US', true)}<span class="visually-hidden"> {$t('credits')}</span></span>
      {/if}
    </button>
    <button type="button" class="nav-item" onclick={() => go(() => store.navigate({ name: 'settings', section: 'general' }))} aria-current={route.name === 'settings' ? 'page' : undefined}>
      <Settings size={16} />
      <span class="nav-item__label">{$t('Settings')}</span>
      <Kbd keys="Mod+," />
    </button>
  </div>
  {/if}
</nav>

{#snippet chat(session: WorkspaceSession, hidden: WorkspaceSession[])}
  {@const status = sessionStatus(session) ?? hidden.map(sessionStatus).find((value) => value !== undefined)}
  {@const worktree = placements.get(session.id)?.worktree}
  {@const mark = marks.session(session.id)}
  <button
    type="button"
    class="chat"
    class:chat--current={store.selectedSessionId === session.id}
    aria-current={store.selectedSessionId === session.id ? 'page' : undefined}
    onclick={() => go(() => void store.openSession(session.id))}
    title={worktree ? `${session.title} · ${worktree.branch}` : session.title}
    draggable="true"
    ondragstart={(event) => {
      event.dataTransfer?.setData('application/x-piui-chat', session.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }}
  >
    {#if worktree}
      <span class="chat__worktree" class:chat__worktree--gone={worktree.state !== 'ready'}><GitBranch size={12} /></span>
    {/if}
    {#if mark}<Mark {mark} size={13} />{/if}
    <span class="chat__title">{session.title}</span>
    {#if worktree}<span class="visually-hidden">{$t('in worktree {0}', [worktree.branch])}</span>{/if}
    <span class="chat__end">
      {#if status}
        <StatusDot {status} label={status === 'waiting' ? $t('Needs your decision') : status === 'running' ? $t('Running') : $t('Failed')} />
      {:else if attentionKind?.(session.id)}
        <span class="chat__attention" role="img" aria-label={attentionLabel(attentionKind?.(session.id))}></span>
      {:else}
        <span class="chat__time">{relativeTime(session.updatedAt, $language, now)}</span>
      {/if}
    </span>
  </button>
  <div class="chat__menu">
    <Menu align="end" items={chatItems(session)}>
      {#snippet trigger(props)}
        <button type="button" class="tiny-action" aria-label={$t('Options for {0}', [session.title])} {...props}><Ellipsis size={14} /></button>
      {/snippet}
    </Menu>
  </div>
{/snippet}

{#snippet project(workspace: WorkspaceSummary, Icon: typeof Folder, name: string)}
  {@const collapsed = store.collapsedProjects.includes(workspace.id)}
  {@const sessions = store.sessionsFor(workspace.id)}
  {@const projectMark = marks.project(workspace.id)}
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
        {#if projectMark}<Mark mark={projectMark} size={15} />{:else}<Icon size={15} />{/if}
        <span class="project__name">{name}</span>
        {#if workspace.missing}
          <span class="tag">{$t('Missing')}</span>
        {:else if workspace.trust === 'restricted' && !workspace.personal}
          <span class="tag tag--warn" title={$t('Restricted until you trust this folder')}><ShieldAlert size={11} /></span>
        {/if}
      </button>
      <div class="project__actions">
        {#if !workspace.personal && !remoteMode}
          <Menu
            align="end"
            items={[
              ...(workspace.trust === 'restricted'
                ? [{ label: $t('Trust this folder…'), icon: ShieldCheck, onSelect: () => onTrust(workspace) }]
                : []),
              ...boardItems(workspace),
              { label: $t('Pipelines'), icon: Workflow, onSelect: () => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'pipelines', section: 'systems' }); }) },
              historyItem(workspace),
              ...manageItems(workspace),
            ]}
          >
            {#snippet trigger(props)}
              <button type="button" class="tiny-action" aria-label={$t('Options for {0}', [name])} {...props}><Ellipsis size={14} /></button>
            {/snippet}
          </Menu>
        {:else}
          <Menu align="end" items={[
            ...(!workspace.personal && workspace.trust === 'trusted' && hostSupports('board_command_v1', 'teammates_command_v1') ? boardItems(workspace) : []),
            ...(!workspace.personal && pipelineSectionAvailable('systems') ? [{ label: $t('Pipelines'), icon: Workflow, onSelect: () => go(() => { store.selectWorkspace(workspace.id); store.navigate({ name: 'pipelines', section: 'systems' }); }) }] : []),
            historyItem(workspace),
          ]}>
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
      </div>
      <IconButton
        class="project-new-chat"
        label={$t('New chat in {0}', [name])}
        tooltipSide="left"
        onclick={() => go(() => store.goHome(workspace.id))}
        disabled={workspace.missing}
      ><SquarePen /></IconButton>
    </div>
    {#if !collapsed}
      <ul class="chats">
        {#each chatTree(sessions, parentOf) as item (item.session.id)}
          {@const open = item.children.length > 0 && expandedLeads.includes(item.session.id)}
          <li>
            {@render chat(item.session, item.children.length > 0 && !open ? item.children : [])}
            {#if item.children.length > 0}
              <button
                type="button"
                class="chat__toggle"
                aria-expanded={open}
                aria-label={item.children.every((child) => fusionMembership.isSidekick(child.id))
                  ? open ? $t('Hide sidekick chats') : $t('Show sidekick chats')
                  : open ? $t('Hide linked chats') : $t('Show linked chats')}
                onclick={() => toggleLead(item.session.id)}
              >
                <span class="chevron" class:chevron--open={open}><ChevronRight size={12} /></span>
                {#if item.children.length > 1}<span class="chat__count">{item.children.length}</span>{/if}
              </button>
            {/if}
            {#if open}
              <ul class="chats chats--nested">
                {#each item.children as child (child.id)}
                  <li>{@render chat(child, [])}</li>
                {/each}
              </ul>
            {/if}
          </li>
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
  .nano-chip[data-tone='warning'] :global(svg) {
    color: var(--piui-warning);
  }
  .nano-chip[data-tone='danger'] :global(svg),
  .nano-chip[data-tone='danger'] .nano-chip__credits {
    color: var(--piui-danger);
  }
  .nano-chip__credits {
    flex: none;
    font-size: var(--piui-text-xs);
    font-variant-numeric: tabular-nums;
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
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    margin-top: var(--piui-space-2);
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
  .project__row :global(.project-new-chat) {
    flex: none;
    margin-inline-end: var(--piui-space-1);
  }
  .project__row .project__actions {
    padding-right: 4px;
    opacity: 0;
  }
  .project__row:hover .project__actions,
  .project__row:focus-within .project__actions {
    opacity: 1;
  }
  @media (hover: none) {
    .project__row .project__actions { opacity: 1; }
    .project__actions .tiny-action,
    .project__row :global(.project-new-chat) { min-width: 44px; min-height: 44px; }
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
  .chat__end {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .chat__menu {
    position: absolute;
    top: 3px;
    right: 4px;
    opacity: 0;
  }
  .chats > li:has(> .chat__toggle) > .chat__menu {
    right: 32px;
  }
  .chats > li:hover:not(:has(> .chats:hover)) > .chat__menu,
  .chats > li:focus-within:not(:has(> .chats:focus-within)) > .chat__menu,
  .chat__menu:has([aria-expanded='true']) {
    opacity: 1;
  }
  .chats > li:hover:not(:has(> .chats:hover)) > .chat > .chat__end,
  .chats > li:focus-within:not(:has(> .chats:focus-within)) > .chat > .chat__end,
  .chats > li:has(> .chat__menu [aria-expanded='true']) > .chat > .chat__end {
    opacity: 0;
  }
  .chat__attention {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--piui-accent);
    flex: none;
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
  .chats > li {
    position: relative;
  }
  .chats > li:has(> .chat__toggle) > .chat {
    padding-right: 52px;
  }
  .chat__toggle {
    position: absolute;
    top: 3px;
    right: 4px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 22px;
    padding: 0 4px;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .chat__toggle:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chat__count {
    font-variant-numeric: tabular-nums;
  }
  .chats--nested {
    margin-left: var(--piui-space-2);
    padding: 1px 0 2px var(--piui-space-2);
    border-left: 1px solid var(--piui-border);
    border-bottom-left-radius: var(--piui-radius-sm);
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
