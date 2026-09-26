<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import { onMount } from 'svelte';
  import Menu from '@lucide/svelte/icons/menu';
  import { t } from '../../features/locale/language';
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { Button, Dialog, IconButton, Toaster, matchesShortcut, toasts } from '../../lib/ui';
  import { WorkspaceStore, errorMessage } from '../workspaceStore.svelte';
  import HomeView from './HomeView.svelte';
  import Sidebar from './Sidebar.svelte';
  import { lazyViews, type LazyView } from './lazyViews.svelte';
  import { EmptyState, Skeleton } from '../../lib/ui';
  import { provideWorkspace } from './context';
  import { runLauncher } from '../triggers/runLauncher.svelte';
  import { syncTrayLabels } from '../settings/trayLabels';

  const store = provideWorkspace(new WorkspaceStore());
  // The tray menu (background mode) speaks the interface language.
  $effect(() => syncTrayLabels($t));

  let paletteOpen = $state(false);
  let drawerOpen = $state(false);
  let narrow = $state(false);
  let trustTarget = $state<WorkspaceSummary | undefined>();
  let trustBusy = $state(false);
  let trustError = $state('');
  let deleteTarget = $state<string | undefined>();
  let deleteBusy = $state(false);

  const deleteSession = $derived(store.catalog.sessions.find((session) => session.id === deleteTarget));

  const routeView = $derived<LazyView | undefined>(
    store.route.name === 'home' ? undefined : store.route.name === 'chat' ? 'chat' : store.route.name,
  );
  $effect(() => {
    if (routeView) void lazyViews.load(routeView);
  });
  $effect(() => {
    if (paletteOpen) void lazyViews.load('palette');
  });

  onMount(() => {
    void store.start();
    lazyViews.prefetch();
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => (narrow = query.matches);
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
      store.dispose();
    };
  });

  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (matchesShortcut(event, 'Mod+N')) {
      event.preventDefault();
      store.goHome();
    } else if (matchesShortcut(event, 'Mod+K')) {
      event.preventDefault();
      paletteOpen = !paletteOpen;
    } else if (matchesShortcut(event, 'Mod+,')) {
      event.preventDefault();
      store.navigate({ name: 'settings', section: 'general' });
    } else if (matchesShortcut(event, 'Mod+Shift+I')) {
      event.preventDefault();
      store.navigate({ name: 'inbox' });
    } else if (matchesShortcut(event, 'Mod+.') && store.selectedSession?.status === 'running') {
      event.preventDefault();
      void store.interrupt();
    } else if (event.key === 'Escape' && drawerOpen) {
      drawerOpen = false;
    }
  }

  function openTrust(workspace: WorkspaceSummary): void {
    trustTarget = workspace;
    trustError = '';
  }

  async function confirmTrust(): Promise<void> {
    if (!trustTarget || trustBusy) return;
    trustBusy = true;
    trustError = '';
    try {
      await store.trustProject(trustTarget.id);
      toasts.success($t('Folder trusted'), trustTarget.name);
      trustTarget = undefined;
    } catch (error) {
      trustError = errorMessage(error);
    } finally {
      trustBusy = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteBusy) return;
    deleteBusy = true;
    try {
      await store.deleteChat(deleteTarget);
      deleteTarget = undefined;
    } catch (error) {
      toasts.error($t('Could not delete the chat'), errorMessage(error));
    } finally {
      deleteBusy = false;
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={150}>
  <div class="app" class:app--narrow={narrow}>
    <a class="skip-link" href="#main">{$t('Skip to main content')}</a>
    {#if store.safeMode}
      <div class="safe-mode" role="status">{$t('Safe mode: history is read-only and agents are not started.')}</div>
    {/if}
    <div class="frame">
      {#if !narrow || drawerOpen}
        <div class="sidebar-slot" class:sidebar-slot--drawer={narrow}>
          <Sidebar onSearch={() => (paletteOpen = true)} onTrust={openTrust} onNavigate={() => (drawerOpen = false)} />
        </div>
        {#if narrow}
          <button type="button" class="scrim" aria-label={$t('Close navigation')} onclick={() => (drawerOpen = false)}></button>
        {/if}
      {/if}

      <main id="main" tabindex="-1" inert={narrow && drawerOpen}>
        {#if narrow}
          <div class="narrow-bar">
            <IconButton label={$t('Open navigation')} onclick={() => (drawerOpen = true)}><Menu /></IconButton>
            <strong>PiUI</strong>
          </div>
        {/if}
        {#if store.catalogError}
          <div class="top-error" role="alert">
            <span>{$t(store.catalogError)}</span>
            <Button size="sm" variant="ghost" onclick={() => void store.loadCatalog()}>{$t('Retry')}</Button>
          </div>
        {/if}
        <div class="view">
          {#if store.route.name === 'home'}
            <HomeView onTrust={openTrust} />
          {:else if routeView && lazyViews.failed[routeView]}
            <EmptyState title={$t('This view could not be loaded')} description={lazyViews.failed[routeView]} />
          {:else if store.route.name === 'chat' && lazyViews.loaded.chat}
            {@const ChatView = lazyViews.loaded.chat}
            {#key store.route.sessionId}
              <ChatView sessionId={store.route.sessionId} onDelete={(id) => (deleteTarget = id)} />
            {/key}
          {:else if store.route.name === 'inbox' && lazyViews.loaded.inbox}
            {@const InboxView = lazyViews.loaded.inbox}
            <InboxView />
          {:else if store.route.name === 'pipelines' && lazyViews.loaded.pipelines}
            {@const PipelinesView = lazyViews.loaded.pipelines}
            <PipelinesView section={store.route.section} runId={store.route.runId} />
          {:else if store.route.name === 'settings' && lazyViews.loaded.settings}
            {@const SettingsView = lazyViews.loaded.settings}
            <SettingsView section={store.route.section} onTrust={openTrust} />
          {:else if store.route.name === 'history' && lazyViews.loaded.history}
            {@const HistoryView = lazyViews.loaded.history}
            <HistoryView workspaceId={store.route.workspaceId} sessionId={store.route.sessionId} />
          {:else}
            <div class="view-loading"><Skeleton lines={5} /></div>
          {/if}
        </div>
      </main>
    </div>
  </div>

  {#if lazyViews.loaded.palette}
    {@const CommandPalette = lazyViews.loaded.palette}
    <CommandPalette bind:open={paletteOpen} />
  {/if}

  <!-- "Run a pipeline" from a chat or the palette; loaded on first request. -->
  {#if runLauncher.request}
    {#await import('../triggers/RunPipelineDialog.svelte') then module}
      {#key runLauncher.request}
        <module.default />
      {/key}
    {/await}
  {/if}

  <Dialog
    open={trustTarget !== undefined}
    title={trustTarget ? $t('Trust {0}?', [trustTarget.name]) : ''}
    description={$t('Agents can then work on files in this folder within the permissions of each chat.')}
    onOpenChange={(open) => {
      if (!open && !trustBusy) trustTarget = undefined;
    }}
  >
    <p class="dialog-text"><strong>{$t('Trust is not a sandbox.')}</strong> {$t('Native agent processes may access more of your computer unless their permission mode is enforced by the harness.')}</p>
    {#if trustError}<p class="dialog-error" role="alert">{$t(trustError)}</p>{/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (trustTarget = undefined)} disabled={trustBusy}>{$t('Cancel')}</Button>
      <Button variant="primary" onclick={() => void confirmTrust()} loading={trustBusy}>{$t('Trust folder')}</Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={deleteTarget !== undefined}
    title={$t('Delete chat?')}
    description={deleteSession?.title}
    size="sm"
    onOpenChange={(open) => {
      if (!open && !deleteBusy) deleteTarget = undefined;
    }}
  >
    <p class="dialog-text">{$t('The chat is removed from PiUI. The harness keeps its own history.')}</p>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (deleteTarget = undefined)} disabled={deleteBusy}>{$t('Cancel')}</Button>
      <Button variant="danger" onclick={() => void confirmDelete()} loading={deleteBusy}>{$t('Delete chat')}</Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={store.pendingNavigation !== undefined}
    title={$t('Leave the pipeline editor?')}
    description={$t('The draft has unsaved changes.')}
    size="sm"
    dismissible={false}
  >
    {#snippet footer()}
      <Button variant="ghost" onclick={() => store.cancelPendingNavigation()}>{$t('Keep editing')}</Button>
      <Button variant="danger" onclick={() => store.confirmPendingNavigation()}>{$t('Discard changes')}</Button>
    {/snippet}
  </Dialog>

  <Toaster dismissLabel={$t('Dismiss')} />
</TooltipPrimitive.Provider>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .skip-link {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: var(--piui-z-toast);
    padding: 8px 12px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-text);
    color: var(--piui-bg);
    transform: translateY(-160%);
  }
  .skip-link:focus {
    transform: none;
  }
  .safe-mode {
    padding: 6px var(--piui-space-4);
    border-bottom: 1px solid var(--piui-warning-border);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
    flex: none;
  }
  .frame {
    position: relative;
    display: grid;
    grid-template-columns: var(--piui-sidebar-width) minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  .app--narrow .frame {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar-slot {
    min-height: 0;
  }
  .sidebar-slot--drawer {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: var(--piui-z-overlay);
    width: min(300px, 86vw);
    box-shadow: var(--piui-shadow-3);
    animation: slide-in var(--piui-duration) var(--piui-ease-out);
  }
  @keyframes slide-in {
    from {
      transform: translateX(-12px);
      opacity: 0;
    }
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: calc(var(--piui-z-overlay) - 1);
    border: 0;
    background: var(--piui-overlay);
  }
  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    outline: none;
  }
  .narrow-bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: 44px;
    padding: 0 var(--piui-space-2);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .top-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    padding: 6px 8px 6px 16px;
    border-bottom: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    flex: none;
  }
  .view {
    flex: 1;
    min-height: 0;
  }
  .view-loading {
    width: min(760px, calc(100% - 48px));
    margin: var(--piui-space-12) auto;
  }
  .dialog-text {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .dialog-text strong {
    color: var(--piui-text);
  }
  .dialog-error {
    margin: var(--piui-space-3) 0 0;
    color: var(--piui-danger);
  }
</style>
