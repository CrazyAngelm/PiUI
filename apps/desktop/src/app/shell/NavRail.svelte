<script lang="ts">
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import Search from '@lucide/svelte/icons/search';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import Workflow from '@lucide/svelte/icons/workflow';
  import History from '@lucide/svelte/icons/history';
  import Clock from '@lucide/svelte/icons/clock-3';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import { t } from '../../features/locale/language';
  import { IconButton, Menu, StatusDot, type MenuEntry } from '../../lib/ui';
  import { nanoAccount } from '../nano/nanoAccount.svelte';
  import { remoteMode } from '../nano/remoteMode';
  import { useWorkspace } from './context';
  import { railCurrent, type RailItem } from './navRail';

  interface Props {
    onSearch: () => void;
    onNavigate?: () => void;
    /** The sidebar is hidden: the first control brings it back. */
    sidebarHidden?: boolean;
    onShowSidebar?: () => void;
  }
  let { onSearch, onNavigate = () => {}, sidebarHidden = false, onShowSidebar = undefined }: Props = $props();
  const store = useWorkspace();

  // The optional Nano account: read once after first paint, never before.
  $effect(() => nanoAccount.startLater());

  /** Bumped to retry the lazy work-location chunk after a failed load. */
  let locationAttempt = $state(0);
  const current = $derived(railCurrent(store.route));
  const inboxCount = $derived(store.inboxApprovals.length);
  const running = $derived(store.runningSessions.some((session) => session.runId));
  /** Session history of the current project, else the first available folder (same rule as the palette). */
  const historyWorkspaceId = $derived(store.selectedWorkspaceId || (store.catalog.workspaces.find((item) => !item.missing)?.id ?? ''));

  function go(action: () => void): void {
    action();
    onNavigate();
  }

  interface Entry {
    id: RailItem;
    label: string;
    icon: typeof Search;
    shortcut: string | undefined;
    run: () => void;
  }
  /** A remote browser (Nano Web, ADR-062) sees chats and projects only. */
  const REMOTE_ITEMS: ReadonlySet<RailItem> = new Set(['home', 'search', 'inbox']);
  const allItems = $derived<Entry[]>([
    { id: 'home', label: $t('New chat'), icon: SquarePen, shortcut: 'Mod+N', run: () => go(() => store.goHome()) },
    { id: 'search', label: $t('Search'), icon: Search, shortcut: 'Mod+K', run: onSearch },
    {
      id: 'inbox',
      label: inboxCount > 0 ? `${$t('Inbox')} ${$t('{0} waiting', [inboxCount])}` : $t('Inbox'),
      icon: InboxIcon,
      shortcut: 'Mod+Shift+I',
      run: () => go(() => store.navigate({ name: 'inbox' })),
    },
    { id: 'pipelines', label: $t('Pipelines'), icon: Workflow, shortcut: undefined, run: () => go(() => store.navigate({ name: 'pipelines', section: 'systems' })) },
    { id: 'runs', label: $t('Runs'), icon: History, shortcut: undefined, run: () => go(() => store.navigate({ name: 'pipelines', section: 'runs' })) },
    { id: 'automations', label: $t('Automations'), icon: Clock, shortcut: undefined, run: () => go(() => store.navigate({ name: 'pipelines', section: 'schedules' })) },
  ]);
  const items = $derived(remoteMode ? allItems.filter((item) => REMOTE_ITEMS.has(item.id)) : allItems);

  const more = $derived.by<MenuEntry[]>(() => {
    const entries: MenuEntry[] = [
      { label: $t('Agents'), onSelect: () => go(() => store.navigate({ name: 'pipelines', section: 'agents' })) },
      { label: $t('Teams'), onSelect: () => go(() => store.navigate({ name: 'pipelines', section: 'teams' })) },
      { label: $t('Step lists'), onSelect: () => go(() => store.navigate({ name: 'pipelines', section: 'pipelines' })) },
    ];
    const workspaceId = historyWorkspaceId;
    if (workspaceId) {
      entries.push({ type: 'separator' }, { label: $t('Session history'), onSelect: () => go(() => store.navigate({ name: 'history', workspaceId })) });
    }
    return entries;
  });
</script>

<nav class="rail" aria-label={$t('Main navigation')}>
  {#if sidebarHidden}
    <span class="rail__cell">
      <IconButton size="lg" label={$t('Show sidebar')} shortcut="Mod+B" tooltipSide="right" onclick={() => onShowSidebar?.()}>
        <PanelLeftOpen />
      </IconButton>
    </span>
  {/if}
  {#each items as item (item.id)}
    <span class="rail__cell">
      <IconButton
        size="lg"
        label={item.label}
        shortcut={item.shortcut}
        tooltipSide="right"
        aria-current={current === item.id ? 'page' : undefined}
        onclick={item.run}
      >
        <item.icon />
      </IconButton>
      {#if item.id === 'inbox' && inboxCount > 0}
        <span class="rail__count" aria-hidden="true">{inboxCount}</span>
      {:else if item.id === 'runs' && running}
        <span class="rail__dot"><StatusDot status="running" /></span>
      {/if}
    </span>
  {/each}
  {#if !remoteMode}
    <Menu side="right" align="end" items={more}>
      {#snippet trigger(props)}
        <IconButton size="lg" label={$t('More')} tooltip={false} title={$t('More')} {...props}><Ellipsis /></IconButton>
      {/snippet}
    </Menu>
  {/if}
  {#if nanoAccount.canUseCloud && !remoteMode}
    <div class="rail__end">
      <!-- Never needed at first paint; its own chunk keeps the first-paint budget. -->
      {#key locationAttempt}
        {#await import('../nano/WorkLocation.svelte') then location}
          <location.default />
        {:catch}
          <IconButton size="lg" label={$t('Try again')} onclick={() => (locationAttempt += 1)}><History /></IconButton>
        {/await}
      {/key}
    </div>
  {/if}
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    height: 100%;
    min-height: 0;
    padding: var(--piui-space-2) 0;
    overflow-y: auto;
    scrollbar-width: none;
    background: var(--piui-bg-raised);
    border-right: 1px solid var(--piui-border-subtle);
  }
  .rail__cell {
    position: relative;
    display: inline-flex;
  }
  .rail :global(.icon-btn svg) {
    width: 18px;
    height: 18px;
  }
  .rail :global(.icon-btn[aria-current='page']) {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  /* The rail is narrower than the default focus ring offset allows. */
  .rail :global(.icon-btn:focus-visible) {
    outline-offset: 1px;
  }
  .rail__count {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-action);
    color: var(--piui-action-ink);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    line-height: 16px;
    text-align: center;
    pointer-events: none;
  }
  .rail__dot {
    position: absolute;
    top: 6px;
    right: 6px;
    display: inline-flex;
    pointer-events: none;
  }
  .rail__end {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: auto;
    padding-top: var(--piui-space-2);
    border-top: 1px solid var(--piui-border-subtle);
  }
</style>
