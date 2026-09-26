<script lang="ts">
  import { parseTimestamp } from '../../host-api/projectsClient';
  import { Command, Dialog } from 'bits-ui';
  import SquarePen from '@lucide/svelte/icons/square-pen';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import Workflow from '@lucide/svelte/icons/workflow';
  import History from '@lucide/svelte/icons/history';
  import Settings from '@lucide/svelte/icons/settings';
  import Folder from '@lucide/svelte/icons/folder';
  import Search from '@lucide/svelte/icons/search';
  import Moon from '@lucide/svelte/icons/moon';
  import Bot from '@lucide/svelte/icons/bot';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import { t } from '../../features/locale/language';
  import HarnessMark from './HarnessMark.svelte';
  import { useWorkspace } from './context';

  interface Props {
    open: boolean;
  }
  let { open = $bindable(false) }: Props = $props();
  const store = useWorkspace();
  let input = $state<HTMLInputElement | null>(null);

  // The palette mounts lazily on first use, after the dialog's own open
  // auto-focus has run; focus the search field explicitly every time.
  $effect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input?.focus());
    return () => cancelAnimationFrame(frame);
  });

  const chats = $derived(
    [...store.catalog.sessions]
      .filter((session) => !session.runId)
      .sort((left, right) => (parseTimestamp(right.updatedAt) || 0) - (parseTimestamp(left.updatedAt) || 0))
      .slice(0, 200),
  );
  const projectName = (id: string) => {
    const workspace = store.catalog.workspaces.find((item) => item.id === id);
    return workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : '';
  };

  /** Session history of the current project, else the first available folder. */
  const historyWorkspaceId = $derived(
    store.selectedWorkspaceId || (store.catalog.workspaces.find((item) => !item.missing)?.id ?? ''),
  );

  function run(action: () => void): void {
    open = false;
    action();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="piui-dialog__overlay" />
    <Dialog.Content
      class="palette"
      aria-label={$t('Search and commands')}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        input?.focus();
      }}
    >
      <Dialog.Title class="visually-hidden">{$t('Search and commands')}</Dialog.Title>
      <Command.Root loop label={$t('Search and commands')}>
        <div class="palette__search">
          <Search size={16} />
          <Command.Input bind:ref={input} class="palette__input" placeholder={$t('Search chats, projects and commands…')} />
        </div>
        <Command.List class="palette__list">
          <Command.Viewport>
            <Command.Empty class="palette__empty">{$t('Nothing found')}</Command.Empty>
            <!-- Keywords start with each command's visible label, so typing it finds the command. -->
            <Command.Group>
              <Command.GroupHeading class="palette__heading">{$t('Actions')}</Command.GroupHeading>
              <Command.GroupItems>
                <Command.Item class="palette__item" value="action:new-chat" keywords={[$t('New chat'), 'new', 'chat', 'новый']} onSelect={() => run(() => store.goHome())}>
                  <SquarePen size={15} /><span>{$t('New chat')}</span>
                </Command.Item>
                <Command.Item class="palette__item" value="action:inbox" keywords={[$t('Open inbox'), 'inbox', 'approvals']} onSelect={() => run(() => store.navigate({ name: 'inbox' }))}>
                  <InboxIcon size={15} /><span>{$t('Open inbox')}</span>
                </Command.Item>
                <Command.Item class="palette__item" value="action:pipelines" keywords={[$t('Open pipelines'), 'pipeline', 'graph', 'agents']} onSelect={() => run(() => store.navigate({ name: 'pipelines', section: 'systems' }))}>
                  <Workflow size={15} /><span>{$t('Open pipelines')}</span>
                </Command.Item>
                <Command.Item class="palette__item" value="action:runs" keywords={[$t('Open runs'), 'runs', 'history']} onSelect={() => run(() => store.navigate({ name: 'pipelines', section: 'runs' }))}>
                  <History size={15} /><span>{$t('Open runs')}</span>
                </Command.Item>
                {#if historyWorkspaceId}
                  <Command.Item class="palette__item" value="action:history" keywords={['history', 'sessions', 'branches', 'pi']} onSelect={() => run(() => store.navigate({ name: 'history', workspaceId: historyWorkspaceId }))}>
                    <ScrollText size={15} /><span>{$t('Open session history')}</span>
                  </Command.Item>
                {/if}
                <Command.Item class="palette__item" value="action:harnesses" keywords={[$t('Manage harnesses'), 'harness', 'codex', 'claude', 'pi']} onSelect={() => run(() => store.navigate({ name: 'settings', section: 'harnesses' }))}>
                  <Bot size={15} /><span>{$t('Manage harnesses')}</span>
                </Command.Item>
                <Command.Item
                  class="palette__item"
                  value="action:theme"
                  keywords={[$t('Toggle dark theme'), 'theme', 'dark', 'light']}
                  onSelect={() =>
                    run(() =>
                      void store.savePreferences({
                        ...store.preferences,
                        theme: store.preferences.theme === 'dark' ? 'light' : 'dark',
                      }),
                    )}
                >
                  <Moon size={15} /><span>{$t('Toggle dark theme')}</span>
                </Command.Item>
                <Command.Item class="palette__item" value="action:settings" keywords={[$t('Settings'), 'settings', 'preferences']} onSelect={() => run(() => store.navigate({ name: 'settings', section: 'general' }))}>
                  <Settings size={15} /><span>{$t('Settings')}</span>
                </Command.Item>
              </Command.GroupItems>
            </Command.Group>
            {#if chats.length}
              <Command.Group>
                <Command.GroupHeading class="palette__heading">{$t('Chats')}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each chats as session (session.id)}
                    <Command.Item
                      class="palette__item"
                      value={`chat:${session.id}`}
                      keywords={[session.title, projectName(session.workspaceId)]}
                      onSelect={() => run(() => void store.openSession(session.id))}
                    >
                      <HarnessMark kind={session.harness} size={16} />
                      <span class="palette__label">{session.title}</span>
                      <small>{projectName(session.workspaceId)}</small>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            <Command.Group>
              <Command.GroupHeading class="palette__heading">{$t('Projects')}</Command.GroupHeading>
              <Command.GroupItems>
                {#each store.catalog.workspaces.filter((item) => !item.missing) as workspace (workspace.id)}
                  <Command.Item
                    class="palette__item"
                    value={`project:${workspace.id}`}
                    keywords={[workspace.name]}
                    onSelect={() => run(() => store.goHome(workspace.id))}
                  >
                    <Folder size={15} /><span class="palette__label">{workspace.personal ? $t('Personal chats') : workspace.name}</span>
                    <small>{$t('New chat here')}</small>
                  </Command.Item>
                {/each}
              </Command.GroupItems>
            </Command.Group>
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.palette) {
    position: fixed;
    top: 14vh;
    left: 50%;
    z-index: var(--piui-z-modal);
    display: flex;
    flex-direction: column;
    width: min(640px, calc(100vw - 32px));
    max-height: 64vh;
    overflow: hidden;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-lg);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-3);
    transform: translateX(-50%);
    outline: none;
    animation: piui-pop-in var(--piui-duration) var(--piui-ease-out);
  }
  :global(.palette [data-command-root]) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .palette__search {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    padding: 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    color: var(--piui-text-muted);
  }
  :global(.palette__input) {
    flex: 1;
    height: 48px;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-xl);
  }
  :global(.palette__input::placeholder) {
    color: var(--piui-text-disabled);
  }
  :global(.palette__list) {
    min-height: 0;
    padding: var(--piui-space-2);
    overflow-y: auto;
  }
  :global(.palette__empty) {
    padding: var(--piui-space-6);
    color: var(--piui-text-muted);
    text-align: center;
  }
  :global(.palette__heading) {
    padding: 8px 10px 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  :global(.palette__item) {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    height: 36px;
    padding: 0 10px;
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text);
    cursor: default;
    outline: none;
  }
  :global(.palette__item[data-selected]) {
    background: var(--piui-hover);
  }
  :global(.palette__item svg) {
    flex: none;
    color: var(--piui-text-muted);
  }
  :global(.palette__item small) {
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .palette__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
