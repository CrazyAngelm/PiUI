<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Folder from '@lucide/svelte/icons/folder';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Search from '@lucide/svelte/icons/search';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t, language } from '../../features/locale/language';
  import { piHistoryHost } from '../../host-api/piHistoryClient';
  import { Badge, Button, EmptyState, IconButton, Input, Picker, Skeleton, Spinner, matchesShortcut, type PickerItem } from '../../lib/ui';
  import Transcript from '../chat/transcript/Transcript.svelte';
  import { relativeTime } from '../format';
  import { useWorkspace } from '../shell/context';
  import HistoryDetails from './HistoryDetails.svelte';
  import ContinueInPiui from './ContinueInPiui.svelte';
  import { PiHistoryStore } from './historyStore.svelte';
  import { historyAgentLabel, parseStateLabel, scopeForWorkspace } from './piHistory';

  interface Props {
    workspaceId: string;
    sessionId?: string;
  }
  let { workspaceId, sessionId }: Props = $props();
  const store = useWorkspace();
  const history = new PiHistoryStore(piHistoryHost);

  const DETAILS_KEY = 'piui.shell.history.details';
  let detailsOpen = $state(readDetails());
  let now = $state(Date.now());

  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === workspaceId));
  const personal = $derived(workspace?.personal ?? false);
  const known = $derived(workspace !== undefined);
  const agentKind = $derived(personal ? 'pi' : store.projectSummaries.find((project) => project.id === workspaceId)?.agentKind);
  const agentLabel = $derived(historyAgentLabel(agentKind));
  const projectName = (id: string) => {
    const item = store.catalog.workspaces.find((candidate) => candidate.id === id);
    return item ? (item.personal ? $t('Personal chats') : item.name) : '';
  };
  const projectItems = $derived<PickerItem[]>(
    store.catalog.workspaces.map((item) => ({ value: item.id, label: item.personal ? $t('Personal chats') : item.name })),
  );
  const selected = $derived(history.selected);
  const reader = $derived(history.reader);

  // Route → store. Only primitive route values are dependencies, so catalog
  // reloads never reopen a scope and store writes never re-trigger this effect.
  $effect(() => {
    if (!known) return;
    const scope = scopeForWorkspace({ id: workspaceId, personal });
    const target = sessionId;
    untrack(() => void history.open(scope, target));
  });

  onMount(() => {
    void history.start();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      history.dispose();
    };
  });

  function readDetails(): boolean {
    try {
      return localStorage.getItem(DETAILS_KEY) !== '0';
    } catch {
      return true;
    }
  }
  function toggleDetails(): void {
    detailsOpen = !detailsOpen;
    try {
      localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0');
    } catch {
      // Optional UI preference.
    }
  }

  function openSession(id: string): void {
    store.navigate({ name: 'history', workspaceId, sessionId: id });
  }
  function openElsewhere(projectId: string, id: string): void {
    store.navigate({ name: 'history', workspaceId: projectId, sessionId: id });
  }
  function selectProject(id: string): void {
    store.navigate({ name: 'history', workspaceId: id });
  }
  function backToList(): void {
    history.clearSelection();
    store.navigate({ name: 'history', workspaceId });
  }

  function keydown(event: KeyboardEvent): void {
    if (matchesShortcut(event, 'Mod+Alt+B') && selected) {
      event.preventDefault();
      toggleDetails();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<section class="history" aria-labelledby="history-title">
  <header class="head">
    <Picker items={projectItems} value={workspace?.id} label={$t('Project')} searchPlaceholder={$t('Search projects')} onSelect={selectProject}>
      {#snippet trigger(props)}
        <button type="button" class="project" {...props}>
          {#if personal}<MessagesSquare size={15} />{:else}<Folder size={15} />{/if}
          <span>{workspace ? projectName(workspace.id) : $t('Choose project')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>
    <h1 id="history-title" class="title"><ScrollText size={15} /> {$t('{0} session history', [agentLabel])}</h1>
    {#if history.refreshing}<span class="status" role="status"><Spinner size={12} /> {$t('Refreshing…')}</span>{/if}
    <div class="spacer"></div>
    <IconButton label={$t('Refresh sessions')} onclick={() => void history.refresh()} disabled={history.refreshing || !known}><RefreshCw /></IconButton>
  </header>

  {#if !known && store.catalogLoading}
    <div class="loading"><Skeleton lines={4} /></div>
  {:else if !known}
    <EmptyState title={$t('This folder is no longer in PiUI')} description={$t('Choose another project above.')} />
  {:else}
    <div class="body" class:body--details={detailsOpen && selected} class:body--selected={selected !== undefined}>
      <aside class="list" aria-label={$t('Sessions')}>
        <div class="filter">
          <Input
            size="sm"
            value={history.query}
            placeholder={$t('Filter by title or text')}
            aria-label={$t('Filter sessions')}
            oninput={(event) => history.setQuery(event.currentTarget.value)}
          >
            {#snippet leading()}<Search />{/snippet}
          </Input>
        </div>
        {#if workspace?.missing}
          <p class="inline-note" role="status">{$t('The folder is unavailable. Showing the last indexed sessions.')}</p>
        {/if}
        {#if history.refreshError}
          <p class="inline-note inline-note--warn" role="status">
            <TriangleAlert size={13} /> {$t(history.refreshError)}
            <Button size="sm" variant="ghost" onclick={() => void history.refresh()}>{$t('Retry')}</Button>
          </p>
        {/if}
        <div class="rows">
          {#if history.loadingCatalog}
            <div class="rows__loading"><Skeleton lines={5} height="14px" /></div>
          {:else if history.catalogError}
            <EmptyState size="sm" title={$t('Could not read the session list')} description={$t(history.catalogError)}>
              {#snippet actions()}<Button size="sm" onclick={() => void history.refresh()}>{$t('Try again')}</Button>{/snippet}
            </EmptyState>
          {:else if (history.catalog?.sessions.length ?? 0) === 0}
            <EmptyState
              size="sm"
              icon={ScrollText}
              title={$t('No {0} sessions here yet', [agentLabel])}
              description={personal
                ? $t('Chats you run with Pi outside a project folder appear here.')
                : $t('Sessions you run with the {0} terminal app in this folder appear here.', [agentLabel])}
            />
          {:else if history.sessions.length === 0}
            <p class="rows__empty">{$t('No sessions match the filter.')}</p>
          {:else}
            <ul>
              {#each history.sessions as session (session.id)}
                {@const problem = parseStateLabel(session.parseState)}
                <li>
                  <button
                    type="button"
                    class="row"
                    class:row--current={session.id === history.selectedId}
                    aria-current={session.id === history.selectedId ? 'page' : undefined}
                    onclick={() => openSession(session.id)}
                  >
                    <span class="row__title" title={session.title}>{session.title}</span>
                    <span class="row__meta">
                      <span>{relativeTime(session.updatedAt ?? session.createdAt, $language, now)}</span>
                      <span>· {$t('{0} entries', [session.entryCount])}</span>
                      {#if (session.branchCount ?? 1) > 1}<span>· {$t('{0} branches', [session.branchCount])}</span>{/if}
                      {#if problem}<span class="row__problem">· {$t(problem)}</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if history.query.trim()}
            <section class="others" aria-label={$t('Matches in other folders')}>
              {#if history.searchBusy}
                <p class="rows__empty" role="status"><Spinner size={12} /> {$t('Searching other folders…')}</p>
              {:else if history.searchError}
                <p class="rows__empty">{$t(history.searchError)}</p>
              {:else if history.otherResults.length}
                <h2>{$t('In other folders')}</h2>
                <ul>
                  {#each history.otherResults as result (`${result.projectId}:${result.id}`)}
                    <li>
                      <button type="button" class="row" onclick={() => openElsewhere(result.projectId ?? workspaceId, result.id)}>
                        <span class="row__title">{result.title}</span>
                        <span class="row__meta"><span>{projectName(result.projectId ?? '')}</span></span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/if}
        </div>
      </aside>

      <section class="reader" aria-label={$t('Transcript')}>
        {#if selected === undefined}
          {#if history.notice}<p class="inline-note" role="status">{$t(history.notice)}</p>{/if}
          <EmptyState icon={ScrollText} title={$t('Choose a session')} description={$t('Read-only history from the {0} session files of this folder. PiUI never changes them.', [agentLabel])} />
        {:else}
          <header class="reader__head">
            <IconButton class="back" label={$t('Back to sessions')} size="sm" onclick={backToList}><ChevronLeft /></IconButton>
            <h2 title={selected.title}>{selected.title}</h2>
            <Badge>{$t('Read only')}</Badge>
            <div class="spacer"></div>
            {#if agentKind === 'pi' && workspace && (personal || workspace.trust === 'trusted')}
              <ContinueInPiui {workspaceId} {personal} sessionId={selected.id} title={selected.title} />
            {/if}
            <IconButton label={$t('Details')} shortcut="Mod+Alt+B" active={detailsOpen} onclick={toggleDetails}><PanelRight /></IconButton>
          </header>
          {#if history.notice}<p class="inline-note" role="status">{$t(history.notice)}</p>{/if}
          {#if reader?.error && reader.blocks.length === 0}
            <EmptyState title={$t('Could not open this session')} description={$t(reader.error)}>
              {#snippet actions()}<Button size="sm" onclick={() => void history.reload()}>{$t('Try again')}</Button>{/snippet}
            </EmptyState>
          {:else if reader}
            {#if reader.error}
              <p class="inline-note inline-note--warn" role="alert">
                <TriangleAlert size={13} /> {$t(reader.error)}
                <Button size="sm" variant="ghost" onclick={() => void history.loadOlder()}>{$t('Retry')}</Button>
              </p>
            {/if}
            {#if reader.windowTruncated}
              <p class="inline-note" role="status">{$t('Showing an older part of this session. Reopen it to return to the latest entries.')}</p>
            {/if}
            {#key reader.sessionId}
              <Transcript
                blocks={reader.blocks}
                loading={reader.loading}
                sessionKey={`history:${workspaceId}:${reader.sessionId}`}
                {agentLabel}
                olderAvailable={reader.olderCursor !== undefined}
                olderLoading={reader.loadingOlder}
                onLoadOlder={() => void history.loadOlder()}
                emptyText={$t('This session has no readable messages.')}
              />
            {/key}
          {/if}
        {/if}
      </section>

      {#if detailsOpen && selected}
        <HistoryDetails session={selected} {reader} {agentLabel} onClose={toggleDetails} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .history {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .project {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .project:hover {
    background: var(--piui-hover);
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-regular);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .spacer {
    flex: 1;
  }
  .loading {
    padding: var(--piui-space-8);
  }
  .body {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  .body--details {
    grid-template-columns: 300px minmax(0, 1fr) var(--piui-panel-width);
  }
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--piui-border-subtle);
  }
  .filter {
    padding: var(--piui-space-3);
    flex: none;
  }
  .filter :global(.input) {
    width: 100%;
  }
  .rows {
    flex: 1;
    min-height: 0;
    padding: 0 var(--piui-space-2) var(--piui-space-4);
    overflow-y: auto;
  }
  .rows ul {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows__loading {
    padding: var(--piui-space-2);
  }
  .rows__empty {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: var(--piui-space-3) var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .row {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .row:hover {
    background: var(--piui-hover);
  }
  .row--current {
    background: var(--piui-selected);
  }
  .row:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
  .row__title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .row__problem {
    color: var(--piui-warning-text);
  }
  .others {
    margin-top: var(--piui-space-4);
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .others h2 {
    margin: 0 var(--piui-space-2) var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .inline-note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 var(--piui-space-3) var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .inline-note--warn {
    color: var(--piui-warning-text);
  }
  .reader {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .reader__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .reader__head h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader__head :global(.back) {
    display: none;
  }
  .reader > .inline-note {
    margin-top: var(--piui-space-2);
  }
  @media (max-width: 1100px) {
    .body--details {
      grid-template-columns: 260px minmax(0, 1fr) var(--piui-panel-width);
    }
  }
  @media (max-width: 900px) {
    .body,
    .body--details {
      grid-template-columns: minmax(0, 1fr);
    }
    .body--selected .list {
      display: none;
    }
    .body:not(.body--selected) .reader {
      display: none;
    }
    .body--details :global(.details) {
      display: none;
    }
    .reader__head :global(.back) {
      display: inline-flex;
    }
  }
</style>
