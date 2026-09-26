<script lang="ts">
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import Square from '@lucide/svelte/icons/square';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import History from '@lucide/svelte/icons/history';
  import { onMount, untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { OrchestrationClient, OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { Badge, Button, Dialog, EmptyState, IconButton, Popover, Segmented, Skeleton, Spinner, StatusDot } from '../../lib/ui';
  import FileInput from '@lucide/svelte/icons/file-input';
  import RunInputsView from './RunInputsView.svelte';
  import { useWorkspace } from '../shell/context';
  import { toolKind, type ToolKind } from '../chat/transcript/toolKinds';
  import RunCanvas from './RunCanvas.svelte';
  import RunTriggerLabel from './RunTriggerLabel.svelte';
  import TaskPanel from './TaskPanel.svelte';
  import { RUN_LABEL, RUN_TONE, matchesRunFilter, runCounts, shortId, sortRuns, stepViews, type RunFilter } from './runPresentation';
  import { RunsStore } from './runsStore.svelte';

  interface Props {
    workspaceId: string;
    safeMode: boolean;
    client: OrchestrationClient;
    runId?: string;
    initialRun?: OrchestrationRunV6;
    onOpenRun: (runId: string) => void;
    /** Opens the editor, on the run's saved pipeline when it has one. */
    onEdit: (launchCommandId: string | undefined) => void;
  }
  let { workspaceId, safeMode, client, runId, initialRun, onOpenRun, onEdit }: Props = $props();
  const store = useWorkspace();
  // The parent keys this view per project, so the store binds its first props.
  const runs = untrack(() => new RunsStore(workspaceId, safeMode, client));

  let filter = $state<RunFilter>('all');
  let confirmCancel = $state(false);
  const requested = new Set<string>();

  onMount(() => runs.start(runId, initialRun));

  // The route owns which run is open; follow it when it changes.
  $effect(() => {
    if (runId && runId !== runs.selectedRunId) void runs.open(runId);
  });

  const run = $derived(runs.run);
  const views = $derived(run ? stepViews(run) : []);
  const counts = $derived(runCounts(views));
  const selected = $derived(views.find((view) => view.stepId === runs.selectedStepId));
  const visibleRuns = $derived(sortRuns(runs.summaries.filter((item) => matchesRunFilter(item, filter))));
  const statusDot = { running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'idle', uncertain: 'waiting' } as const;

  // Keep native sessions of working or inspected steps live in the shared store.
  $effect(() => {
    if (!run) return;
    const ids = new Set<string>();
    for (const view of views) if (view.sessionId && (view.state === 'running' || view.state === 'awaitingApproval')) ids.add(view.sessionId);
    if (selected) {
      if (selected.sessionId) ids.add(selected.sessionId);
      for (const attempt of selected.attempts) if (attempt.execution?.id) ids.add(attempt.execution.id);
      for (const dependency of selected.step.dependencyStepIds) {
        const task = run.tasks.find((item) => item.stepId === dependency);
        if (task?.execution?.id) ids.add(task.execution.id);
      }
    }
    for (const id of ids) ensureSnapshot(id);
  });

  const ACTIVITY: Record<ToolKind, string> = {
    thinking: 'Thinking…',
    command: 'Running a command…',
    edit: 'Editing files…',
    read: 'Reading files…',
    search: 'Searching…',
    web: 'Browsing the web…',
    agent: 'Delegating…',
    tool: 'Using a tool…',
  };

  function ensureSnapshot(sessionId: string): void {
    if (store.snapshots[sessionId] || requested.has(sessionId)) return;
    requested.add(sessionId);
    void store.reconcileSession(sessionId);
  }

  function snapshotFor(sessionId: string) {
    ensureSnapshot(sessionId);
    return store.snapshots[sessionId];
  }

  function activity(sessionId: string | undefined): string {
    if (!sessionId) return '';
    const snapshot = store.snapshots[sessionId];
    if (!snapshot) return '';
    if (snapshot.approvals.length) return $t('Waiting for your approval');
    const live = [...snapshot.blocks].reverse().find((block) => block.status === 'streaming');
    if (!live) return '';
    if (live.kind === 'tool' || live.kind === 'thinking') return $t(ACTIVITY[toolKind(live)]);
    return $t('Writing…');
  }

  function openSession(sessionId: string): void {
    void store.openSession(sessionId);
  }
</script>

<div class="runs" class:runs--panel={!!selected}>
  <nav class="list" aria-label={$t('Runs')}>
    <div class="list__head">
      <Segmented
        size="sm"
        label={$t('Filter runs')}
        bind:value={filter}
        options={[
          { value: 'all', label: $t('All') },
          { value: 'active', label: $t('Active') },
          { value: 'attention', label: $t('Problems') },
          { value: 'finished', label: $t('Done') },
        ]}
      />
      <IconButton size="sm" label={$t('Refresh runs')} onclick={() => void runs.refresh()} disabled={runs.listLoading}><RefreshCw /></IconButton>
    </div>
    {#if runs.listError}<p class="error" role="alert">{$t(runs.listError)}</p>{/if}
    {#if runs.listLoading && runs.summaries.length === 0}
      <div class="list__loading"><Skeleton lines={4} /></div>
    {:else if visibleRuns.length === 0}
      <p class="list__empty">{runs.summaries.length ? $t('No runs match this filter.') : $t('No runs yet.')}</p>
    {:else}
      <ul>
        {#each visibleRuns as item (item.id)}
          <li>
            <button
              type="button"
              class="run-row"
              class:run-row--current={item.id === runs.selectedRunId}
              aria-current={item.id === runs.selectedRunId ? 'true' : undefined}
              onclick={() => onOpenRun(item.id)}
            >
              <StatusDot status={statusDot[item.status]} label={$t(RUN_LABEL[item.status])} />
              <span class="run-row__text">
                <strong>{item.pipelineName || item.teamName || $t('Untitled pipeline')}</strong>
                <small>{$t(RUN_LABEL[item.status])} · #{shortId(item.id)}</small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </nav>

  <section class="stage" aria-label={$t('Run')}>
    {#if run}
      <header class="stage__head">
        <div class="stage__title">
          <h2>{run.definition.pipeline.name || $t('Untitled pipeline')}</h2>
          <Badge tone={RUN_TONE[run.status]}>
            {#if run.status === 'running' && !run.paused}<Spinner size={10} />{/if}
            {run.paused && run.status === 'running' ? $t('Paused') : $t(RUN_LABEL[run.status])}
          </Badge>
          <span class="muted">{$t('{0} of {1} steps done', [counts.done, counts.total])}</span>
          <RunTriggerLabel trigger={run.trigger} {onOpenRun} />
          {#if counts.attention > 0}<Badge tone="warning">{$t('{0} need attention', [counts.attention])}</Badge>{/if}
        </div>
        {#if Object.keys(run.inputs ?? {}).length}
          <Popover align="end" width={360} padded label={$t('Run inputs')}>
            {#snippet trigger(props)}
              <Button size="sm" variant="ghost" {...props}>
                {#snippet leading()}<FileInput />{/snippet}
                {$t('Inputs')}
              </Button>
            {/snippet}
            <RunInputsView {run} />
          </Popover>
        {/if}
        <div class="stage__actions">
          {#if run.status === 'running'}
            <Button size="sm" variant="ghost" loading={runs.busy === 'pause'} disabled={!!runs.busy || safeMode} onclick={() => void runs.setPaused(!run.paused)}>
              {#snippet leading()}{#if run.paused}<Play />{:else}<Pause />{/if}{/snippet}
              {run.paused ? $t('Resume') : $t('Pause')}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!runs.busy || safeMode} onclick={() => (confirmCancel = true)}>
              {#snippet leading()}<Square />{/snippet}
              {$t('Stop run')}
            </Button>
          {/if}
          <Button size="sm" variant="ghost" onclick={() => onEdit(run?.definition.launchCommand?.id)}>
            {#snippet leading()}<PenLine />{/snippet}
            {$t('Edit pipeline')}
          </Button>
        </div>
      </header>
      {#if runs.actionError}<p class="error error--bar" role="alert">{$t(runs.actionError)}</p>{/if}
      {#if runs.liveError}<p class="error error--bar" role="status">{$t(runs.liveError)}</p>{/if}
      {#if run.status === 'uncertain'}
        <p class="warn-bar" role="status">{$t('Run state needs reconciliation. No outcome is inferred.')}</p>
      {/if}
      <div class="stage__canvas">
        {#key run.id}
          <RunCanvas {run} {workspaceId} {views} selectedId={runs.selectedStepId} {activity} onSelect={(id) => runs.select(id)} />
        {/key}
      </div>
    {:else if runs.runLoading}
      <div class="stage__loading"><Skeleton lines={6} /></div>
    {:else if runs.runError}
      <EmptyState title={$t('Could not open this run')} description={$t(runs.runError)} />
    {:else}
      <EmptyState icon={History} title={$t('No run selected')} description={runs.summaries.length ? $t('Choose a run on the left to see each step, its result and its conversation.') : $t('Build a pipeline in the editor and press Run. Every run appears here with its steps and results.')}>
        {#snippet actions()}
          <Button size="sm" onclick={() => onEdit(undefined)}>{$t('Open editor')}</Button>
        {/snippet}
      </EmptyState>
    {/if}
  </section>

  {#if run && selected}
    {#key `${run.id}:${selected.stepId}`}
      <TaskPanel {runs} {run} view={selected} {snapshotFor} onOpenSession={openSession} onClose={() => runs.select('')} />
    {/key}
  {/if}
</div>

<Dialog bind:open={confirmCancel} title={$t('Stop this run?')} description={$t('Working agents are interrupted and no new steps start. Finished results stay recorded.')} size="sm">
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmCancel = false)}>{$t('Keep running')}</Button>
    <Button
      variant="danger"
      loading={runs.busy === 'cancel-run'}
      onclick={async () => {
        if (await runs.cancelRun()) confirmCancel = false;
      }}>{$t('Stop run')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .runs {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .runs--panel {
    grid-template-columns: 260px minmax(0, 1fr) minmax(340px, 400px);
  }
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  .list__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
    padding: var(--piui-space-2);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .list__loading,
  .list__empty {
    padding: var(--piui-space-4);
    color: var(--piui-text-muted);
  }
  .list ul {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: var(--piui-space-2);
    overflow-y: auto;
    list-style: none;
  }
  .run-row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .run-row:hover {
    background: var(--piui-hover);
  }
  .run-row--current {
    background: var(--piui-selected);
  }
  .run-row__text {
    display: grid;
    min-width: 0;
  }
  .run-row__text strong {
    overflow: hidden;
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-row__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .stage {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  /* Narrow stages (step panel open) wrap the title and the actions onto
     separate lines instead of drawing them over each other. */
  .stage__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 6px var(--piui-space-3);
    min-height: 48px;
    padding: 6px var(--piui-space-3) 6px var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .stage__title {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px var(--piui-space-2);
    min-width: 0;
  }
  h2 {
    max-width: 100%;
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stage__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--piui-space-1);
    min-width: 0;
  }
  .stage__canvas {
    flex: 1;
    min-height: 0;
  }
  .stage__loading {
    padding: var(--piui-space-8);
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .error {
    margin: var(--piui-space-2);
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
  .error--bar,
  .warn-bar {
    margin: 0;
    padding: 6px var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .warn-bar {
    background: var(--piui-warning-surface);
    color: var(--piui-warning);
    font-size: var(--piui-text-sm);
  }
  @media (max-width: 1100px) {
    .runs--panel {
      grid-template-columns: 220px minmax(0, 1fr) 340px;
    }
    .runs {
      grid-template-columns: 220px minmax(0, 1fr);
    }
  }
</style>
