<script lang="ts">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import Route from '@lucide/svelte/icons/route';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import Copy from '@lucide/svelte/icons/copy';
  import Expand from '@lucide/svelte/icons/expand';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Search from '@lucide/svelte/icons/search';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import X from '@lucide/svelte/icons/x';
  import ImageIcon from '@lucide/svelte/icons/image';
  import { useTranslation } from '../../features/locale/context';
  import { useConversationPresentation } from './context';
  import type { ConversationAttachment } from '../../../../../contracts/conversation-presentation-v1';
  const t = useTranslation();
  const presentation = useConversationPresentation();
  import { splitImageMarkers } from '../../app/chat/composer/mentions';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import { createTimelineGrouper, type TimelineViewItem } from '../../features/sessions/timelineView';
  import type { TimelineBlock } from '../../host-api/types';
  import { Button, IconButton, Input, Skeleton, Spinner } from '../../lib/ui';
  import ActivityGroupView from '../../app/chat/transcript/ActivityGroupView.svelte';
  import { interleave, timeOf, type TimedInsert } from '../../app/chatPipelines/interleave';
  import { splitPipelineContext } from '../../app/chatPipelines/chatPipeline';

  interface Props {
    blocks: TimelineBlock[];
    loading: boolean;
    sessionKey: string;
    /** Reads the current owner's history; no implicit native or browser transport. */
    readHistory?: () => Promise<TimelineBlock[]>;
    /** Only native bridge projections use encoded image/pipeline markers. */
    nativeMarkers?: boolean;
    /** Optional native-owner metadata store; browser projections stay ephemeral. */
    positionStore?: {
      read(key: string): { top: number; following: boolean } | undefined;
      write(key: string, value: { top: number; following: boolean }): void;
    };
    language?: 'en' | 'ru';
    attachments?: readonly ConversationAttachment[];
    onOpenAttachment?: (id: string) => Promise<void>;
    agentLabel: string;
    searchOpen?: boolean;
    /** Read-only native history pages older entries in from the host. */
    olderAvailable?: boolean;
    olderLoading?: boolean;
    onLoadOlder?: () => void;
    emptyText?: string;
    /** Rows placed among the messages by time, e.g. the chat's pipeline runs. */
    inserts?: readonly TimedInsert[];
    insert?: Snippet<[string]>;
  }
  let {
    blocks,
    loading,
    sessionKey,
    readHistory,
    nativeMarkers = false,
    positionStore,
    language = 'en',
    attachments = [],
    onOpenAttachment,
    agentLabel,
    searchOpen = $bindable(false),
    olderAvailable = false,
    olderLoading = false,
    onLoadOlder,
    emptyText,
    inserts = [],
    insert,
  }: Props = $props();

  let disposed = false;
  onDestroy(() => { disposed = true; });
  const PAGE = 120;
  let limit = $state(PAGE);
  let scroller = $state<HTMLDivElement | null>(null);
  let following = $state(true);
  let openState = $state<Record<string, boolean>>({});
  let fullAnswers = $state<Record<string, string>>({});
  let busyAnswers = $state<Record<string, boolean>>({});

  // Search over saved native history (full answers, not just the live window).
  let query = $state('');
  let searchBusy = $state(false);
  let searchError = $state('');
  let searchBlocks = $state.raw<TimelineBlock[]>([]);
  let match = $state(0);
  let searchInput = $state<HTMLInputElement | null>(null);
  let searchOrigin: HTMLElement | null = null;

  // Unchanged rows keep their identity while a reply streams.
  const groupBlocks = createTimelineGrouper();
  const items = $derived(groupBlocks(blocks));
  const attachmentsByBlock = $derived.by(() => {
    const grouped = new Map<string, ConversationAttachment[]>();
    for (const attachment of attachments) {
      const list = grouped.get(attachment.blockId) ?? [];
      list.push(attachment);
      grouped.set(attachment.blockId, list);
    }
    return grouped;
  });
  const hidden = $derived(Math.max(0, items.length - limit));
  const visible = $derived(hidden > 0 ? items.slice(hidden) : items);
  // A window-only owner keeps publishing streaming/paged snapshots. Search those
  // current blocks; only an explicit full-history read has its own snapshot.
  const searchSource = $derived(readHistory ? searchBlocks : blocks);
  const matches = $derived(
    query.trim()
      ? searchSource.filter((block) => `${block.text ?? ''} ${block.safeSummary ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      : [],
  );
  const currentMatch = $derived(Math.min(match, Math.max(0, matches.length - 1)));
  const searching = $derived(searchOpen && query.trim().length > 0);
  // The last assistant message before the reader's next prompt carries the
  // copy/time actions; intermediate narration between tools stays compact.
  const turnEnds = $derived.by(() => {
    const ends = new Set<string>();
    const list = searching ? [] : visible;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (item?.type !== 'block' || item.block.kind !== 'assistant') continue;
      const next = list[index + 1];
      if (!next || (next.type === 'block' && next.block.kind === 'user')) ends.add(item.block.id);
    }
    return ends;
  });
  const shown = $derived<TimelineViewItem[]>(
    searching ? (matches[currentMatch] ? [{ type: 'block', block: matches[currentMatch] }] : []) : visible,
  );
  const itemTime = (item: TimelineViewItem): number => timeOf(item.type === 'block' ? item.block.createdAt : item.blocks[0]?.createdAt);
  // Runs before the first shown message wait until earlier messages are shown.
  const placed = $derived.by(() => {
    if (searching || !insert) return [];
    if (hidden === 0) return inserts;
    const first = visible.map(itemTime).find(Number.isFinite);
    return first === undefined ? inserts : inserts.filter((entry) => !(timeOf(entry.at) < first));
  });
  const rows = $derived(interleave(shown, itemTime, placed));

  $effect(() => {
    if (searchOpen) void openSearch();
  });

  async function openSearch(): Promise<void> {
    if (!searchOrigin && document.activeElement instanceof HTMLElement) searchOrigin = document.activeElement;
    await tick();
    if (disposed || !searchOpen) return;
    searchInput?.focus();
    if (!readHistory || searchBlocks.length || searchBusy) return;
    await refreshSearch();
  }

  async function refreshSearch(): Promise<void> {
    searchBusy = true;
    searchError = '';
    try {
      const history = readHistory ? await readHistory() : blocks;
      if (disposed) return;
      searchBlocks = history;
    } catch {
      if (disposed) return;
      searchBlocks = [];
      searchError = 'Could not load history. Try again.';
    } finally {
      searchBusy = false;
    }
  }

  function closeSearch(): void {
    searchOpen = false;
    query = '';
    match = 0;
    const origin = searchOrigin; searchOrigin = null;
    void tick().then(() => {
      if (disposed || searchOpen) return;
      if (origin?.isConnected) origin.focus();
      scrollToEnd();
    });
  }

  function scrollToEnd(): void {
    if (!scroller) return;
    following = true;
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Follow new content while the reader is at the bottom; remember the
  // position per chat so switching chats returns to the same place. Only a
  // reader's own gesture stops following: layout shifts from streaming text,
  // lazily rendered rows or images must never strand the view mid-chat.
  const NEAR_BOTTOM = 32;
  const viewReady = $derived(blocks.length > 0 || !loading);

  function follow(node: HTMLDivElement, params: { key: string; ready: boolean }) {
    let current = params.key;
    let pendingView: { top: number; following: boolean } | undefined;
    let gestureAt = 0;
    const distance = () => node.scrollHeight - node.clientHeight - node.scrollTop;
    const pin = () => {
      node.scrollTop = node.scrollHeight;
    };
    let saved = '';
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      if (!positionStore || pendingView || searchOpen) return;
      const value = { top: Math.round(node.scrollTop), following };
      const fingerprint = `${current}:${JSON.stringify(value)}`;
      if (saved === fingerprint) return;
      try {
        positionStore.write(current, value);
        saved = fingerprint;
      } catch {
        // Optional reading position only.
      }
    };
    // Scroll events arrive every frame while a reply streams. The position is
    // written once they settle, and at once on a chat switch or teardown.
    const persistSoon = () => {
      if (positionStore) persistTimer ??= setTimeout(persist, 200);
    };
    const load = () => {
      pendingView = { top: 0, following: true };
      try {
        const saved = positionStore?.read(current);
        if (saved && Number.isFinite(saved.top) && typeof saved.following === 'boolean') pendingView = saved;
      } catch {
        // Ignore damaged metadata.
      }
      following = pendingView?.following ?? true;
    };
    const apply = async (ready: boolean) => {
      if (!pendingView || !ready) return;
      const view = pendingView;
      await tick();
      following = view.following;
      if (following) pin();
      else node.scrollTop = view.top;
      // Rows render lazily; settle once more after their real sizes land.
      requestAnimationFrame(() => {
        if (following) pin();
        pendingView = undefined;
      });
    };
    const gesture = () => {
      gestureAt = performance.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) gesture();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) gesture();
    };
    const onScroll = () => {
      if (pendingView || searchOpen) return;
      if (distance() <= NEAR_BOTTOM) following = true;
      else if (performance.now() - gestureAt < 1_000) following = false;
      else if (following) pin();
      persistSoon();
    };
    const observer = new ResizeObserver(() => {
      if (!searchOpen && following) pin();
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchmove', gesture, { passive: true });
    node.addEventListener('pointerdown', gesture, { passive: true });
    node.addEventListener('keydown', onKey);
    load();
    void apply(params.ready);
    return {
      update(next: { key: string; ready: boolean }) {
        if (next.key !== current) {
          persist();
          current = next.key;
          load();
        }
        void apply(next.ready);
      },
      destroy() {
        persist();
        observer.disconnect();
        node.removeEventListener('scroll', onScroll);
        node.removeEventListener('wheel', onWheel);
        node.removeEventListener('touchmove', gesture);
        node.removeEventListener('pointerdown', gesture);
        node.removeEventListener('keydown', onKey);
      },
    };
  }

  function setOpen(id: string, open: boolean): void {
    openState = { ...openState, [id]: open };
  }

  async function loadFull(block: TimelineBlock): Promise<string> {
    if (fullAnswers[block.id]) return fullAnswers[block.id];
    if (!block.truncated || !readHistory) return block.text ?? '';
    const history = await readHistory();
    if (disposed) throw new DOMException('Conversation changed', 'AbortError');
    const answer = history.find((candidate) => candidate.id === block.id && candidate.kind === 'assistant' && !candidate.truncated);
    if (!answer?.text) throw new Error('Full answer unavailable');
    fullAnswers = { ...fullAnswers, [block.id]: answer.text };
    return answer.text;
  }

  async function answerAction(block: TimelineBlock, copy: boolean): Promise<void> {
    busyAnswers = { ...busyAnswers, [block.id]: true };
    try {
      const text = await loadFull(block);
      if (disposed) return;
      if (copy) {
        await navigator.clipboard.writeText(text);
        if (!disposed) presentation.notify('success', $t('Answer copied'));
      }
    } catch {
      if (disposed) return;
      presentation.notify('error', copy ? $t('Could not copy the answer') : $t('Could not load the full answer. Try again.'));
    } finally {
      busyAnswers = { ...busyAnswers, [block.id]: false };
    }
  }

  async function openAttachment(id: string): Promise<void> {
    try { await onOpenAttachment?.(id); }
    catch { if (!disposed) presentation.notify('error', $t('Could not open attachment.')); }
  }

  function time(value: string | undefined): string {
    return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }
</script>

{#snippet attachmentList(files: readonly ConversationAttachment[])}
  {#if files.length}
    <ul class="attachments" aria-label={$t('Attachments')}>
      {#each files as attachment (attachment.id)}
        <li>{#if onOpenAttachment}<Button size="sm" variant="ghost" onclick={() => void openAttachment(attachment.id)}>{attachment.label}</Button>{:else}<span>{attachment.label}</span>{/if}</li>
      {/each}
    </ul>
  {/if}
{/snippet}

<div class="transcript">
  {#if searchOpen}
    <div class="search" role="search">
      <Input
        bind:ref={searchInput}
        bind:value={query}
        size="sm"
        placeholder={$t('Search this chat')}
        aria-label={$t('Search this chat')}
        oninput={() => (match = 0)}
        onkeydown={(event) => {
          if (event.key === 'Enter' && matches.length) match = (currentMatch + (event.shiftKey ? matches.length - 1 : 1)) % matches.length;
          if (event.key === 'Escape') closeSearch();
        }}
      >
        {#snippet leading()}<Search />{/snippet}
      </Input>
      <span class="search__count" role="status">
        {#if searchBusy}<Spinner size={12} />{:else if query.trim()}{matches.length ? currentMatch + 1 : 0} / {matches.length}{/if}
      </span>
      <IconButton size="sm" label={$t('Previous match')} disabled={!matches.length} onclick={() => (match = (currentMatch - 1 + matches.length) % matches.length)}><ChevronUp /></IconButton>
      <IconButton size="sm" label={$t('Next match')} disabled={!matches.length} onclick={() => (match = (currentMatch + 1) % matches.length)}><ChevronDown /></IconButton>
      <IconButton size="sm" label={$t('Close search')} onclick={closeSearch}><X /></IconButton>
    </div>
    {#if searchError}<p class="search__error" role="alert">{$t(searchError)}</p>{/if}
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must support keyboard scrolling.) -->
  <div class="scroller" bind:this={scroller} use:follow={{ key: sessionKey, ready: viewReady }} tabindex="0" role="region" aria-label={$t('Conversation messages')}>
    <div class="column">
      {#if blocks.length === 0 && loading}
        <div class="loading"><Skeleton lines={4} /></div>
      {:else if blocks.length === 0 && placed.length === 0}
        <p class="empty">{emptyText ?? $t('No messages yet. Say hello to start.')}</p>
      {/if}

      {#if hidden > 0 && !searching}
        <div class="earlier">
          <Button size="sm" variant="ghost" onclick={() => (limit += PAGE)}>{$t('Show earlier messages ({0})', [hidden])}</Button>
        </div>
      {:else if olderAvailable && onLoadOlder && !searching}
        <div class="earlier">
          <Button size="sm" variant="ghost" loading={olderLoading} onclick={onLoadOlder}>{$t('Load earlier history')}</Button>
        </div>
      {/if}

      {#each rows as row (row.type === 'insert' ? `insert:${row.id}` : row.item.type === 'activity-group' ? row.item.id : row.item.block.id)}
        {#if row.type === 'insert'}
          <div class="item item--insert">{@render insert?.(row.id)}</div>
        {:else}
        {@const item = row.item}
        {#if item.type === 'activity-group'}
          <div class="item">
            <ActivityGroupView group={item} {language} {openState} onOpenChange={setOpen} />
            {#each item.blocks as block (block.id)}
              {@render attachmentList(attachmentsByBlock.get(block.id) ?? [])}
            {/each}
          </div>
        {:else}
          {@const block = item.block}
          <div class="item" data-timeline-block={block.id}>
            {@render attachmentList(attachmentsByBlock.get(block.id) ?? [])}
            {#if block.kind === 'user'}
              <!-- Bridges list a message's images as trailing `[image]` lines; bytes never reach the transcript. -->
              {@const rawText = block.text ?? block.safeSummary ?? ''}
              {@const split = nativeMarkers ? splitPipelineContext(rawText) : { text: rawText, contexts: [] }}
              {@const user = nativeMarkers ? splitImageMarkers(split.text) : { text: split.text, images: 0 }}
              {#each split.contexts as context, index (index)}
                <details class="handed">
                  <summary><Route size={12} /> {$t('Handed on the result of {0}', [context.pipelineName || $t('a pipeline')])}</summary>
                  <MarkdownContent source={context.body} compact={true} />
                </details>
              {/each}
              <div class="user">
                {#if user.text || !user.images}<MarkdownContent source={user.text} />{/if}
                {#if user.images}
                  <ul class="user__images" aria-label={$t('Attached images')}>
                    {#each Array.from({ length: user.images }, (_, index) => index) as index (index)}
                      <li><ImageIcon size={14} /> {$t('Image')}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {:else if block.kind === 'assistant'}
              <article class="assistant" class:assistant--end={turnEnds.has(block.id)} class:assistant--failed={block.status === 'failed'} class:assistant--stopped={block.status === 'interrupted'}>
                {#if block.text}
                  <MarkdownContent source={fullAnswers[block.id] ?? block.text} />
                {:else if block.safeSummary}
                  <p class="muted">{block.safeSummary}</p>
                {/if}
                {#if block.status === 'streaming'}<span class="caret" aria-hidden="true"></span>{/if}
                {#if block.status === 'failed' || block.status === 'interrupted' || (turnEnds.has(block.id) && block.status !== 'streaming' && block.text)}
                <div class="assistant__meta">
                  {#if block.status === 'failed'}<span class="warn">{$t('The turn failed')}</span>{/if}
                  {#if block.status === 'interrupted'}<span class="warn">{$t('Stopped')}</span>{/if}
                  {#if block.text}
                    <span class="assistant__actions">
                      <IconButton size="sm" label={$t('Copy answer')} onclick={() => void answerAction(block, true)} disabled={busyAnswers[block.id]}><Copy /></IconButton>
                      {#if block.truncated && !fullAnswers[block.id] && readHistory}
                        <Button size="sm" variant="ghost" onclick={() => void answerAction(block, false)} loading={busyAnswers[block.id]}>
                          {#snippet leading()}<Expand />{/snippet}
                          {$t('Show full answer')}
                        </Button>
                      {/if}
                      {#if block.createdAt}<time datetime={block.createdAt}>{time(block.createdAt)}</time>{/if}
                    </span>
                  {/if}
                </div>
                {/if}
              </article>
            {:else if block.kind === 'error'}
              <div class="notice notice--error" role="note">
                <TriangleAlert size={15} />
                <div><strong>{block.label || $t('Runtime notice')}</strong>{#if block.text || block.safeSummary}<p>{block.text ?? block.safeSummary}</p>{/if}</div>
              </div>
            {:else if block.kind === 'compaction'}
              <div class="divider"><span>{block.status === 'streaming' ? $t('Compacting context…') : $t('Context compacted')}</span></div>
            {:else}
              <!-- Generic fallback: unknown or extension content stays readable. -->
              <details class="fallback">
                <summary class="fallback__head">
                  <span class="fallback__label">{block.label || $t('Extension message')}</span>
                  {#if block.fallback}<span class="fallback__tag">· {$t('Compatibility view')}</span>{/if}
                  <span class="fallback__chevron"><ChevronRight size={12} /></span>
                </summary>
                {#if block.text}<MarkdownContent source={block.text} compact={true} />{:else}<p class="muted">{block.safeSummary ?? $t('This session event is not supported by a richer renderer yet.')}</p>{/if}
              </details>
            {/if}
          </div>
        {/if}
        {/if}
      {/each}
    </div>
  </div>

  {#if !following && !searchOpen}
    <button type="button" class="latest" onclick={scrollToEnd}><ArrowDown size={14} /> {$t('Latest')}</button>
  {/if}
</div>

<style>
  .attachments { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); padding: 0; margin: 0 0 var(--piui-space-2); list-style: none; }
  .transcript {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 4px;
    width: min(var(--piui-chat-column-width), 100%);
    margin: 0 auto;
    padding: var(--piui-space-2) var(--piui-chat-inline-padding);
  }
  .search :global(.input) {
    flex: 1;
  }
  .search__count {
    min-width: 48px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-align: center;
  }
  .search__error {
    margin: 0 auto;
    color: var(--piui-danger);
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
    outline: none;
  }
  .scroller:focus-visible { outline: 2px solid var(--piui-accent); outline-offset: -2px; }
  .column {
    width: min(var(--piui-chat-column-width), 100%);
    margin: 0 auto;
    padding: var(--piui-space-6) var(--piui-chat-inline-padding) var(--piui-space-8);
  }
  .item {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
  }
  .loading {
    padding: var(--piui-space-4) 0;
  }
  .empty {
    margin: var(--piui-space-8) 0;
    color: var(--piui-text-muted);
    text-align: center;
  }
  .earlier {
    display: flex;
    justify-content: center;
    margin-bottom: var(--piui-space-4);
  }
  .item--insert {
    content-visibility: visible;
  }
  .handed {
    width: fit-content;
    max-width: min(80%, var(--piui-chat-reading-width));
    margin: 0 0 6px auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .handed summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .handed[open] {
    padding: 8px 12px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
  }
  .user {
    width: fit-content;
    max-width: min(80%, var(--piui-chat-reading-width));
    margin: 0 0 var(--piui-space-6) auto;
    padding: 10px 14px;
    border-radius: 14px;
    background: var(--piui-user-surface);
  }
  .user :global(.markdown-content) {
    font-size: var(--piui-chat-user-font-size);
  }
  .user__images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .user__images li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--piui-user-border);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .assistant {
    position: relative;
    margin: 0 0 var(--piui-space-3);
  }
  .assistant--end {
    margin-bottom: var(--piui-space-6);
  }
  .assistant--failed,
  .assistant--stopped {
    padding-left: 12px;
    border-left: 2px solid var(--piui-danger-border);
  }
  .assistant--stopped {
    border-left-color: var(--piui-warning-border);
  }
  .caret {
    display: inline-block;
    width: 7px;
    height: 16px;
    margin-left: 2px;
    border-radius: 1px;
    background: var(--piui-accent);
    vertical-align: text-bottom;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .assistant__meta {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 28px;
    margin-top: 4px;
  }
  .assistant__actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .assistant:hover .assistant__actions,
  .assistant:focus-within .assistant__actions {
    opacity: 1;
  }
  .assistant__actions time {
    margin-left: 4px;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .warn {
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
  .notice {
    display: flex;
    gap: var(--piui-space-2);
    margin: 0 0 var(--piui-space-4);
    padding: 10px 12px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
  }
  .notice p {
    margin: 2px 0 0;
    white-space: pre-wrap;
  }
  .notice--error {
    border-color: var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .divider {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    margin: var(--piui-space-4) 0 var(--piui-space-6);
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--piui-border-subtle);
  }
  .fallback {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-text-muted);
  }
  .fallback__head {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: -6px;
    max-width: 100%;
    min-height: 28px;
    padding: 2px 6px;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    list-style: none;
    cursor: pointer;
    color: var(--piui-text-muted);
    font-size: var(--piui-chat-font-size);
  }
  .fallback__head::-webkit-details-marker { display: none; }
  .fallback__head:hover { background: var(--piui-hover); color: var(--piui-text); }
  .fallback__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fallback__tag {
    margin-left: -4px;
    color: var(--piui-text-faint);
    white-space: nowrap;
  }
  .fallback__chevron {
    display: inline-flex;
    flex: none;
    color: var(--piui-text-disabled);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .fallback[open] .fallback__chevron {
    transform: rotate(90deg);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .latest {
    position: absolute;
    bottom: var(--piui-space-3);
    left: 50%;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-2);
    font-size: var(--piui-text-sm);
    transform: translateX(-50%);
  }
  .latest:hover {
    background: var(--piui-surface-2);
  }
</style>
