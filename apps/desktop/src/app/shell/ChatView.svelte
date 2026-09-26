<script lang="ts">
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Square from '@lucide/svelte/icons/square';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Power from '@lucide/svelte/icons/power';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { t } from '../../features/locale/language';
  import { statusLabel } from '../../features/workspace/workspaceState';
  import { Badge, Button, EmptyState, IconButton, Menu, Skeleton, Spinner, matchesShortcut } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import ApprovalCard from './ApprovalCard.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import ChatDetails from './ChatDetails.svelte';
  import ChatComposer from '../chat/ChatComposer.svelte';
  import ExtensionSurface from '../chat/extensions/ExtensionSurface.svelte';
  import { extensionSurfaces } from '../chat/extensions/extensionSurfaces.svelte';
  import Transcript from '../chat/transcript/Transcript.svelte';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { useWorkspace } from './context';

  interface Props {
    sessionId: string;
    onDelete: (sessionId: string) => void;
  }
  let { sessionId, onDelete }: Props = $props();
  const store = useWorkspace();

  const session = $derived(store.catalog.sessions.find((item) => item.id === sessionId));
  const snapshot = $derived(store.snapshots[sessionId]);
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === session?.workspaceId));
  const running = $derived(session ? ['starting', 'running', 'stopping'].includes(session.status) : false);

  let detailsOpen = $state(readDetailsOpen());
  let searchOpen = $state(false);
  let renaming = $state(false);
  let titleDraft = $state('');
  let titleInput = $state<HTMLInputElement | null>(null);

  function readDetailsOpen(): boolean {
    try {
      return localStorage.getItem('piui.shell.details') === '1';
    } catch {
      return false;
    }
  }
  function toggleDetails(): void {
    detailsOpen = !detailsOpen;
    try {
      localStorage.setItem('piui.shell.details', detailsOpen ? '1' : '0');
    } catch {
      // Optional UI preference.
    }
  }

  function beginRename(): void {
    if (!session) return;
    titleDraft = session.title;
    renaming = true;
    queueMicrotask(() => titleInput?.select());
  }
  async function commitRename(): Promise<void> {
    if (!renaming || !session) return;
    renaming = false;
    if (titleDraft.trim() && titleDraft.trim() !== session.title) await store.rename(session.id, titleDraft);
  }

  function keydown(event: KeyboardEvent): void {
    if (matchesShortcut(event, 'Mod+Alt+B')) {
      event.preventDefault();
      toggleDetails();
    } else if (matchesShortcut(event, 'Mod+F')) {
      event.preventDefault();
      searchOpen = true;
    }
  }

  const statusTone = $derived(
    session?.status === 'failed' ? 'danger' : running ? 'accent' : session?.status === 'closed' ? 'neutral' : undefined,
  );
</script>

<svelte:window onkeydown={keydown} />

