<script lang="ts">
  import CircleStop from '@lucide/svelte/icons/circle-stop';
  import Bot from '@lucide/svelte/icons/bot';
  import Check from '@lucide/svelte/icons/check';
  import ListTodo from '@lucide/svelte/icons/list-todo';
  import Square from '@lucide/svelte/icons/square';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import X from '@lucide/svelte/icons/x';
  import { language, t } from '../../../features/locale/language';
  import { stopSessionTask } from '../../../host-api/sessionTasks';
  import { WorkspaceOperationError, type SessionSnapshot } from '../../../host-api/workspaceClient';
  import { IconButton, Spinner, toasts } from '../../../lib/ui';
  import { elapsedLabel, sessionActivity, usageLine, type ActivityItem } from './sessionActivity';

  /** Chat details: what this session is running now, its subagents and shell commands, also in the background (ADR-072). */
  interface Props {
    snapshot: SessionSnapshot;
    /** This computer's window may stop a task; a remote viewer, safe mode, a run member and a Fusion sidekick may not. */
    canStop: boolean;
  }
  let { snapshot, canStop }: Props = $props();
  const uid = $props.id();

  const view = $derived(sessionActivity(snapshot));
  const empty = $derived(view.agents.length + view.commands.length + view.other.length === 0);
  // The primitives keep the clock from restarting on every streamed event.
  const ticking = $derived(view.running > 0);

  let now = $state(Date.now());
  $effect(() => {
    if (!ticking) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  /** A stop request keeps its button busy until the harness reports the task stopped, or for this long. */
  const STOP_GRACE_MS = 10_000;
  let stopRequests = $state<Readonly<Record<string, number>>>({});
  let root = $state<HTMLElement | null>(null);
  /** The row whose stop button was used: when the button leaves with the running state, focus stays on that row. */
  let stoppedRow = $state<string | undefined>(undefined);

  function stoppingNow(taskId: string | undefined): boolean {
    if (taskId === undefined) return false;
    const requested = stopRequests[taskId];
    return requested !== undefined && now - requested < STOP_GRACE_MS;
  }

  function elapsed(item: ActivityItem): string | undefined {
    if (item.startedAt === undefined) return undefined;
    const end = item.status === 'running' ? now : item.endedAt;
    return end === undefined ? undefined : elapsedLabel(end - item.startedAt);
  }

  async function stop(item: ActivityItem): Promise<void> {
    const taskId = item.taskId;
    if (taskId === undefined || stoppingNow(taskId)) return;
    const sessionId = snapshot.session.id;
    stopRequests = { ...stopRequests, [taskId]: Date.now() };
    stoppedRow = item.id;
    try {
      await stopSessionTask({ sessionId, taskId });
    } catch (error) {
      stopRequests = Object.fromEntries(Object.entries(stopRequests).filter(([id]) => id !== taskId));
      stoppedRow = undefined;
      // It ended on its own a moment earlier: the list already says so.
      if (error instanceof WorkspaceOperationError && error.code === 'NOT_FOUND') return;
      toasts.error($t('The task could not be stopped.'));
    }
  }

  $effect(() => {
    const id = stoppedRow;
    if (id === undefined) return;
    const item = [...view.agents, ...view.commands, ...view.other].find((candidate) => candidate.id === id);
    if (item?.taskId !== undefined) {
      if (!stoppingNow(item.taskId)) stoppedRow = undefined;
      return;
    }
    stoppedRow = undefined;
    if (root === null || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const row = [...root.querySelectorAll<HTMLElement>('li[data-row]')].find((candidate) => candidate.dataset.row === id);
    (row ?? root).focus();
  });
</script>

{#snippet rows(items: ActivityItem[])}
  <ul>
    {#each items as item (item.id)}
      {@const time = elapsed(item)}
      {@const meta = usageLine(item, $language)}
      {@const busy = stoppingNow(item.taskId)}
      <li class:done={item.status !== 'running'} data-row={item.id} tabindex="-1">
        <div class="row">
          <span class="state">
            {#if item.status === 'running'}
              <span class="glyph glyph--running" role="img" aria-label={$t('Running')}><Spinner size={12} /></span>
            {:else if item.status === 'completed'}
              <span class="glyph glyph--completed" role="img" aria-label={$t('Completed')}><Check size={13} aria-hidden="true" /></span>
            {:else if item.status === 'failed'}
              <span class="glyph glyph--failed" role="img" aria-label={$t('Failed')}><X size={13} aria-hidden="true" /></span>
            {:else}
              <span class="glyph glyph--stopped" role="img" aria-label={$t('Stopped')}><Square size={10} fill="currentColor" aria-hidden="true" /></span>
            {/if}
          </span>
          <span class="title" class:title--command={item.kind === 'command'} title={item.title}>{item.title}</span>
          {#if time !== undefined}<span class="time">{time}</span>{/if}
          {#if canStop && item.taskId !== undefined}
            <IconButton label={$t('Stop {0}', [item.title])} size="sm" aria-disabled={busy || undefined} onclick={() => void stop(item)}>
              {#if busy}<Spinner size={12} />{:else}<CircleStop />{/if}
            </IconButton>
          {/if}
        </div>
        {#if meta}<p class="meta">{meta}</p>{/if}
        {#if item.activity}<p class="now">{item.activity}</p>{/if}
      </li>
    {/each}
  </ul>
{/snippet}

<section class="activity" aria-label={$t('Activity')} bind:this={root} tabindex="-1">
  {#if empty}
    <p class="empty">{$t('Nothing is running')}</p>
  {:else}
    {#if view.agents.length > 0}
      <div class="group" role="group" aria-labelledby="{uid}-agents">
        <h3 id="{uid}-agents"><Bot size={13} aria-hidden="true" /> {$t('Agents')}</h3>
        {@render rows(view.agents)}
      </div>
    {/if}
    {#if view.commands.length > 0}
      <div class="group" role="group" aria-labelledby="{uid}-commands">
        <h3 id="{uid}-commands"><SquareTerminal size={13} aria-hidden="true" /> {$t('Commands')}</h3>
        {@render rows(view.commands)}
      </div>
    {/if}
    {#if view.other.length > 0}
      <div class="group" role="group" aria-labelledby="{uid}-other">
        <h3 id="{uid}-other"><ListTodo size={13} aria-hidden="true" /> {$t('Other')}</h3>
        {@render rows(view.other)}
      </div>
    {/if}
  {/if}
</section>

<style>
  li:focus-visible,
  .activity:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
    border-radius: var(--piui-radius-sm);
  }
  .activity {
    --state-size: 16px;
    display: grid;
    gap: var(--piui-space-4);
  }
  .group {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  ul {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: var(--piui-control-sm);
  }
  .state {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--state-size);
    color: var(--piui-accent);
  }
  .glyph {
    display: inline-flex;
  }
  .glyph--running {
    color: var(--piui-accent);
  }
  .glyph--completed {
    color: var(--piui-success);
  }
  .glyph--failed {
    color: var(--piui-danger);
  }
  .glyph--stopped {
    color: var(--piui-text-muted);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title--command {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
  .done .title {
    color: var(--piui-text-muted);
  }
  .time {
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-variant-numeric: tabular-nums;
  }
  .meta,
  .now {
    margin: 0;
    padding-left: calc(var(--state-size) + var(--piui-space-2));
    color: var(--piui-text-muted);
  }
  .meta {
    overflow: hidden;
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .now {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: var(--piui-text-sm);
    overflow-wrap: anywhere;
  }
  .empty {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
