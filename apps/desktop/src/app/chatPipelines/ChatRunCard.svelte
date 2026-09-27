<script lang="ts">
  import Route from '@lucide/svelte/icons/route';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Square from '@lucide/svelte/icons/square';
  import Copy from '@lucide/svelte/icons/copy';
  import { t } from '../../features/locale/language';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import { orchestrationHost, type OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import type { ChatPipelineRunV1 } from '../../host-api/pipelineLibraryClient';
  import { performRunAction } from '../../features/orchestration/runActions';
  import { Badge, Button, IconButton, Spinner, StatusDot, toasts, type Status } from '../../lib/ui';
  import { RUN_LABEL, RUN_TONE, STEP_LABEL, runCounts, stepViews, type StepState } from '../runs/runPresentation';
  import { failureText } from '../runs/runGraph';
  import { answerTask, runMessage } from './chatPipeline';
  import { chatPipelines, runFinished } from './chatPipelines.svelte';

  /** One pipeline run of a chat: the message it answered, its steps and the answer. */
  interface Props {
    entry: ChatPipelineRunV1;
    workspaceId: string;
    sessionId: string;
    safeMode: boolean;
    onOpenRun: (runId: string) => void;
  }
  let { entry, workspaceId, sessionId, safeMode, onOpenRun }: Props = $props();

  const run = $derived<OrchestrationRunV6 | undefined>(chatPipelines.runs[entry.runId]);
  const views = $derived(run ? stepViews(run).filter((view) => view.state !== 'onCall' && view.state !== 'skipped') : []);
  const counts = $derived(runCounts(views));
  const answer = $derived(run ? chatPipelines.answers[run.id] : undefined);
  // Structured results (a result field object) read better as a code block.
  const shownAnswer = $derived.by(() => {
    const text = answer?.trim() ?? '';
    if (!/^[[{]/u.test(text)) return answer ?? '';
    try {
      return ['```json', JSON.stringify(JSON.parse(text), null, 2), '```'].join('\n');
    } catch {
      return answer ?? '';
    }
  });
  const answering = $derived(run ? answerTask(run) : undefined);
  const failures = $derived(views.filter((view) => view.task?.failure).map((view) => ({ name: view.name, code: view.task?.failure?.code ?? '' })));
  const name = $derived(run ? (run.definition.launchCommand?.name ?? run.definition.pipeline.name) : $t('Pipeline run'));
  let busy = $state('');

  const DOT: Record<StepState, Status> = {
    awaitingApproval: 'waiting',
    skipped: 'idle',
    ready: 'idle',
    running: 'running',
    succeeded: 'done',
    failed: 'failed',
    cancelled: 'offline',
    uncertain: 'waiting',
    onCall: 'idle',
    missing: 'waiting',
  };

  $effect(() => {
    if (!run) void chatPipelines.refreshRun(workspaceId, entry.runId);
  });

  async function stop(): Promise<void> {
    if (!run) return;
    busy = 'stop';
    const outcome = await performRunAction(orchestrationHost, { type: 'cancel', request: { workspaceId, runId: run.id, expectedRunRevision: run.revision } }, safeMode);
    busy = '';
    if (outcome.type === 'unconfirmed' || outcome.actionError) toasts.error($t('Could not stop the run'), outcome.type === 'unconfirmed' ? $t(outcome.error.message) : $t(outcome.actionError?.message ?? ''));
    await chatPipelines.refreshRun(workspaceId, run.id);
  }

  async function again(): Promise<void> {
    if (!run) return;
    busy = 'again';
    try {
      await chatPipelines.repeat(workspaceId, sessionId, run, safeMode);
    } catch (error) {
      toasts.error($t('Could not start the run'), error instanceof Error ? $t(error.message) : undefined);
    } finally {
      busy = '';
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(answer ?? '');
      toasts.success($t('Answer copied'));
    } catch {
      toasts.error($t('Could not copy the answer'));
    }
  }
</script>

{#if run && runMessage(run)}
  <div class="request"><MarkdownContent source={runMessage(run)} /></div>
{/if}
<article class="card" aria-label={$t('Pipeline run: {0}', [name])}>
  <header>
    <Route size={14} />
    <strong>{name}</strong>
    {#if run}
      <Badge tone={RUN_TONE[run.status]}>
        {#if run.status === 'running'}<Spinner size={10} />{/if}
        {$t(RUN_LABEL[run.status])}
      </Badge>
      <span class="count">{$t('{0} of {1} steps', [counts.done, counts.total])}</span>
    {/if}
    <span class="spacer"></span>
    {#if run?.status === 'running'}
      <IconButton size="sm" label={$t('Stop run')} disabled={safeMode || busy !== ''} onclick={() => void stop()}><Square /></IconButton>
    {/if}
    <IconButton size="sm" label={$t('Open run')} onclick={() => onOpenRun(entry.runId)}><ExternalLink /></IconButton>
  </header>

  {#if !run}
    <p class="muted">{$t('Loading the run…')}</p>
  {:else}
    <ol class="steps" aria-label={$t('Steps')}>
      {#each views as view (view.stepId)}
        <li>
          <StatusDot status={DOT[view.state]} label={$t(STEP_LABEL[view.state])} />
          <span>{view.name}</span>
        </li>
      {/each}
    </ol>

    {#if run.status === 'succeeded'}
      <div class="answer">
        {#if answering}<p class="answer__from">{$t('Answer from {0}', [answering.step.name || answering.step.id])}</p>{/if}
        {#if answer === undefined}
          <p class="muted"><Spinner size={12} /> {$t('Reading the answer…')}</p>
        {:else if answer}
          <MarkdownContent source={shownAnswer} />
        {:else}
          <p class="muted">{$t('The pipeline finished without a text answer. Open the run to see its results.')}</p>
        {/if}
      </div>
    {:else if failures.length}
      <ul class="failures">
        {#each failures as failure (failure.name)}
          <li><strong>{failure.name}:</strong> {$t(failureText(failure.code))}</li>
        {/each}
      </ul>
    {/if}

    {#if runFinished(run)}
      <footer>
        {#if run.status === 'succeeded' && !entry.consumed}
          <span class="hint">{$t('Your next message hands this result to the chat’s agent.')}</span>
        {/if}
        <span class="spacer"></span>
        {#if answer}
          <IconButton size="sm" label={$t('Copy answer')} onclick={() => void copy()}><Copy /></IconButton>
        {/if}
        <Button size="sm" variant="ghost" disabled={safeMode || busy !== '' || !run.definition.launchCommand} loading={busy === 'again'} onclick={() => void again()}>
          {#snippet leading()}<RotateCcw />{/snippet}
          {$t('Run again')}
        </Button>
      </footer>
    {/if}
  {/if}
</article>

<style>
  .request {
    width: fit-content;
    max-width: min(80%, var(--piui-chat-reading-width));
    margin: 0 0 var(--piui-space-3) auto;
    padding: 10px 14px;
    border-radius: 14px;
    background: var(--piui-user-surface);
  }
  .request :global(.markdown-content) {
    font-size: var(--piui-chat-user-font-size);
  }
  .card {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0 0 var(--piui-space-6);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  header,
  footer {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  header :global(svg) {
    flex: none;
    color: var(--piui-accent);
  }
  header strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count,
  .hint,
  .muted,
  .answer__from {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .muted {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .spacer {
    flex: 1;
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .steps li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .answer {
    padding-top: var(--piui-space-2);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .answer__from {
    margin: 0 0 4px;
  }
  .failures {
    margin: 0;
    padding-left: 18px;
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
</style>
