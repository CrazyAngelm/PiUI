<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import Ban from '@lucide/svelte/icons/ban';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
  import { t } from '../../features/locale/language';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import type { OrchestrationRunV6, ReconcileUncertainTaskRequest, TaskRecord } from '../../host-api/orchestrationClient';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import { usageTotal } from '../../features/orchestration/runUsage';
  import { Badge, Button, Checkbox, Dialog, EmptyState, IconButton, Spinner, Tabs } from '../../lib/ui';
  import Transcript from '../chat/transcript/Transcript.svelte';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { harnessMeta } from '../harnessMeta';
  import { failureText } from './runGraph';
  import {
    STEP_LABEL,
    STEP_TONE,
    canCancelTask,
    canRecordSucceeded,
    canRepeat,
    formatValue,
    resultEntries,
    stepState,
    type StepView,
  } from './runPresentation';
  import type { RunsStore } from './runsStore.svelte';
  import { completedReviewRounds } from '../../host-api/runInputs';
  import RunInputsView from './RunInputsView.svelte';

  interface Props {
    runs: RunsStore;
    run: OrchestrationRunV6;
    view: StepView;
    /** Snapshot for a PiUI session id; loads it on demand. */
    snapshotFor: (sessionId: string) => SessionSnapshot | undefined;
    onOpenSession: (sessionId: string) => void;
    onClose: () => void;
  }
  let { runs, run, view, snapshotFor, onOpenSession, onClose }: Props = $props();

  type Tab = 'result' | 'conversation' | 'input';
  let tab = $state<Tab>('result');
  let attempt = $state(-1);
  let confirmRepeat = $state(false);
  let confirmRetry = $state(false);
  let reconcileOpen = $state(false);
  let resolution = $state<ReconcileUncertainTaskRequest['resolution']['status']>('failed');
  let acknowledged = $state(false);
  let searchOpen = $state(false);

  const member = $derived(run.definition.team.members.find((item) => item.id === view.step.assignedMemberId));
  const profile = $derived(member ? run.definition.profiles.find((item) => item.id === member.profileId) : undefined);
  const record = $derived<TaskRecord | undefined>(attempt >= 0 ? view.attempts[attempt] : view.task);
  const shown = $derived(attempt >= 0 && record ? stepState(view.step, record) : view.state);
  const sessionId = $derived(record?.execution?.id);
  const snapshot = $derived(sessionId ? snapshotFor(sessionId) : undefined);
  const entries = $derived(resultEntries(view.step, record?.resultData));
  const answer = $derived.by(() => {
    const blocks = snapshot?.blocks ?? [];
    const reference = record?.resultReference;
    const block = reference?.blockId
      ? blocks.find((item) => item.id === reference.blockId)
      : [...blocks].reverse().find((item) => item.kind === 'assistant' && item.status !== 'streaming');
    return block?.text ?? '';
  });
  const receipts = $derived(sessionId ? (runs.usage[sessionId] ?? []) : []);
  const tokens = $derived(usageTotal(receipts, 'totalTokens'));
  const live = $derived(attempt < 0);
  const review = $derived(view.step.review);
  const rounds = $derived(review ? completedReviewRounds(run, view.stepId) : 0);
  const limitReached = $derived(view.task?.status === 'awaitingApproval' && view.task.failure?.code === 'review-limit-reached');
  const busyKey = $derived(runs.busy);
  const dependencies = $derived(
    view.step.dependencyStepIds.map((id) => {
      const step = run.definition.pipeline.steps.find((item) => item.id === id);
      const task = run.tasks.find((item) => item.stepId === id);
      return { id, name: step?.name || id, step, task };
    }),
  );

  function dependencyText(task: TaskRecord | undefined): string {
    if (!task) return '';
    if (task.resultData) {
      const bindings = (view.step.inputBindings ?? []).filter((binding) => binding.sourceStepId === task.stepId);
      const data = bindings.length ? Object.fromEntries(bindings.map((binding) => [binding.name, task.resultData?.[binding.field]])) : task.resultData;
      return formatValue(data);
    }
    const source = task.execution?.id ? snapshotFor(task.execution.id) : undefined;
    const blocks = source?.blocks ?? [];
    const block = task.resultReference?.blockId
      ? blocks.find((item) => item.id === task.resultReference?.blockId)
      : [...blocks].reverse().find((item) => item.kind === 'assistant');
    return block?.text ?? '';
  }

  async function reconcile(): Promise<void> {
    const value: ReconcileUncertainTaskRequest['resolution'] =
      resolution === 'succeeded' ? { status: 'succeeded' } : resolution === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', failureCode: 'OPERATOR_ASSERTED_FAILURE' };
    if (await runs.reconcile(view.stepId, value)) {
      reconcileOpen = false;
      acknowledged = false;
    }
  }

  function compactNumber(value: number | undefined): string {
    if (value === undefined) return '—';
    return value >= 10_000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : value.toLocaleString();
  }
