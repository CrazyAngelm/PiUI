<script lang="ts">
  import { isServiceData } from './serviceJson';
  import { answerText, setAnswerSource } from './answerSource';
  import { stripServiceMarkup } from './serviceMarkup';
  import CompactionNote from './CompactionNote.svelte';
  import FullAnswerNotice from './FullAnswerNotice.svelte';
  import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import Route from '@lucide/svelte/icons/route';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import Copy from '@lucide/svelte/icons/copy';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Search from '@lucide/svelte/icons/search';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import X from '@lucide/svelte/icons/x';
  import ImageIcon from '@lucide/svelte/icons/image';
  import { useTranslation } from '../../features/locale/context';
  import { useConversationPresentation } from './context';
  import type { ConversationAttachment, ConversationMessageControls, ConversationMessageAction, ConversationMedia, ConversationMessagePresentation, ConversationOwner } from '../../../../../contracts/conversation-presentation-v1';
  import MessageControls from './MessageControls.svelte';
  import AttachmentCard from './AttachmentCard.svelte';
  const t = useTranslation();
  const presentation = useConversationPresentation();
  import { splitImageMarkers } from '../../app/chat/composer/mentions';
  import { summarizeInteractiveBlocks } from '../../app/interactive/summaries';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import { createTimelineGrouper, type TimelineViewItem } from '../../features/sessions/timelineView';
  import type { TimelineBlock } from '../../host-api/types';
  import { Button, IconButton, Input, Skeleton, Spinner } from '../../lib/ui';
  import ReasoningView from '../../app/chat/transcript/ReasoningView.svelte';
  import TurnProcessView from '../../app/chat/transcript/TurnProcessView.svelte';
  import { createReasoningClock } from '../../app/chat/transcript/reasoningClock';
  import { activityLive } from '../../app/chat/transcript/toolKinds';
  import { interleave, timeOf, type TimedInsert } from '../../app/chatPipelines/interleave';
  import { splitPipelineContext } from '../../app/chatPipelines/chatPipeline';

  /** Where the reader stopped: the block at the top of the view and how far into it, so a shorter or longer page still lands there. */
  interface ReadingView {
    top: number;
    following: boolean;
    anchor?: { id: string; offset: number };
  }

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
      read(key: string): ReadingView | undefined;
      write(key: string, value: ReadingView): void;
    };
    language?: 'en' | 'ru';
    /** Whether the conversation's agent is working. Omitted when the owner cannot tell: the last turn then stays open. */
    running?: boolean;
    attachments?: readonly ConversationAttachment[];
    onOpenAttachment?: (id: string) => Promise<void>;
    onDownloadAttachment?: (id: string) => Promise<void>;
    onRevealAttachment?: (id: string) => Promise<void>;
    resolveAttachment?: (id: string) => Promise<ConversationMedia>;
    messagePresentation?: readonly ConversationMessagePresentation[];
    decorateMessage?: ConversationOwner['decorateMessage'];
    richMarkdown?: boolean;
    decorateMessageHeader?: ConversationOwner['decorateMessageHeader'];
    printMode?: boolean;
    announceMessages?: boolean;
    messageControls?: readonly ConversationMessageControls[];
    onMessageAction?: (id: string, action: ConversationMessageAction) => Promise<void>;
    busyMessageActions?: Readonly<Record<string, boolean>>;
    messageActionErrors?: Readonly<Record<string, string>>;
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
    running = undefined,
    attachments = [],
    onOpenAttachment,
    onDownloadAttachment,
    onRevealAttachment,
    resolveAttachment,
    messagePresentation = [],
    decorateMessage,
    richMarkdown,
    decorateMessageHeader,
    printMode = false,
    announceMessages = false,
    messageControls,
    onMessageAction,
    busyMessageActions = {},
    messageActionErrors = {},
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
  const reasoningClock = createReasoningClock();
  const controlsByBlock = $derived(new Map(messageControls?.map(item => [item.blockId, item])));
  const appearanceByBlock = $derived(new Map(messagePresentation.map(item => [item.blockId, item])));
  const decorator = untrack(() => decorateMessage);
  const headerDecorator = untrack(() => decorateMessageHeader);
  function decorate(node: HTMLElement, block: TimelineBlock) {
    const controller = new AbortController();
    const mounted = decorator?.(node, block, controller.signal);
    return { update(next: TimelineBlock) { mounted?.update(next); }, destroy() { controller.abort(); mounted?.dispose(); } };
  }
  function decorateHeader(node: HTMLElement, block: TimelineBlock) {
    const controller = new AbortController();
    const mounted = headerDecorator?.(node, block, controller.signal);
    return { update(next: TimelineBlock) { mounted?.update(next); }, destroy() { controller.abort(); mounted?.dispose(); } };
  }
  const attachmentsByBlock = $derived.by(() => {
    const grouped = new Map<string, ConversationAttachment[]>();
    for (const attachment of attachments) {
      const list = grouped.get(attachment.blockId) ?? [];
      list.push(attachment);
      grouped.set(attachment.blockId, list);
    }
    return grouped;
  });
  // A reply that carries a file, or a person's name or note, stays in the chat: folding it would hide that.
  function keepVisible(block: TimelineBlock): boolean {
    const appearance = appearanceByBlock.get(block.id);
    return attachmentsByBlock.has(block.id) || !!appearance?.author || !!appearance?.note;
  }
  const items = $derived<TimelineViewItem[]>(printMode ? blocks.map(block => ({ type: 'block', block })) : groupBlocks(blocks, running ?? 'unknown', keepVisible));
  const hidden = $derived(printMode ? 0 : Math.max(0, items.length - limit));
  const visible = $derived(hidden > 0 ? items.slice(hidden) : items);
  // A window-only owner keeps publishing streaming/paged snapshots. Search those
  // current blocks; only an explicit full-history read has its own snapshot.
  const searchSource = $derived.by(() => {
    if (!readHistory) return blocks;
    const history = new Map(searchBlocks.map(block => [block.id, block]));
    for (const block of blocks) {
      // Keep saved full text when the native live projection is truncated, but
      // follow complete/live messages as the owner publishes their newer value.
      if (!block.truncated || !history.has(block.id)) history.set(block.id, block);
    }
    return [...history.values()];
  });
  const matches = $derived(
    query.trim()
      ? searchSource.filter((block) => `${summarizeInteractiveBlocks(block.text ?? '')} ${block.safeSummary ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      : [],
  );
  const currentMatch = $derived(Math.min(match, Math.max(0, matches.length - 1)));
  const searching = $derived(!printMode && searchOpen && query.trim().length > 0);
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
  // The chat's last answer keeps its actions in view; every other message shows them on hover or focus.
  const latestAnswer = $derived.by(() => {
    if (searching) return undefined;
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const item = visible[index]!;
      if (item.type === 'block') return item.block.kind === 'assistant' ? item.block.id : undefined;
    }
    return undefined;
  });
  // The agent works and has shown nothing yet for the last message: say so instead of leaving a gap.
  const awaiting = $derived.by(() => {
    if (running !== true || printMode || searching) return false;
    const last = visible[visible.length - 1];
    return last?.type === 'block' && last.block.kind === 'user' && last.block.status !== 'streaming';
  });
  // A process takes the time of the first thing it folds.
  const itemTime = (item: TimelineViewItem): number => {
    if (item.type === 'block') return timeOf(item.block.createdAt);
    const first = item.parts[0];
    return timeOf(first === undefined ? undefined : first.type === 'block' ? first.block.createdAt : first.blocks[0]?.createdAt);
  };
  // Runs before the first shown message wait until earlier messages are shown.
  const placed = $derived.by(() => {
    if (searching || !insert) return [];
    if (hidden === 0) return inserts;
    const first = visible.map(itemTime).find(Number.isFinite);
    return first === undefined ? inserts : inserts.filter((entry) => !(timeOf(entry.at) < first));
  });
  const rows = $derived(interleave(shown, itemTime, placed));

  $effect(() => {
    if (!printMode && searchOpen) void openSearch();
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

  export async function scrollToEnd(force: boolean = true, smooth: boolean = false): Promise<boolean> {
    if (disposed || printMode || !scroller || (!force && (!following || searchOpen))) return false;
    if (force && searchOpen) {
      searchOpen = false;
      query = '';
      match = 0;
      searchOrigin = null;
    }
    // Jumping to the latest message is an explicit choice: a selection no longer holds the view back.
    if (force) selectionHold = false;
    following = true;
    await tick();
    if (disposed || !scroller) return false;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    return true;
  }

  // Follow new content while the reader is at the bottom; remember the
  // position per chat so switching chats returns to the same place. Only a
  // reader's own gesture stops following: layout shifts from streaming text,
  // lazily rendered rows or images must never strand the view mid-chat.
  // A text selection in the transcript also holds the view: a growing reply
  // must not scroll away the words being selected. Following resumes when the
  // reader scrolls back to the bottom or jumps to the latest message.
  const NEAR_BOTTOM = 32;
  const viewReady = $derived(blocks.length > 0 || !loading);
  let selectionHold = false;
  const rowKey = (item: TimelineViewItem): string => (item.type === 'block' ? item.block.id : item.id);

  function follow(node: HTMLDivElement, params: { key: string; ready: boolean }) {
    if (printMode) return;
    let current = params.key;
    let pendingView: ReadingView | undefined;
    let gestureAt = 0;
    let pointerDown = false;
    const distance = () => node.scrollHeight - node.clientHeight - node.scrollTop;
    const pin = () => {
      if (!selectionHold) node.scrollTop = node.scrollHeight;
    };
    const selectionInside = () => {
      const selection = document.getSelection();
      return !!selection && !selection.isCollapsed && selection.rangeCount > 0 && node.contains(selection.getRangeAt(0).commonAncestorContainer);
    };
    const contentTop = (row: HTMLElement) => row.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    // The row at the top of the view and how far into it the view starts.
    const anchorOf = (): ReadingView['anchor'] => {
      for (const row of node.querySelectorAll<HTMLElement>('[data-row-id]')) {
        const top = contentTop(row);
        if (top + row.getBoundingClientRect().height > node.scrollTop + 1) return { id: row.dataset.rowId ?? '', offset: Math.max(0, Math.round(node.scrollTop - top)) };
      }
      return undefined;
    };
    const restore = (view: ReadingView) => {
      const row = view.anchor ? Array.from(node.querySelectorAll<HTMLElement>('[data-row-id]')).find((candidate) => candidate.dataset.rowId === view.anchor!.id) : undefined;
      node.scrollTop = row && view.anchor ? contentTop(row) + view.anchor.offset : view.top;
    };
    let saved = '';
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      if (!positionStore || pendingView || searchOpen) return;
      const anchor = following ? undefined : anchorOf();
      const value: ReadingView = { top: Math.round(node.scrollTop), following, ...(anchor ? { anchor } : {}) };
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
        if (saved && Number.isFinite(saved.top) && typeof saved.following === 'boolean') {
          const anchor = saved.anchor;
          pendingView = { top: saved.top, following: saved.following, ...(anchor && typeof anchor.id === 'string' && Number.isFinite(anchor.offset) ? { anchor } : {}) };
        }
      } catch {
        // Ignore damaged metadata.
      }
      following = pendingView?.following ?? true;
      selectionHold = false;
    };
    const apply = async (ready: boolean) => {
      if (!pendingView || !ready) return;
      const view = pendingView;
      // The place may be in an earlier part of the chat that is not shown yet: show the page that holds it.
      const anchored = view.anchor?.id;
      if (!view.following && anchored !== undefined) {
        const index = items.findIndex((item) => rowKey(item) === anchored);
        if (index >= 0) limit = Math.max(limit, items.length - index);
      }
      await tick();
      following = view.following;
      if (following) pin();
      else restore(view);
      // Rows render lazily; settle once more after their real sizes land.
      requestAnimationFrame(() => {
        if (following) pin();
        else restore(view);
        pendingView = undefined;
      });
    };
    const gesture = () => {
      gestureAt = performance.now();
    };
    const onPointerDown = () => {
      gesture();
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onSelection = () => {
      if (selectionInside()) selectionHold = true;
      else if (selectionHold) {
        selectionHold = false;
        if (distance() <= NEAR_BOTTOM) following = true;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) gesture();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) gesture();
    };
    // Focus that lands on a control scrolls it into view: the reader went there with the keyboard.
    const onFocus = (event: FocusEvent) => {
      if (event.target !== node) gesture();
    };
    const onScroll = () => {
      if (pendingView || searchOpen) return;
      if (distance() <= NEAR_BOTTOM) {
        following = true;
        // Back at the bottom by the reader's own scrolling: follow again, selection or not.
        // A drag that selects text and scrolls the view by itself does not count.
        if (!pointerDown) selectionHold = false;
      } else if (performance.now() - gestureAt < 1_000) following = false;
      else if (following) pin();
      persistSoon();
    };
    const observer = new ResizeObserver(() => {
      if (searchOpen || !following) return;
      // New content under a selection: stay where the reader is and offer "Latest".
      if (selectionHold) following = false;
      else pin();
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchmove', gesture, { passive: true });
    node.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('selectionchange', onSelection);
    node.addEventListener('keydown', onKey);
    node.addEventListener('focusin', onFocus);
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
        node.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);
        document.removeEventListener('selectionchange', onSelection);
        node.removeEventListener('keydown', onKey);
        node.removeEventListener('focusin', onFocus);
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
        await navigator.clipboard.writeText(summarizeInteractiveBlocks(stripServiceMarkup(text)));
        if (!disposed) presentation.notify('success', $t('Answer copied'));
      }
    } catch {
      if (disposed) return;
      presentation.notify('error', copy ? $t('Could not copy the answer') : $t('Could not load the full answer. Try again.'));
    } finally {
      busyAnswers = { ...busyAnswers, [block.id]: false };
    }
  }

  // A reply folded into a turn's process shows the same shortened-answer notice and button.
  setAnswerSource({
    full: (id) => fullAnswers[id],
    busy: (id) => busyAnswers[id] === true,
    canLoad: () => !!readHistory,
    load: (block) => answerAction(block, false),
  });

  function time(value: string | undefined): string {
    return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }
</script>

{#snippet attachmentList(files: readonly ConversationAttachment[])}
  {#if files.length}
    <ul class="attachments" aria-label={$t('Attachments')}>
      {#each files as attachment (attachment.id)}
        <li><AttachmentCard {attachment} {printMode} open={onOpenAttachment} download={onDownloadAttachment} reveal={onRevealAttachment} resolve={resolveAttachment} /></li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet messageFooter(block: TimelineBlock)}
  {@const controls = controlsByBlock.get(block.id)}
  {#if controls && !printMode}
    <div class="message-footer" class:message-footer--user={block.kind === 'user'} class:message-footer--latest={block.id === latestAnswer}>
      {#key controls.id}
      <MessageControls {controls} createdAt={block.createdAt} available={!!onMessageAction}
        busyActions={busyMessageActions} error={messageActionErrors[JSON.stringify(controls.id)] ?? ''} onAction={onMessageAction} />
      {/key}
    </div>
  {/if}
{/snippet}

<div class="transcript" class:transcript--print={printMode}>
  {#if searchOpen && !printMode}
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
      {#if readHistory}<Button size="sm" variant="ghost" disabled={searchBusy} onclick={() => void refreshSearch()}>{$t('Refresh search')}</Button>{/if}
      <IconButton size="sm" label={$t('Close search')} onclick={closeSearch}><X /></IconButton>
    </div>
    {#if searchError}<p class="search__error" role="alert">{$t(searchError)}</p>{/if}
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must support keyboard scrolling.) -->
  <div class="scroller" bind:this={scroller} use:follow={{ key: sessionKey, ready: viewReady }} tabindex={printMode ? undefined : 0} role={announceMessages && !printMode ? 'log' : 'region'} aria-live={announceMessages && !printMode ? 'polite' : undefined} aria-relevant={announceMessages && !printMode ? 'additions' : undefined} aria-label={$t('Conversation messages')}>
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
      {:else if olderAvailable && onLoadOlder && !searching && !printMode}
        <div class="earlier">
          <Button size="sm" variant="ghost" loading={olderLoading} onclick={onLoadOlder}>{$t('Load earlier history')}</Button>
        </div>
      {/if}

      {#each rows as row (row.type === 'insert' ? `insert:${row.id}` : row.item.type === 'block' ? row.item.block.id : row.item.id)}
        {#if row.type === 'insert'}
          <div class="item item--insert" data-row-id={`insert:${row.id}`}>{@render insert?.(row.id)}</div>
        {:else}
        {@const item = row.item}
        {#if item.type === 'turn-process'}
          <div class="item item--turn" data-row-id={item.id}>
            <TurnProcessView {item} {language} open={openState[item.id] ?? item.attention === true} onToggle={(open) => setOpen(item.id, open)} {openState} onOpenChange={setOpen} />
          </div>
        {:else}
          {@const block = item.block}
          {@const appearance = appearanceByBlock.get(block.id)}
          <div class="item" class:item--controls={controlsByBlock.has(block.id)} data-timeline-block={block.id} data-row-id={block.id}>
            {#if headerDecorator}<div class="message-header-host" use:decorateHeader={block}></div>{/if}
            {#if appearance?.author}<div class="message-author">{appearance.author}</div>{/if}
            {#if appearance?.note}<p class="message-note">{appearance.note}</p>{/if}
            {#if block.kind === 'user'}
              <!-- Bridges list a message's images as trailing `[image]` lines; bytes never reach the transcript. -->
              {@const rawText = block.text ?? block.safeSummary ?? ''}
              {@const split = nativeMarkers ? splitPipelineContext(rawText) : { text: rawText, contexts: [] }}
              {@const user = nativeMarkers ? splitImageMarkers(split.text) : { text: split.text, images: 0 }}
              {#each split.contexts as context, index (index)}
                <details class="handed" open={printMode || undefined}>
                  <summary><Route size={12} /> {$t('Handed on the result of {0}', [context.pipelineName || $t('a pipeline')])}</summary>
                  <MarkdownContent source={context.body} compact={true} {printMode} />
                </details>
              {/each}
              <div class="user" class:user--pending={block.status === 'streaming'}>
                {#if user.text || !user.images}
                  <div class="message-markdown" use:decorate={block}>
                    {#if appearance?.literal}<p class="literal">{user.text}</p>{:else}<MarkdownContent source={user.text} rich={richMarkdown ?? !!decorator} widgets={!!decorator} {printMode} />{/if}
                  </div>
                {/if}
                {#if user.images}
                  <ul class="user__images" aria-label={$t('Attached images')}>
                    {#each Array.from({ length: user.images }, (_, index) => index) as index (index)}
                      <li><ImageIcon size={14} /> {$t('Image')}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <!-- Sent into a running turn; the agent's runtime has not reported it yet. -->
              {#if block.status === 'streaming'}<p class="user-pending">{$t('The agent reads this at its next step')}</p>{/if}
            {:else if block.kind === 'assistant'}
              <article class="assistant" class:assistant--end={turnEnds.has(block.id)} class:assistant--failed={block.status === 'failed'} class:assistant--stopped={block.status === 'interrupted'}>
                {#if block.text && !printMode && isServiceData(block)}
                  <details class="service-data">
                    <summary>{$t('Service data')}</summary>
                    <pre>{block.text}</pre>
                  </details>
                {:else if block.text}
                  {@const shown = answerText(block, fullAnswers[block.id])}
                  {#if shown !== ''}
                    <div class="message-markdown" use:decorate={block}>
                      {#if appearance?.literal}<p class="literal">{shown}</p>{:else}<MarkdownContent source={shown} streaming={block.status === 'streaming'} rich={richMarkdown ?? !!decorator} widgets={!!decorator} {printMode} />{/if}
                    </div>
                  {/if}
                {:else if block.safeSummary}
                  <p class="muted">{block.safeSummary}</p>
                {/if}
                {#if block.status === 'streaming' && !printMode}<span class="caret" aria-hidden="true"></span>{/if}
                <FullAnswerNotice {block} {printMode} />
                {#if block.status === 'failed' || block.status === 'interrupted' || (turnEnds.has(block.id) && block.status !== 'streaming' && block.text && messageControls === undefined)}
                <div class="assistant__meta">
                  {#if block.status === 'failed'}<span class="warn">{$t('The turn failed')}</span>{/if}
                  {#if block.status === 'interrupted'}<span class="warn">{$t('Stopped')}</span>{/if}
                  {#if block.text && !printMode}
                    <span class="assistant__actions">
                      {#if messageControls === undefined}<IconButton size="sm" label={$t('Copy answer')} onclick={() => void answerAction(block, true)} disabled={busyAnswers[block.id]}><Copy /></IconButton>{/if}
                      {#if block.createdAt && messageControls === undefined}<time datetime={block.createdAt}>{time(block.createdAt)}</time>{/if}
                    </span>
                  {/if}
                </div>
                {/if}
              </article>
            {:else if block.kind === 'thinking' && !printMode}
              <ReasoningView {block} open={openState[block.id] ?? (block.status === 'streaming' || searching)} onToggle={(open) => setOpen(block.id, open)} clock={reasoningClock} />
            {:else if block.kind === 'error'}
              <div class="notice notice--error" role="note">
                <TriangleAlert size={15} />
                <div><strong>{block.label || $t('Runtime notice')}</strong>{#if block.text || block.safeSummary}<p>{block.text ?? block.safeSummary}</p>{/if}</div>
              </div>
            {:else if block.kind === 'compaction'}
              <CompactionNote {block} />
            {:else}
              <!-- Generic fallback: unknown or extension content stays readable. -->
              <details class="fallback" open={printMode || undefined}>
                <summary class="fallback__head">
                  <span class="fallback__label">{block.label || (printMode ? block.toolName : '') || $t('Extension message')}</span>
                  {#if block.fallback}<span class="fallback__tag">· {$t('Compatibility view')}</span>{/if}
                  <span class="fallback__chevron"><ChevronRight size={12} /></span>
                </summary>
                {#if block.text}<MarkdownContent source={block.text} compact={true} {printMode} />{:else}<p class="muted">{block.safeSummary ?? $t('This session event is not supported by a richer renderer yet.')}</p>{/if}
              </details>
            {/if}
            {@render attachmentList(attachmentsByBlock.get(block.id) ?? [])}
            {@render messageFooter(block)}
            {#if printMode && block.createdAt}<time datetime={block.createdAt}>{time(block.createdAt)}</time>{/if}
          </div>
        {/if}
        {/if}
      {/each}

      {#if awaiting}
        <div class="item item--awaiting" role="status">
          <Spinner size={12} />
          <span>{activityLive([], language).label}</span>
        </div>
      {/if}
    </div>
  </div>

  {#if !following && !searchOpen && !printMode}
    <button type="button" class="latest" onclick={() => void scrollToEnd()}><ArrowDown size={14} /> {$t('Latest')}</button>
  {/if}
</div>

<style>
  .service-data {
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .service-data summary {
    cursor: pointer;
  }
  .service-data pre {
    max-height: 200px;
    margin: 4px 0 0;
    overflow: auto;
    font-family: var(--piui-font-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message-header-host:global([data-active='true']) + .message-author { display: none; }
  .transcript--print, .transcript--print .scroller { display: block; height: auto; overflow: visible; }
  .transcript--print .item { content-visibility: visible; contain-intrinsic-size: none; }
  .transcript--print .column { width: 100%; padding: 0; }
  .transcript--print time { display: block; color: var(--piui-text-muted); font-size: var(--piui-text-xs); margin-bottom: var(--piui-space-3); }
  .literal { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  .message-author { color: var(--piui-text-muted); font-size: var(--piui-text-sm); font-weight: 600; margin-bottom: var(--piui-space-2); }
  .message-note { color: var(--piui-text-muted); font-size: var(--piui-text-xs); }
  .message-footer { margin-bottom: var(--piui-space-2); }
  .message-footer--user { display: flex; flex-direction: column; align-items: flex-end; }
  /* The time and actions of a message stay out of the way until the reader reaches for it; the last answer keeps them in view. */
  .message-footer :global(.message-controls) { opacity: 0; transition: opacity var(--piui-duration-fast) var(--piui-ease-out); }
  .item:hover .message-footer :global(.message-controls),
  .item:focus-within .message-footer :global(.message-controls),
  .message-footer--latest :global(.message-controls) { opacity: 1; }
  @media (hover: none) { .message-footer :global(.message-controls) { opacity: 1; } }
  .item--controls > .user, .item--controls > .assistant { margin-bottom: 2px; }
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
  .item--turn {
    contain-intrinsic-size: auto 32px;
  }
  .item--awaiting {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-md);
  }
  .item--awaiting :global(.spinner) {
    color: var(--piui-accent);
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
    padding: 10px 16px;
    border-radius: 18px;
    background: var(--piui-user-surface);
  }
  .user--pending {
    margin-bottom: var(--piui-space-1);
    opacity: 0.6;
  }
  .user-pending {
    margin: 0 0 var(--piui-space-6);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-align: right;
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
