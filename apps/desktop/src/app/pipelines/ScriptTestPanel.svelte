<script lang="ts">
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import Square from '@lucide/svelte/icons/square';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import { t } from '../../features/locale/language';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import { scriptSourceValid, scriptTimeoutValid } from '../../host-api/stepExecutors';
  import { Badge, Button, Field, Spinner, Tabs, Textarea } from '../../lib/ui';
  import { failureText } from '../runs/runGraph';
  import { formatValue } from '../runs/runPresentation';
  import { useWorkspace } from '../shell/context';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import { checkSample, pinnedDependencies, testIsStale } from './scriptTests.svelte';

  /**
   * "Test script": runs the node's current code once on the host with an
   * editable sample stdin, through the same runner and checks as a run, and
   * shows what a run would record. Nothing is saved to a run.
   */
  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
  }
  let { editor, node }: Props = $props();
  const workspace = useWorkspace();

  type ResultTab = 'output' | 'fields' | 'stderr';
  let tab = $state<ResultTab>('output');
  let now = $state(Date.now());

  const tests = $derived(editor.scriptTests);
  const script = $derived(node.executor?.type === 'script' ? node.executor : undefined);
  const sample = $derived(tests.sample(editor.graph, node));
  // `in` is tracked by the state proxy, including keys added later.
  const edited = $derived(node.id in tests.samples);
  const pinnedFrom = $derived(pinnedDependencies(editor.graph, node.id));
  const check = $derived(checkSample(sample));
  const view = $derived(tests.view(node.id));
  const running = $derived(view.status === 'running');
  const result = $derived(view.status === 'done' ? view.result : undefined);
  const stale = $derived(result !== undefined && testIsStale(node, view.tested));
  const project = $derived(workspace.catalog.workspaces.find((item) => item.id === editor.workspaceId));
  /** Why the test cannot start; the host checks every rule again. */
  const blocked = $derived<string | undefined>(
    editor.safeMode || workspace.catalog.safeMode
      ? 'Scripts do not run in safe mode.'
      : project !== undefined && project.trust !== 'trusted'
        ? 'Trust this project folder to test scripts.'
        : script === undefined || !scriptSourceValid(script.source)
          ? 'Add code of at most 64 KiB to test it.'
          : !scriptTimeoutValid(script.timeoutSeconds)
            ? 'Set a time limit from 1 to 3600 seconds.'
            : undefined,
  );
  const elapsed = $derived(running && view.startedAt !== undefined ? Math.max(0, Math.floor((now - view.startedAt) / 1000)) : 0);

  $effect(() => {
    if (!running) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });

  /** Failure codes a test adds to the run's own texts. */
  const EXTRA_FAILURES: Readonly<Record<string, string>> = {
    'result-artifact-unavailable': 'A declared file field does not name a file in the project folder.',
  };
  function failureMessage(code: string): string {
    return EXTRA_FAILURES[code] ?? failureText(code);
  }

  function seconds(milliseconds: number): string {
    return milliseconds < 10_000 ? (milliseconds / 1000).toFixed(2) : String(Math.round(milliseconds / 1000));
  }

  const verdict = $derived.by(() => {
    if (result === undefined) return undefined;
    if (result.outcome === 'cancelled') return { tone: 'neutral' as const, label: 'Cancelled', note: 'The script and every process it started were stopped.' };
    if (result.outcome === 'timedOut') return { tone: 'danger' as const, label: 'Timed out', note: 'A run would stop it the same way and fail the step.' };
    return result.failure === null
      ? { tone: 'success' as const, label: 'A run would succeed', note: '' }
      : { tone: 'danger' as const, label: 'A run would fail', note: '' };
  });

  async function start(): Promise<void> {
    if (!check.ok || blocked !== undefined || running) return;
    tab = 'output';
    await tests.run(node, check.value);
    const done = tests.view(node.id);
    if (done.status === 'done' && done.result?.failure && done.result.fieldIssues.length) tab = 'fields';
    else if (done.status === 'done' && done.result?.outcome === 'exited' && done.result.exitCode !== 0) tab = 'stderr';
  }
</script>