</script>

<aside class="panel" aria-labelledby="task-title">
  <header class="head">
    <div class="head__main">
      {#if profile}<HarnessMark kind={profile.harness} size={22} />{/if}
      <div class="head__text">
        <h2 id="task-title" title={view.name}>{view.name}</h2>
        {#if profile}
          <span class="muted">{[profile.name, harnessMeta(profile.harness).label, profile.model, profile.reasoning].filter(Boolean).join(' · ')}</span>
        {:else if view.step.router}
          <span class="muted">{$t('Router')}</span>
        {/if}
      </div>
    </div>
    <IconButton label={$t('Close step details')} size="sm" onclick={onClose}><X /></IconButton>
  </header>

  <div class="summary">
    <Badge tone={STEP_TONE[shown] === 'accent' ? 'accent' : STEP_TONE[shown]}>
      {#if shown === 'running'}<Spinner size={10} />{/if}
      {$t(STEP_LABEL[shown])}
    </Badge>
    {#if view.attempts.length}
      <div class="attempts" role="group" aria-label={$t('Attempts')}>
        {#each view.attempts as _, index (index)}
          <button type="button" class:active={attempt === index} aria-pressed={attempt === index} onclick={() => (attempt = index)} title={$t('Attempt {0}', [index + 1])}>{index + 1}</button>
        {/each}
        <button type="button" class:active={attempt < 0} aria-pressed={attempt < 0} onclick={() => (attempt = -1)} title={$t('Latest attempt')}>{view.attempts.length + 1}</button>
      </div>
    {/if}
    <span class="spacer"></span>
    {#if review}
      <span class="muted small" title={$t('Review rounds')}>{review.maxIterations ? $t('Round {0} of {1}', [Math.max(rounds, 1), review.maxIterations]) : $t('Round {0}', [Math.max(rounds, 1)])}</span>
    {/if}
    {#if tokens !== undefined}<span class="muted small" title={$t('Tokens used by this step')}>{compactNumber(tokens)} {$t('tokens')}</span>{/if}
  </div>

  {#if record?.failure}
    <div class="note note--danger" role="note">
      <TriangleAlert size={15} />
      <p>{$t(failureText(record.failure.code))}</p>
    </div>
  {/if}
  {#if !live}
    <p class="note note--info">{$t('You are viewing an earlier attempt. Actions apply to the latest one.')}</p>
  {/if}

  {#if live}
    <div class="actions">
      {#if view.state === 'awaitingApproval'}
        <Button size="sm" variant="primary" loading={busyKey === `decide:${view.stepId}`} disabled={!!busyKey || runs.safeMode} onclick={() => void runs.decide(view.stepId, true)}>
          {#snippet leading()}<Check />{/snippet}
          {limitReached ? $t('Accept last result') : $t('Approve result')}
        </Button>
        {#if limitReached && review}
          <Button size="sm" loading={busyKey === `repeat:${review.retryFromStepId}`} disabled={!!busyKey || runs.safeMode} onclick={() => void runs.repeat(review.retryFromStepId)}>
            {#snippet leading()}<RotateCcw />{/snippet}
            {$t('One more round')}
          </Button>
        {/if}
        <Button size="sm" variant="danger" disabled={!!busyKey || runs.safeMode} onclick={() => void runs.decide(view.stepId, false)}>{$t('Reject')}</Button>
      {/if}
      {#if view.state === 'uncertain' && view.sessionId}
        <Button size="sm" variant="primary" disabled={!!busyKey || runs.safeMode} onclick={() => (confirmRetry = true)}>
          {#snippet leading()}<RotateCcw />{/snippet}
          {$t('Retry step')}
        </Button>
        <Button size="sm" disabled={!!busyKey || runs.safeMode} onclick={() => (reconcileOpen = true)}>
          {#snippet leading()}<ClipboardCheck />{/snippet}
          {$t('Record outcome…')}
        </Button>
      {/if}
      {#if canRepeat(view.task) && run.status !== 'cancelled' && !limitReached}
        <Button size="sm" variant="ghost" disabled={!!busyKey || runs.safeMode} onclick={() => (confirmRepeat = true)}>
          {#snippet leading()}<RotateCcw />{/snippet}
          {$t('Run again from here')}
        </Button>
      {/if}
      {#if canCancelTask(view.task) && view.state !== 'onCall'}
        <Button size="sm" variant="ghost" loading={busyKey === `cancel:${view.stepId}`} disabled={!!busyKey || runs.safeMode} onclick={() => void runs.cancelTask(view.stepId)}>
          {#snippet leading()}<Ban />{/snippet}
          {$t('Cancel step')}
        </Button>
      {/if}
      {#if sessionId}
        <Button size="sm" variant="ghost" onclick={() => onOpenSession(sessionId)}>
          {#snippet leading()}<MessageSquare />{/snippet}
          {$t('Open chat')}
        </Button>
      {/if}
    </div>
  {:else if sessionId}
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={() => onOpenSession(sessionId)}>
        {#snippet leading()}<MessageSquare />{/snippet}
        {$t('Open chat')}
      </Button>
    </div>
  {/if}

  <Tabs
    bind:value={tab}
    label={$t('Step details')}
    tabs={[
      { value: 'result', label: $t('Result') },
      { value: 'conversation', label: $t('Conversation'), disabled: !sessionId },
      { value: 'input', label: $t('Input') },
    ]}
  >
    {#snippet panel(current)}
      {#if current === 'result'}
        <div class="pane">
          {#if entries.length}
            <dl class="fields">
              {#each entries as entry (entry.name)}
                <div>
                  <dt>{entry.name}</dt>
                  <dd>
                    {#if typeof entry.value === 'string' && entry.value.length > 80}
                      <MarkdownContent source={entry.value} compact={true} />
                    {:else if typeof entry.value === 'boolean'}
                      <Badge tone={entry.value ? 'success' : 'danger'}>{entry.value ? $t('Yes') : $t('No')}</Badge>
                    {:else if typeof entry.value === 'object' && entry.value !== null}
                      <pre>{formatValue(entry.value)}</pre>
                    {:else}
                      {formatValue(entry.value)}
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}
          {#if answer}
            <div class="answer">
              {#if entries.length}<h3>{$t('Final answer')}</h3>{/if}
              <MarkdownContent source={answer} compact={true} />
            </div>
          {:else if !entries.length}
            {#if shown === 'running'}
              <EmptyState size="sm" title={$t('Working on it')} description={$t('The result appears here when the step finishes.')} />
            {:else if shown === 'ready' || shown === 'onCall'}
              <EmptyState size="sm" title={$t('Not started yet')} description={shown === 'onCall' ? $t('This agent runs only when another agent calls it.') : $t('It starts when the steps before it finish.')} />
            {:else if sessionId && !snapshot}
              <div class="loading"><Spinner size={14} /> {$t('Loading the agent’s history…')}</div>
            {:else}
              <EmptyState size="sm" title={$t('No result recorded')} description={$t('This step finished without a result.')} />
            {/if}
          {/if}
        </div>
      {:else if current === 'conversation'}
        {#if snapshot && sessionId}
          <div class="conversation">
            <Transcript
              blocks={snapshot.blocks}
              loading={false}
              sessionKey={`run:${sessionId}`}
              historySessionId={sessionId}
              agentLabel={profile?.name ?? view.name}
              bind:searchOpen
            />
          </div>
        {:else}
          <div class="loading"><Spinner size={14} /> {$t('Loading the agent’s history…')}</div>
        {/if}
      {:else}
        <div class="pane">
          {#if Object.keys(run.inputs ?? {}).length}
            <section>
              <h3>{$t('Run input')}</h3>
              <RunInputsView {run} />
            </section>
          {/if}
          <section>
            <h3>{$t('Task')}</h3>
            {#if view.step.instructions}
              <MarkdownContent source={view.step.instructions} compact={true} />
            {:else}
              <p class="muted">{$t('No task text; the agent works from its role instructions.')}</p>
            {/if}
          </section>
          {#if view.step.inputInstructions}
            <section>
              <h3>{$t('Expected input')}</h3>
              <p>{view.step.inputInstructions}</p>
            </section>
          {/if}
          <section>
            <h3>{$t('Receives results from')}</h3>
            {#if dependencies.length === 0}
              <p class="muted">{$t('Nothing: this step starts the run.')}</p>
            {:else}
              <ul class="deps">
                {#each dependencies as dependency (dependency.id)}
                  {@const depState = dependency.step ? stepState(dependency.step, dependency.task) : 'missing'}
                  <li>
                    <div class="deps__head">
                      <strong>{dependency.name}</strong>
                      <Badge tone={STEP_TONE[depState]}>{$t(STEP_LABEL[depState])}</Badge>
                    </div>
                    {#if dependencyText(dependency.task)}
                      <pre class="deps__value">{dependencyText(dependency.task)}</pre>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      {/if}
    {/snippet}
  </Tabs>
</aside>

<Dialog bind:open={confirmRepeat} title={$t('Run again from this step?')} description={$t('The step and every step after it start over. Earlier results stay in the attempt history.')} size="sm">
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmRepeat = false)}>{$t('Keep results')}</Button>
    <Button
      variant="primary"
      loading={busyKey === `repeat:${view.stepId}`}
      onclick={async () => {
        if (await runs.repeat(view.stepId)) confirmRepeat = false;
      }}>{$t('Run again')}</Button
    >
  {/snippet}
</Dialog>

<Dialog bind:open={confirmRetry} title={$t('Retry this step?')} size="sm">
  <p class="dialog-text">{$t('A retry starts a new attempt; it does not automatically replay the prior attempt. Native side effects may already exist. Check the native session before retrying.')}</p>
  {#snippet footer()}
    {#if view.sessionId}<Button variant="ghost" onclick={() => view.sessionId && onOpenSession(view.sessionId)}>{$t('Check native session')}</Button>{/if}
    <Button
      variant="primary"
      loading={busyKey === `retry:${view.stepId}`}
      onclick={async () => {
        if (await runs.retry(view.stepId)) confirmRetry = false;
      }}>{$t('Retry step')}</Button
    >
  {/snippet}
</Dialog>

<Dialog bind:open={reconcileOpen} title={$t('Record what happened')} description={$t('After checking the linked native session, record an operator assertion. It reconciles the journal only.')} size="md">
  <div class="choices" role="radiogroup" aria-label={$t('Outcome')}>
    {#each [
      { value: 'succeeded', label: 'The step succeeded', note: 'Recording succeeded can unblock dependent tasks. It does not prove native completion.', disabled: !canRecordSucceeded(view.step) },
      { value: 'failed', label: 'The step failed', note: 'Dependent steps will not start.', disabled: false },
      { value: 'cancelled', label: 'The step was cancelled', note: 'Recording cancelled does not stop a native process.', disabled: false },
    ] as const as choice (choice.value)}
      <label class="choice" class:choice--disabled={choice.disabled}>
        <input type="radio" name="resolution" value={choice.value} checked={resolution === choice.value} disabled={choice.disabled} onchange={() => (resolution = choice.value)} />
        <span><strong>{$t(choice.label)}</strong><small>{$t(choice.note)}</small></span>
      </label>
    {/each}
  </div>
  <Checkbox bind:checked={acknowledged} label={$t('I checked the linked native session and understand this is an operator assertion.')} />
  {#snippet footer()}
    {#if view.sessionId}<Button variant="ghost" onclick={() => view.sessionId && onOpenSession(view.sessionId)}>{$t('Check native session')}</Button>{/if}
    <Button variant="primary" disabled={!acknowledged} loading={busyKey === `reconcile:${view.stepId}`} onclick={() => void reconcile()}>{$t('Record outcome')}</Button>
  {/snippet}
</Dialog>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3) var(--piui-space-2) var(--piui-space-2) var(--piui-space-4);
  }
  .head__main {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .head__text {
    display: grid;
    min-width: 0;
  }
  h2 {
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .small {
    font-size: var(--piui-text-xs);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 0 var(--piui-space-4) var(--piui-space-2);
  }
  .spacer {
    flex: 1;
  }
  .attempts {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
  }
  .attempts button {
    min-width: 22px;
    height: 20px;
    padding: 0 5px;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .attempts button.active {
    background: var(--piui-surface-3);
    color: var(--piui-text);
  }
  .note {
    display: flex;
    gap: var(--piui-space-2);
    margin: 0 var(--piui-space-4) var(--piui-space-2);
    padding: 8px 10px;
    border-radius: var(--piui-radius-md);
    font-size: var(--piui-text-sm);
  }
  .note p {
    margin: 0;
  }
  .note--danger {
    border: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .note--info {
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
    padding: 0 var(--piui-space-4) var(--piui-space-3);
  }
  .panel :global(.piui-tabs) {
    flex: 1;
    min-height: 0;
  }
  .panel :global(.piui-tabs__bar) {
    padding: 0 var(--piui-space-3);
  }
  .panel :global(.piui-tabs__panel) {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .pane {
    display: grid;
    gap: var(--piui-space-4);
    padding: var(--piui-space-4);
  }
  .pane section {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fields {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
  }
  .fields div {
    display: grid;
    gap: 4px;
  }
  dt {
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  pre {
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    white-space: pre-wrap;
  }
  .answer {
    display: grid;
    gap: var(--piui-space-2);
  }
  .conversation {
    display: flex;
    height: 100%;
    min-height: 320px;
  }
  .conversation :global(.transcript) {
    --piui-chat-inline-padding: var(--piui-space-4);
  }
  .loading {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: var(--piui-space-4);
    color: var(--piui-text-muted);
  }
  .deps {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .deps li {
    display: grid;
    gap: 6px;
  }
  .deps__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
  .deps__value {
    max-height: 180px;
  }
  .dialog-text {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .choices {
    display: grid;
    gap: var(--piui-space-2);
    margin-bottom: var(--piui-space-3);
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    padding: 8px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    cursor: pointer;
  }
  .choice:has(input:checked) {
    border-color: var(--piui-accent);
    background: color-mix(in srgb, var(--piui-accent) 8%, transparent);
  }
  .choice--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .choice span {
    display: grid;
    gap: 2px;
  }
  .choice small {
    color: var(--piui-text-muted);
  }
</style>
