<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import GitCompare from '@lucide/svelte/icons/git-compare';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import Plus from '@lucide/svelte/icons/plus';
  import Minus from '@lucide/svelte/icons/minus';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Trash from '@lucide/svelte/icons/trash-2';
  import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
  import Split from '@lucide/svelte/icons/split';
  import { t } from '../../features/locale/language';
  import type { SessionStatus } from '../../../../../contracts/workspace-v15';
  import { Badge, Button, EmptyState, IconButton, Skeleton, Spinner, toasts } from '../../lib/ui';
  import DiffView from '../chat/transcript/DiffView.svelte';
  import { parseDiff, type DiffLine } from '../chat/transcript/diff';
  import { useWorkspace } from '../shell/context';
  import CommentForm from './CommentForm.svelte';
  import RevertDialog from './RevertDialog.svelte';
  import { composerInserts } from './composerInserts.svelte';
  import {
    AREA_LABELS, CHANGE_LABELS, CHANGE_MARKS, commentReference, fileKey, formatSize, groupFiles, hunkLines, lineRef, splitDisplay, splitHunk,
    splitPath, type HunkTarget, type LineRef,
  } from './review';
  import { busyKey, ReviewStore } from './reviewStore.svelte';

  interface Props {
    sessionId: string;
    status: SessionStatus;
    onClose: () => void;
  }
  let { sessionId, status, onClose }: Props = $props();
  const store = useWorkspace();
  // The parent keys this panel per chat.
  const review = new ReviewStore(untrack(() => sessionId));

  const WIDTH_KEY = 'piui.shell.review.width';
  const MIN_WIDTH = 320;
  const MAX_WIDTH = 900;
  let panel = $state<HTMLElement | null>(null);
  let width = $state(readWidth());
  /** `shown` is the index of a hunk in the shown text (split parts count separately). */
  let revert = $state<{ shown: number | undefined } | undefined>();
  let comment = $state<{ hunk: number; line: LineRef | undefined } | undefined>();
  /** Hunks shown as their parts, for the diff with this fingerprint. */
  let split = $state.raw<{ fingerprint: string; hunks: ReadonlySet<number> }>({ fingerprint: '', hunks: new Set() });

  const groups = $derived(groupFiles(review.files));
  const diff = $derived(review.diff);
  const splitHunks = $derived(diff !== undefined && split.fingerprint === diff.fingerprint ? split.hunks : new Set<number>());
  const shown = $derived(diff?.content.kind === 'text' ? splitDisplay(diff.content.text, splitHunks) : undefined);
  const parsed = $derived(shown === undefined ? undefined : parseDiff(shown.text)[0]);
  const target = (index: number): HunkTarget => shown?.targets[index] ?? { hunk: index };
  /** Parts a whole shown hunk splits into (1 when it cannot be split). */
  const partCount = (index: number): number => {
    const current = shown?.targets[index];
    return diff?.content.kind === 'text' && current !== undefined && current.part === undefined ? splitHunk(diff.content.text, current.hunk).length : 1;
  };
  /** The label number of a shown hunk: `2` or `2.1` for part 1 of change 2. */
  const hunkName = (index: number): string => {
    const current = target(index);
    return current.part === undefined ? String(current.hunk + 1) : `${current.hunk + 1}.${current.part + 1}`;
  };
  const repository = $derived(review.status?.repository);
  const working = (value: SessionStatus) => value === 'starting' || value === 'running' || value === 'stopping';

  onMount(() => {
    void review.refresh();
  });

  // Refresh when a turn ends.
  let previous = untrack(() => status);
  $effect(() => {
    const current = status;
    if (working(previous) && !working(current)) void review.refresh();
    previous = current;
  });

  $effect(() => {
    if (panel) panel.style.width = `${width}px`;
  });

  function readWidth(): number {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 480;
    } catch {
      return 480;
    }
  }

  function setWidth(next: number): void {
    width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Optional UI preference.
    }
  }

  function resizeKey(event: KeyboardEvent): void {
    const steps: Record<string, number> = { ArrowLeft: 24, ArrowRight: -24 };
    if (event.key in steps) {
      event.preventDefault();
      setWidth(width + (steps[event.key] ?? 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setWidth(MAX_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setWidth(MIN_WIDTH);
    }
  }

  function resizeStart(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setWidth(startWidth + (startX - next.clientX));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  async function act(action: 'stage' | 'unstage', shownIndex: number | undefined = undefined): Promise<void> {
    const chosen = shownIndex === undefined ? undefined : target(shownIndex);
    await review.act(action, chosen?.hunk, chosen?.part);
  }

  function splitHunkAt(shownIndex: number): void {
    if (diff === undefined) return;
    const hunks = new Set(splitHunks);
    hunks.add(target(shownIndex).hunk);
    split = { fingerprint: diff.fingerprint, hunks };
  }

  const busyFor = (action: 'stage' | 'unstage' | 'revert', shownIndex: number | undefined) => {
    const chosen = shownIndex === undefined ? undefined : target(shownIndex);
    return review.busy === busyKey(action, chosen?.hunk, chosen?.part);
  };

  async function confirmRevert(): Promise<void> {
    const pending = revert;
    if (pending === undefined) return;
    const moved = diff?.area === 'untracked';
    const chosen = pending.shown === undefined ? undefined : target(pending.shown);
    if (await review.act('revert', chosen?.hunk, chosen?.part)) {
      revert = undefined;
      toasts.success(moved ? $t('Moved to the Trash') : $t('Changes reverted'));
    } else {
      revert = undefined;
    }
  }

  function openComment(hunk: number, line: DiffLine | undefined = undefined): void {
    comment = { hunk, line: line === undefined ? undefined : lineRef(line) };
  }

  function addComment(line: LineRef, note: string): void {
    if (!diff) return;
    composerInserts.insert(store, sessionId, commentReference(diff.path, line, note));
    comment = undefined;
    toasts.success($t('Added to your message'), $t('Send it when you are ready.'));
  }

  const readOnly = $derived(review.readOnly);
</script>

<aside class="review" aria-label={$t('Review changes')} bind:this={panel}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (A focusable separator is the ARIA window splitter: arrows and pointer resize the panel.) -->
  <div
    class="resize"
    role="separator"
    aria-orientation="vertical"
    aria-label={$t('Resize the review panel')}
    aria-valuenow={width}
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    tabindex="0"
    onkeydown={resizeKey}
    onpointerdown={resizeStart}
  ></div>
  <header class="head">
    <GitCompare size={15} />
    <h2>{$t('Review')}</h2>
    {#if repository?.state === 'ready'}
      <Badge title={repository.head ? $t('At commit {0}', [repository.head]) : undefined}>
        <GitBranch size={11} />{repository.branch ?? $t('detached')}
      </Badge>
      {#if repository.worktree}<Badge tone="info">{$t('Worktree')}</Badge>{/if}
    {/if}
    <span class="spacer"></span>
    <IconButton label={$t('Refresh changes')} size="sm" onclick={() => void review.refresh()} disabled={review.loading}>
      {#if review.loading}<Spinner size={12} />{:else}<RefreshCw />{/if}
    </IconButton>
    <IconButton label={$t('Close review')} size="sm" onclick={onClose}><X /></IconButton>
  </header>

  <div class="body">
    {#if review.loading && !review.status}
      <div class="pad"><Skeleton lines={5} /></div>
    {:else if review.error && !review.status}
      <EmptyState size="sm" title={$t('Could not read the changes')} description={$t(review.error)}>
        {#snippet actions()}<Button size="sm" onclick={() => void review.refresh()}>{$t('Try again')}</Button>{/snippet}
      </EmptyState>
    {:else if repository?.state === 'not-repository'}
      <EmptyState
        size="sm"
        icon={GitCompare}
        title={$t('No git repository here')}
        description={$t('The review shows changes for chats in a git project folder. This chat works in a folder without git.')}
      />
    {:else if review.status}
      {#if readOnly}<p class="note" role="status">{$t('Safe mode: the review is read-only.')}</p>{/if}
      {#if review.error}<p class="note note--warn" role="alert">{$t(review.error)}</p>{/if}
      {#if groups.length === 0}
        <EmptyState size="sm" icon={GitCompare} title={$t('No changes')} description={$t('The working folder matches the last commit.')} />
      {:else}
        <nav class="files" aria-label={$t('Changed files')}>
          {#each groups as group (group.area)}
            <section>
              <h3>{$t(AREA_LABELS[group.area])} <span class="count">{group.files.length}</span></h3>
              <ul>
                {#each group.files as file (fileKey(file))}
                  {@const parts = splitPath(file.path)}
                  {@const current = review.selected !== undefined && fileKey(review.selected) === fileKey(file)}
                  <li>
                    <button
                      type="button"
                      class="file"
                      class:file--current={current}
                      aria-current={current ? 'true' : undefined}
                      title={file.path}
                      onclick={() => review.select(file)}
                    >
                      {#if file.renamedFrom}
                        <span class="mark mark--renamed" title={$t('Renamed from {0}', [file.renamedFrom])} aria-hidden="true">R</span>
                      {:else}
                        <span class="mark mark--{file.change}" title={$t(CHANGE_LABELS[file.change])} aria-hidden="true">{CHANGE_MARKS[file.change]}</span>
                      {/if}
                      <span class="file__name">{parts.name}</span>
                      <span class="file__dir">{parts.directory.replace(/\/$/, '')}</span>
                      {#if file.renamedFrom}
                        <span class="visually-hidden">{$t('Renamed from {0}', [file.renamedFrom])}</span>
                      {:else}
                        <span class="visually-hidden">{$t(CHANGE_LABELS[file.change])}</span>
                      {/if}
                      {#if file.binary}
                        <span class="stats">{$t('binary')}</span>
                      {:else if file.added !== undefined || file.removed !== undefined}
                        <span class="stats"><span class="add">+{file.added ?? 0}</span> <span class="remove">−{file.removed ?? 0}</span></span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </nav>
        {#if review.status.truncated}<p class="note">{$t('Only the first 2000 changed files are listed.')}</p>{/if}
        {#if review.status.hidden > 0}<p class="note">{$t('{0} files have names PiUI cannot show.', [review.status.hidden])}</p>{/if}

        <section class="detail" aria-label={$t('Selected file')}>
          {#if review.diffLoading && !diff}
            <div class="pad"><Skeleton lines={4} /></div>
          {:else if review.diffError}
            <p class="note note--warn" role="alert">{$t(review.diffError)}</p>
          {:else if diff}
            {@const renamedFrom = review.files.find((file) => file.path === diff.path && file.area === diff.area)?.renamedFrom}
            <header class="detail__head">
              <span class="detail__path" title={diff.path}>{diff.path}</span>
              <Badge>{$t(AREA_LABELS[diff.area])}</Badge>
            </header>
            {#if renamedFrom}<p class="note">{$t('Renamed from {0}', [renamedFrom])}</p>{/if}
            <div class="detail__actions">
              {#if diff.actions.stage}
                <Button size="sm" disabled={readOnly || Boolean(review.busy)} loading={busyFor('stage', undefined)} onclick={() => void act('stage')}>
                  {#snippet leading()}<Plus />{/snippet}{$t('Stage file')}
                </Button>
              {/if}
              {#if diff.actions.unstage}
                <Button size="sm" disabled={readOnly || Boolean(review.busy)} loading={busyFor('unstage', undefined)} onclick={() => void act('unstage')}>
                  {#snippet leading()}<Minus />{/snippet}{$t('Unstage file')}
                </Button>
              {/if}
              {#if diff.actions.revert}
                <Button size="sm" variant="ghost" disabled={readOnly || Boolean(review.busy)} onclick={() => (revert = { shown: undefined })}>
                  {#snippet leading()}{#if diff.area === 'untracked'}<Trash />{:else}<Undo2 />{/if}{/snippet}
                  {diff.area === 'untracked' ? $t('Move to Trash…') : $t('Revert file…')}
                </Button>
              {/if}
            </div>
            {#if review.actionError}<p class="note note--warn" role="alert">{$t(review.actionError)}</p>{/if}
            {#if diff.content.kind === 'text' && shown}
              {@const canHunk = diff.content.hunkActions}
              <DiffView text={shown.text} collapseAfter={Number.MAX_SAFE_INTEGER}>
                {#snippet hunkActions(index)}
                  {@const name = hunkName(index)}
                  {#if canHunk && diff.actions.stage && diff.area === 'unstaged'}
                    <button type="button" class="hunk-btn" disabled={readOnly || Boolean(review.busy)} onclick={() => void act('stage', index)} aria-label={$t('Stage change {0}', [name])}>
                      {#if busyFor('stage', index)}<Spinner size={10} />{:else}<Plus size={12} />{/if}{$t('Stage')}
                    </button>
                  {/if}
                  {#if canHunk && diff.actions.unstage}
                    <button type="button" class="hunk-btn" disabled={readOnly || Boolean(review.busy)} onclick={() => void act('unstage', index)} aria-label={$t('Unstage change {0}', [name])}>
                      {#if busyFor('unstage', index)}<Spinner size={10} />{:else}<Minus size={12} />{/if}{$t('Unstage')}
                    </button>
                  {/if}
                  {#if canHunk && diff.actions.revert && diff.area === 'unstaged'}
                    <button type="button" class="hunk-btn" disabled={readOnly || Boolean(review.busy)} onclick={() => (revert = { shown: index })} aria-label={$t('Revert change {0}…', [name])}>
                      <Undo2 size={12} />{$t('Revert…')}
                    </button>
                  {/if}
                  {#if canHunk && partCount(index) > 1}
                    <button type="button" class="hunk-btn" onclick={() => splitHunkAt(index)} aria-label={$t('Split change {0} into {1} parts', [name, partCount(index)])}>
                      <Split size={12} />{$t('Split')}
                    </button>
                  {/if}
                  <button type="button" class="hunk-btn" onclick={() => openComment(index)} aria-label={$t('Comment on change {0}…', [name])}>
                    <MessageSquarePlus size={12} />{$t('Comment…')}
                  </button>
                {/snippet}
                {#snippet lineAction(line, index)}
                  <button
                    type="button"
                    class="line-btn"
                    tabindex="-1"
                    aria-label={$t('Comment on line {0}', [line.newNumber ?? line.oldNumber ?? ''])}
                    onclick={() => openComment(index, line)}
                  ><MessageSquarePlus size={11} /></button>
                {/snippet}
              </DiffView>
              {#if comment && parsed}
                {#key `${comment.hunk}:${comment.line?.number ?? ''}`}
                  <CommentForm
                    path={diff.path}
                    lines={hunkLines(parsed.lines, comment.hunk)}
                    initial={comment.line}
                    onAdd={addComment}
                    onCancel={() => (comment = undefined)}
                  />
                {/key}
              {/if}
            {:else if diff.content.kind === 'binary'}
              <p class="note">{$t('Binary file, {0}. PiUI shows no content for it.', [formatSize(diff.content.size) || '—'])}</p>
            {:else if diff.content.kind === 'too-large'}
              <p class="note">{$t('This change is too large to show here ({0}). Review it with git.', [formatSize(diff.content.size) || '—'])}</p>
            {:else if diff.content.kind === 'symlink'}
              <p class="note">{$t('A symbolic link. PiUI does not follow or move links.')}</p>
            {:else if diff.content.kind === 'submodule'}
              <p class="note">{$t('A submodule. Manage it with git directly.')}</p>
            {:else}
              <p class="note">{$t('This file has a merge conflict. Resolve it with your tools or ask the agent.')}</p>
            {/if}
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</aside>

{#if revert && diff}
  <RevertDialog
    {diff}
    text={shown?.text}
    hunk={revert.shown}
    busy={review.busy.startsWith('revert')}
    onConfirm={() => void confirmRevert()}
    onCancel={() => (revert = undefined)}
  />
{/if}

<style>
  .review {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 480px;
    min-width: 320px;
    max-width: min(900px, 70vw);
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  .resize {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    z-index: 2;
    width: 6px;
    cursor: col-resize;
  }
  .resize:hover,
  .resize:focus-visible {
    background: var(--piui-focus);
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-2) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .spacer {
    flex: 1;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--piui-space-3);
    min-height: 0;
    padding: var(--piui-space-3);
    overflow-x: hidden;
    overflow-y: auto;
  }
  .body > :global(*) {
    min-width: 0;
  }
  .pad {
    padding: var(--piui-space-3);
  }
  .note {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .note--warn {
    color: var(--piui-warning-text);
  }
  .files {
    display: grid;
    gap: var(--piui-space-2);
    flex: none;
    max-height: 40vh;
    overflow-y: auto;
  }
  h3 {
    margin: 0 0 2px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .count {
    color: var(--piui-text-faint);
  }
  ul {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    width: 100%;
    height: 26px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .file:hover {
    background: var(--piui-hover);
  }
  .file--current {
    background: var(--piui-selected);
  }
  .mark {
    width: 12px;
    flex: none;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  .mark--added,
  .mark--intent-to-add {
    color: var(--piui-success);
  }
  .mark--deleted {
    color: var(--piui-danger);
  }
  .mark--modified,
  .mark--type-changed {
    color: var(--piui-warning);
  }
  .mark--conflict {
    color: var(--piui-danger);
  }
  .mark--renamed {
    color: var(--piui-info);
  }
  .file__name {
    flex: none;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file__dir {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .stats {
    flex: none;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    color: var(--piui-text-muted);
  }
  .add {
    color: var(--piui-success);
  }
  .remove {
    color: var(--piui-danger);
  }
  .detail {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--piui-space-2);
    min-width: 0;
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .detail__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .detail__path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .hunk-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .hunk-btn:hover:not(:disabled) {
    color: var(--piui-text);
    background: var(--piui-hover);
  }
  .hunk-btn:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .line-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-accent);
    opacity: 0;
  }
  :global(.line:hover) .line-btn,
  .line-btn:focus-visible {
    opacity: 1;
  }
</style>
