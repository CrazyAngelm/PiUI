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
  import { readWorkspaceHistory } from '../../host-api/workspaceHistory';
  import { Badge, Button, EmptyState, IconButton, Input, Picker, Skeleton, Spinner, matchesShortcut, type PickerItem } from '../../lib/ui';
  import Transcript from '../chat/transcript/Transcript.svelte';
  import { relativeTime } from '../format';
  import { harnessMeta } from '../harnessMeta';
  import { useWorkspace } from '../shell/context';
  import { placements } from '../worktrees/placements.svelte';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import HistoryDetails from './HistoryDetails.svelte';
  import ContinueInPiui from './ContinueInPiui.svelte';
  import { PiHistoryStore } from './historyStore.svelte';
  import {
    ALL_HARNESSES,
    ChatHistoryReader,
    effectiveFilter,
    filterOptions,
    indexedKindOf,
    matchesFilter,
    mergeRows,
    otherHarnessChats,
    type HistoryFilter,
  } from './chatHistory.svelte';
  import { historyAgentLabel, parseStateLabel, scopeForWorkspace } from './piHistory';

  interface Props {
    workspaceId: string;
    sessionId?: string;
  }
  let { workspaceId, sessionId }: Props = $props();
  const store = useWorkspace();
  const history = new PiHistoryStore(piHistoryHost);
  const chatReader = new ChatHistoryReader(readWorkspaceHistory);

  const DETAILS_KEY = 'piui.shell.history.details';
  let detailsOpen = $state(readDetails());
  let now = $state(Date.now());

  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === workspaceId));
  const personal = $derived(workspace?.personal ?? false);
  const known = $derived(workspace !== undefined);
  const agentKind = $derived(personal ? 'pi' : store.projectSummaries.find((project) => project.id === workspaceId)?.agentKind);
  const agentLabel = $derived(historyAgentLabel(agentKind));
  const indexedKind = $derived(indexedKindOf(agentKind));
  const chats = $derived(otherHarnessChats(store.sessionsFor(workspaceId), indexedKind, (id) => placements.get(id)?.adopted === true));
  const indexSessions = $derived(history.catalog?.sessions ?? []);
  const options = $derived(filterOptions(indexSessions, chats, indexedKind));
  let harnessFilter = $state<HistoryFilter>(ALL_HARNESSES);
  const activeFilter = $derived(effectiveFilter(harnessFilter, options));
  const rows = $derived(mergeRows(indexSessions, chats, activeFilter, history.query, indexedKind));
  // Cross-folder matches are index sessions: keep those of a project whose indexed harness passes the filter.
  const otherResults = $derived(
    history.otherResults.filter((result) =>
      matchesFilter(activeFilter, indexedKindOf(store.projectSummaries.find((project) => project.id === result.projectId)?.agentKind)),
    ),
  );
  const filterItems = $derived<PickerItem[]>([
    { value: ALL_HARNESSES, label: $t('All harnesses') },
    ...options.map((kind) => ({ value: kind, label: harnessMeta(kind).label })),
  ]);
  const filterLabel = $derived(activeFilter === ALL_HARNESSES ? $t('All harnesses') : harnessMeta(activeFilter).label);
  const chat = $derived(chats.find((item) => item.id === chatReader.sessionId));
  const projectName = (id: string) => {
    const item = store.catalog.workspaces.find((candidate) => candidate.id === id);
    return item ? (item.personal ? $t('Personal chats') : item.name) : '';
  };
  const projectItems = $derived<PickerItem[]>(
    store.catalog.workspaces.map((item) => ({ value: item.id, label: item.personal ? $t('Personal chats') : item.name })),
  );
  const selected = $derived(history.selected);
  const reader = $derived(history.reader);
  const hasSelection = $derived(selected !== undefined || chat !== undefined);

  // Route → store. Only primitive route values are dependencies, so catalog
  // reloads never reopen a scope and store writes never re-trigger this effect.
  $effect(() => {
    if (!known) return;
    const scope = scopeForWorkspace({ id: workspaceId, personal });
    const target = sessionId;
    untrack(() => void history.open(scope, target));
  });

  // A chat selection is local state: another folder or an opened Pi/Prime session replaces it.
  // The prop reads the route, which every navigation replaces: only a new folder clears it.
  let chatScope: string | undefined;
  $effect(() => {
    const id = workspaceId;
    if (chatScope === id) return;
    chatScope = id;
    untrack(() => {
      chatReader.clear();
      harnessFilter = ALL_HARNESSES;
    });
  });
  $effect(() => {
    if (sessionId !== undefined) untrack(() => chatReader.clear());
  });
  $effect(() => {
    if (chatReader.sessionId !== undefined && chat === undefined && !store.catalogLoading) untrack(() => chatReader.clear());
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
  function openChatHistory(id: string): void {
    history.clearSelection();
    store.navigate({ name: 'history', workspaceId });
    void chatReader.open(id);
  }
  function openElsewhere(projectId: string, id: string): void {
    store.navigate({ name: 'history', workspaceId: projectId, sessionId: id });
  }
  function selectProject(id: string): void {
    store.navigate({ name: 'history', workspaceId: id });
  }
  function backToList(): void {
    history.clearSelection();
    chatReader.clear();
    store.navigate({ name: 'history', workspaceId });
  }

  function keydown(event: KeyboardEvent): void {
    if (matchesShortcut(event, 'Mod+Alt+B') && selected && !chat) {
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
    <h1 id="history-title" class="title"><ScrollText size={15} /> {$t('Session history')}</h1>
    {#if history.refreshing}<span class="status" role="status"><Spinner size={12} /> {$t('Refreshing…')}</span>{/if}
    <div class="spacer"></div>
    <IconButton label={$t('Refresh sessions')} onclick={() => void history.refresh()} disabled={history.refreshing || !known}><RefreshCw /></IconButton>
  </header>

  {#if !known && store.catalogLoading}
    <div class="loading"><Skeleton lines={4} /></div>
  {:else if !known}
    <EmptyState title={$t('This folder is no longer in Nano Desktop')} description={$t('Choose another project above.')} />
  {:else}
    <div class="body" class:body--details={detailsOpen && selected && !chat} class:body--selected={hasSelection}>
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
          {#if options.length > 1}
            <Picker
              items={filterItems}
              value={activeFilter}
              label={$t('Filter by harness')}
              searchPlaceholder={$t('Search')}
              emptyText={$t('Nothing found')}
              width={220}
              align="end"
              onSelect={(value) => (harnessFilter = value as HistoryFilter)}
            >
              {#snippet trigger(props)}
                <button type="button" class="harness-filter" aria-label={`${$t('Filter by harness')}: ${filterLabel}`} {...props}>
                  <span>{filterLabel}</span>
                  <ChevronDown size={12} />
                </button>
              {/snippet}
            </Picker>
          {/if}
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
          {#if history.catalogError && chats.length > 0 && !history.loadingCatalog}
            <p class="inline-note inline-note--warn" role="status">
              <TriangleAlert size={13} /> {$t(history.catalogError)}
              <Button size="sm" variant="ghost" onclick={() => void history.refresh()}>{$t('Try again')}</Button>
            </p>
          {/if}
          {#if history.loadingCatalog}
            <div class="rows__loading"><Skeleton lines={5} height="14px" /></div>
          {:else if history.catalogError && chats.length === 0}
            <EmptyState size="sm" title={$t('Could not read the session list')} description={$t(history.catalogError)}>
              {#snippet actions()}<Button size="sm" onclick={() => void history.refresh()}>{$t('Try again')}</Button>{/snippet}
            </EmptyState>
          {:else if indexSessions.length + chats.length === 0}
            <EmptyState
              size="sm"
              icon={ScrollText}
              title={$t('No sessions here yet')}
              description={personal
                ? $t('Chats you run with Pi outside a project folder appear here.')
                : $t('Sessions you run with the {0} terminal app in this folder appear here.', [agentLabel])}
            />
          {:else if rows.length === 0}
            <p class="rows__empty">{$t('No sessions match the filter.')}</p>
          {:else}
            <ul>
              {#each rows as row (`${row.kind}:${row.id}`)}
                {#if row.kind === 'index'}
                  {@const session = row.session}
                  {@const problem = parseStateLabel(session.parseState)}
                  <li>
                    <button
                      type="button"
                      class="row"
                      class:row--current={chat === undefined && session.id === history.selectedId}
                      aria-current={chat === undefined && session.id === history.selectedId ? 'page' : undefined}
                      onclick={() => openSession(session.id)}
                    >
                      <HarnessMark kind={row.harness} size={16} />
                      <span class="row__text">
                        <span class="row__title" title={session.title}>{session.title}</span>
                        <span class="row__meta">
                          {#if options.length > 1}<span>{harnessMeta(row.harness).label} ·</span>{/if}
                          <span>{relativeTime(session.updatedAt ?? session.createdAt, $language, now)}</span>
                          <span>· {$t('{0} entries', [session.entryCount])}</span>
                          {#if (session.branchCount ?? 1) > 1}<span>· {$t('{0} branches', [session.branchCount])}</span>{/if}
                          {#if problem}<span class="row__problem">· {$t(problem)}</span>{/if}
                        </span>
                      </span>
                    </button>
                  </li>
                {:else}
                  <li>
                    <button
                      type="button"
                      class="row"
                      class:row--current={row.id === chatReader.sessionId}
                      aria-current={row.id === chatReader.sessionId ? 'page' : undefined}
                      onclick={() => openChatHistory(row.id)}
                    >
                      <HarnessMark kind={row.harness} size={16} />
                      <span class="row__text">
                        <span class="row__title" title={row.chat.title}>{row.chat.title}</span>
                        <span class="row__meta">
                          <span>{harnessMeta(row.harness).label} ·</span>
                          <span>{relativeTime(row.chat.updatedAt, $language, now)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}
          {#if history.query.trim()}
            <section class="others" aria-label={$t('Matches in other folders')}>
              {#if history.searchBusy}
                <p class="rows__empty" role="status"><Spinner size={12} /> {$t('Searching other folders…')}</p>
              {:else if history.searchError}
                <p class="rows__empty">{$t(history.searchError)}</p>
              {:else if otherResults.length}
                <h2>{$t('In other folders')}</h2>
                <ul>
                  {#each otherResults as result (`${result.projectId}:${result.id}`)}
                    <li>
                      <button type="button" class="row row--plain" onclick={() => openElsewhere(result.projectId ?? workspaceId, result.id)}>
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
        <p class="scope">{$t('Other agents list only chats started in Nano Desktop.')}</p>
      </aside>

      <section class="reader" aria-label={$t('Transcript')}>
        {#if chat}
          <header class="reader__head">
            <IconButton class="back" label={$t('Back to sessions')} size="sm" onclick={backToList}><ChevronLeft /></IconButton>
            <h2 title={chat.title}>{chat.title}</h2>
            <Badge>{$t('Read only')}</Badge>
            <div class="spacer"></div>
            <Button size="sm" onclick={() => void store.openSession(chat.id)}>{$t('Open chat')}</Button>
          </header>
          {#if chatReader.error && chatReader.blocks.length === 0}
            <EmptyState title={$t('Could not open this session')} description={$t(chatReader.error)}>
              {#snippet actions()}<Button size="sm" onclick={() => void chatReader.open(chat.id)}>{$t('Try again')}</Button>{/snippet}
            </EmptyState>
          {:else}
            {#key chat.id}
              <Transcript
                blocks={chatReader.blocks}
                loading={chatReader.loading}
                sessionKey={`history-chat:${chat.id}`}
                agentLabel={harnessMeta(chat.harness).label}
                emptyText={$t('This session has no readable messages.')}
              />
            {/key}
          {/if}
        {:else if selected === undefined}
          {#if history.notice}<p class="inline-note" role="status">{$t(history.notice)}</p>{/if}
          <EmptyState icon={ScrollText} title={$t('Choose a session')} description={$t('Read-only history. Nano Desktop never changes session files.')} />
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

      {#if detailsOpen && selected && !chat}
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
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    flex: none;
  }
  .filter :global(.input) {
    flex: 1;
    min-width: 0;
  }
  .harness-filter {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    height: 28px;
    max-width: 120px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .harness-filter span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .harness-filter:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .harness-filter:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
  .scope {
    flex: none;
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3) var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
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
    grid-template-columns: 16px minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .row--plain {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .row__text {
    display: grid;
    gap: 2px;
    min-width: 0;
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