{#if session}
  <div class="chat" class:chat--details={detailsOpen}>
    <section class="chat__main" aria-labelledby="chat-title">
      <header class="chat__head">
        <HarnessMark kind={session.harness} size={20} decorative={false} />
        {#if renaming}
          <input
            bind:this={titleInput}
            bind:value={titleDraft}
            class="title-input"
            aria-label={$t('Chat title')}
            onblur={() => void commitRename()}
            onkeydown={(event) => {
              if (event.key === 'Enter') void commitRename();
              if (event.key === 'Escape') renaming = false;
            }}
          />
        {:else}
          <h1 id="chat-title" ondblclick={beginRename} title={session.title}>{session.title}</h1>
        {/if}
        {#if statusTone}
          <Badge tone={statusTone}>
            {#if running}<Spinner size={10} />{/if}
            {$t(statusLabel(session.status))}
          </Badge>
        {/if}
        <span class="chat__meta">{harnessMeta(session.harness).label}{workspace ? ` · ${workspace.personal ? $t('Personal chats') : workspace.name}` : ''}</span>
        <div class="chat__actions">
          {#if running}
            <Button size="sm" variant="ghost" onclick={() => void store.interrupt(session.id)} loading={store.interruptBusy}>
              {#snippet leading()}<Square />{/snippet}
              {$t('Stop')}
            </Button>
          {/if}
          <IconButton label={$t('Search this chat')} shortcut="Mod+F" active={searchOpen} onclick={() => (searchOpen = !searchOpen)}><SearchIcon /></IconButton>
          <IconButton label={$t('Details')} shortcut="Mod+Alt+B" active={detailsOpen} onclick={toggleDetails}><PanelRight /></IconButton>
          <Menu
            align="end"
            items={[
              { label: $t('Rename'), icon: Pencil, onSelect: beginRename },
              { label: $t('Refresh from history'), icon: RefreshCw, onSelect: () => void store.reconcileSession(session.id) },
              ...(session.status !== 'closed'
                ? [{ label: $t('Stop agent process'), icon: Power, onSelect: () => void store.close(session.id) }]
                : []),
              { type: 'separator' as const },
              ...(!session.runId
                ? [{ label: $t('Delete chat…'), icon: Trash, danger: true, disabled: running || store.safeMode, onSelect: () => onDelete(session.id) }]
                : []),
            ]}
          >
            {#snippet trigger(props)}
              <IconButton label={$t('Chat actions')} tooltip={false} {...props}><Ellipsis /></IconButton>
            {/snippet}
          </Menu>
        </div>
      </header>

      {#if store.sessionError && store.selectedSessionId === session.id}
        <div class="banner" role="alert">
          <span>{$t(store.sessionError)}</span>
          <Button size="sm" variant="ghost" onclick={() => void store.reconcileSession(session.id)}>{$t('Check status')}</Button>
        </div>
      {/if}

      {#if snapshot}
          <Transcript
            blocks={snapshot.blocks}
            loading={store.sessionLoading}
            sessionKey={snapshot.session.id}
            historySessionId={snapshot.session.id}
            agentLabel={harnessMeta(snapshot.session.harness).label}
            bind:searchOpen
          />
          <div class="composer-zone">
            {#each snapshot.approvals as approval (approval.id)}
              <ApprovalCard {approval} session={snapshot.session} />
            {/each}
            <ExtensionSurface sessionId={snapshot.session.id} status={snapshot.session.status} placement="above" agentLabel={harnessMeta(snapshot.session.harness).label} />
            {#if store.safeMode}
              <p class="notice">{$t('Runtime actions are disabled in safe mode. Your draft is preserved.')}</p>
            {:else if snapshot.session.status === 'closed'}
              <p class="notice">
                {$t('The agent process is stopped. The transcript stays readable.')}
                <Button size="sm" variant="ghost" onclick={() => void store.openSession(session.id)}>{$t('Resume')}</Button>
              </p>
            {:else if !snapshot.capabilities.prompt.supported}
              <p class="notice">{snapshot.capabilities.prompt.reason ?? $t('{0} is read-only in this mode.', [harnessMeta(session.harness).label])}</p>
            {:else}
              <!-- Extension-prepared text remounts the composer with the new draft. -->
              {#key `${snapshot.session.id}:${extensionSurfaces.composerEpoch(snapshot.session.id)}`}
                <ChatComposer
                  {snapshot}
                  draft={store.draftFor(snapshot.session.id)}
                  updateDraft={(text: string) => store.updateDraft(snapshot.session.id, text)}
                  images={store.attachmentsFor(snapshot.session.id)}
                  updateImages={(images) => store.updateAttachments(snapshot.session.id, images)}
                  refresh={() => void store.reconcileSession(snapshot.session.id)}
                  interrupt={() => store.interrupt(snapshot.session.id)}
                  interruptBusy={store.interruptBusy}
                />
              {/key}
            {/if}
            <ExtensionSurface sessionId={snapshot.session.id} status={snapshot.session.status} placement="below" agentLabel={harnessMeta(snapshot.session.harness).label} />
          </div>
        {:else if store.sessionLoading}
          <div class="loading"><Skeleton lines={6} /></div>
        {:else}
          <EmptyState title={$t('The chat could not be opened')} description={store.sessionError ? $t(store.sessionError) : undefined}>
            {#snippet actions()}
              <Button size="sm" onclick={() => void store.openSession(session.id)} disabled={store.safeMode}>{$t('Try again')}</Button>
            {/snippet}
          </EmptyState>
        {/if}
    </section>

    {#if detailsOpen && snapshot}
      <ChatDetails {snapshot} onClose={toggleDetails} onDelete={() => onDelete(session.id)} />
    {/if}
  </div>
{:else}
  <EmptyState title={$t('This chat is no longer available')} description={$t('It may have been deleted.')}>
    {#snippet actions()}
      <Button size="sm" onclick={() => store.goHome()}>{$t('New chat')}</Button>
    {/snippet}
  </EmptyState>
{/if}

<style>
  .chat {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .chat--details {
    grid-template-columns: minmax(0, 1fr) var(--piui-panel-width);
  }
  .chat__main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .chat__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h1 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }
  .title-input {
    min-width: 200px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--piui-focus);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    outline: none;
  }
  .chat__meta {
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat__actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    margin: var(--piui-space-2) var(--piui-space-4) 0;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .loading {
    padding: var(--piui-space-8);
  }
  .composer-zone {
    display: grid;
    gap: var(--piui-space-2);
    width: min(var(--piui-chat-column-width), 100%);
    margin: 0 auto;
    padding: 0 var(--piui-chat-inline-padding) var(--piui-space-3);
    flex: none;
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--piui-space-2);
    margin: 0;
    padding: var(--piui-space-3);
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-md);
    color: var(--piui-text-muted);
    text-align: center;
  }
</style>