<section class="test" aria-labelledby="script-test-title">
  <h3 id="script-test-title">{$t('Test script')}</h3>
  <p class="hint">{$t('Runs this code once now, on this computer in the project folder, with the sample input below. Nothing is saved to a run.')}</p>

  <Field
    label={$t('Sample input (stdin)')}
    for="script-test-sample"
    error={check.ok ? undefined : $t(check.error)}
    description={$t('The JSON document the script reads. It is kept for this node while the editor is open.')}
  >
    {#snippet action()}
      {#if edited && !running}
        <button type="button" class="link" onclick={() => tests.resetSample(node.id)}>{$t('Reset to default')}</button>
      {/if}
    {/snippet}
    <Textarea
      id="script-test-sample"
      class="sample"
      value={sample}
      minRows={5}
      maxRows={14}
      spellcheck={false}
      wrap="off"
      readonly={running}
      invalid={!check.ok}
      oninput={(event) => tests.setSample(node.id, event.currentTarget.value)}
    />
  </Field>
  {#if !edited && pinnedFrom.length}
    <p class="hint">{$t('The sample uses the pinned data of: {0}', [pinnedFrom.map((item) => item.profile.name || item.id).join(', ')])}</p>
  {/if}

  <div class="actions">
    {#if running}
      <Button size="sm" variant="secondary" loading={view.cancelling} onclick={() => void tests.cancel(node.id)}>
        {#snippet leading()}<Square />{/snippet}
        {$t('Cancel')}
      </Button>
      <span class="busy"><Spinner size={12} /> <span role="status">{$t('Running the script…')}</span> <span aria-hidden="true">{$t('{0} s', [elapsed])}</span></span>
    {:else}
      <Button size="sm" variant="secondary" disabled={blocked !== undefined || !check.ok || editor.busy} onclick={() => void start()}>
        {#snippet leading()}<FlaskConical />{/snippet}
        {$t('Test')}
      </Button>
      {#if blocked}<span class="hint">{$t(blocked)}</span>{/if}
    {/if}
  </div>

  {#if view.status === 'error' && view.error}
    <p class="error" role="alert">{$t(view.error)}</p>
  {/if}

  {#if result && verdict}
    <div class="result">
      <div class="verdict" role="status">
        <Badge tone={verdict.tone}>{$t(verdict.label)}</Badge>
        <span class="meta">
          {#if result.outcome === 'exited'}
            {result.exitCode === null ? $t('Ended by a signal') : $t('Exit code {0}', [result.exitCode])} · {$t('{0} s', [seconds(result.durationMs)])}
          {:else}
            {$t('Stopped after {0} s', [seconds(result.durationMs)])}
          {/if}
        </span>
      </div>
      {#if verdict.note}<p class="hint">{$t(verdict.note)}</p>{/if}
      {#if stale}<p class="hint hint--warning">{$t('The code or the result fields changed after this test. Test again to check them.')}</p>{/if}
      {#if result.failure}
        <div class="failure">
          <p>{$t(failureMessage(result.failure.code))}</p>
          {#if result.failure.detail}<pre>{result.failure.detail}</pre>{/if}
        </div>
      {/if}
      <Tabs
        label={$t('Test result')}
        bind:value={tab}
        tabs={[
          { value: 'output', label: $t('Output') },
          { value: 'fields', label: $t('Result fields'), count: view.tested?.resultFields.length || undefined },
          { value: 'stderr', label: $t('stderr') },
        ]}
      >
        {#snippet panel(current)}
          <div class="pane">
            {#if current === 'output'}
              {#if result.stdout}
                <pre class="stream">{result.stdout}</pre>
                {#if result.stdoutTruncated}<p class="hint">{$t('The output was longer than 256 KiB and was cut.')}</p>{/if}
              {:else}
                <p class="hint">{$t('The script printed nothing to stdout.')}</p>
              {/if}
            {:else if current === 'fields'}
              {@const fields = view.tested?.resultFields ?? []}
              {#if fields.length === 0}
                <p class="hint">{$t('This step declares no result fields: a run passes its output on as text.')}</p>
              {:else if result.data === null}
                <p class="hint">
                  {result.outcome === 'exited' ? $t('The output is not one complete JSON object, so no field could be read.') : $t('The script did not finish, so no result was read.')}
                </p>
              {:else}
                <ul class="fields">
                  {#each fields as field (field.name)}
                    {@const issue = result.fieldIssues.find((item) => item.field === field.name)}
                    <li class:fields__bad={issue !== undefined}>
                      <span class="fields__mark">
                        {#if issue}<CircleX size={14} aria-hidden="true" />{:else}<CircleCheck size={14} aria-hidden="true" />{/if}
                        <span class="visually-hidden">{issue ? $t('Problem') : $t('Valid')}</span>
                      </span>
                      <code>{field.name}</code>
                      <span class="fields__value">{issue?.code === 'result-missing-field' ? $t('Missing') : formatValue(result.data?.[field.name])}</span>
                      {#if issue}<span class="fields__issue">{$t(failureMessage(issue.code))}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else if result.stderr}
              <pre class="stream">{result.stderr}</pre>
              {#if result.stderrTruncated}<p class="hint">{$t('Only the last 64 KiB of stderr are kept.')}</p>{/if}
            {:else}
              <p class="hint">{$t('Nothing was written to stderr.')}</p>
            {/if}
          </div>
        {/snippet}
      </Tabs>
    </div>
  {/if}
</section>

<style>
  .test {
    display: grid;
    gap: var(--piui-space-3);
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .hint--warning {
    color: var(--piui-warning);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .test :global(textarea.sample) {
    font-family: var(--piui-font-mono);
    font-size: 12px;
    background: var(--piui-code-surface);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: 0;
    padding: 6px 10px;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
  .result {
    display: grid;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .verdict {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .meta {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .failure {
    display: grid;
    gap: 4px;
    font-size: var(--piui-text-sm);
  }
  .failure p {
    margin: 0;
  }
  .failure pre,
  .stream {
    max-height: 320px;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    font-family: var(--piui-font-mono);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .pane {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-2);
  }
  .fields {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--piui-text-sm);
  }
  .fields li {
    display: grid;
    grid-template-columns: 16px auto 1fr;
    gap: 2px 6px;
    align-items: baseline;
  }
  .fields__mark {
    display: inline-flex;
    color: var(--piui-success);
  }
  .fields__bad .fields__mark {
    color: var(--piui-danger);
  }
  .fields code {
    font-family: var(--piui-font-mono);
  }
  .fields__value {
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fields__issue {
    grid-column: 2 / -1;
    color: var(--piui-danger-text);
  }
</style>
