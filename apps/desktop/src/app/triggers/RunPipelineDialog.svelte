<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { orchestrationHost, type RunInputValue } from '../../host-api/orchestrationClient';
  import { Button, Dialog, Skeleton, toasts } from '../../lib/ui';
  import RunInputsDialog from '../pipelines/inputs/RunInputsDialog.svelte';
  import { useWorkspace } from '../shell/context';
  import { RunLaunch } from './runLaunch.svelte';
  import { runLauncher } from './runLauncher.svelte';

  const store = useWorkspace();
  // Mounted per request by the shell, so the first request is the one to serve.
  const request = untrack(() => runLauncher.request);
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === request?.workspaceId));
  const blocked = $derived.by(() => {
    if (store.safeMode) return 'Safe mode keeps runs read-only.';
    if (!request?.workspaceId || !workspace) return 'Open a chat in a project first, then run one of its pipelines.';
    if (workspace.missing) return 'This project folder is missing.';
    if (!workspace.personal && workspace.trust !== 'trusted') return 'Trust this folder from the sidebar to run its pipelines.';
    return '';
  });
  const launch = untrack(() =>
    request?.workspaceId ? new RunLaunch(request.workspaceId, request.sessionId, orchestrationHost, store.safeMode) : undefined,
  );

  let pickerOpen = $state(true);
  let inputsOpen = $state(false);

  $effect(() => {
    if (launch && !blocked) void untrack(() => launch.load());
  });

  // The flow ends when neither dialog is open.
  $effect(() => {
    if (!pickerOpen && !inputsOpen) runLauncher.close();
  });

  const projectName = $derived(workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : '');

  async function start(values: Record<string, RunInputValue> | undefined): Promise<boolean> {
    if (!launch) return false;
    const name = launch.selected?.name || $t('Untitled pipeline');
    const run = await launch.start(values);
    if (!run) return false;
    const workspaceId = launch.workspaceId;
    toasts.show({
      tone: 'success',
      title: $t('Run started: {0}', [name]),
      description: $t('Follow it in Runs. This chat is not changed.'),
      action: { label: $t('Open run'), run: () => store.openRun(workspaceId, run.id) },
    });
    pickerOpen = false;
    inputsOpen = false;
    return true;
  }

  async function next(): Promise<void> {
    if (!launch?.ready) return;
    if (launch.needsInputs) {
      // Inputs are asked in the same form as the pipeline editor's Run.
      inputsOpen = true;
      pickerOpen = false;
      return;
    }
    await start(undefined);
  }
</script>

<Dialog
  bind:open={pickerOpen}
  title={$t('Run a pipeline')}
  description={projectName ? $t('Starts a saved pipeline of {0}. The run appears in Runs; the chat is not changed.', [projectName]) : undefined}
  size="md"
>
  {#if blocked}
    <p class="message">{$t(blocked)}</p>
  {:else if launch}
    {#if launch.loading && launch.pipelines.length === 0}
      <Skeleton lines={3} />
    {:else if launch.pipelines.length === 0 && !launch.error}
      <p class="message">{$t('This project has no saved pipelines yet. Build one in Pipelines first.')}</p>
    {:else}
      <div class="list" role="radiogroup" aria-label={$t('Saved pipelines')}>
        {#each launch.pipelines as pipeline (pipeline.id)}
          <label class="row" class:row--selected={pipeline.id === launch.selectedId}>
            <input
              type="radio"
              name="run-pipeline"
              value={pipeline.id}
              checked={pipeline.id === launch.selectedId}
              disabled={launch.busy}
              onchange={() => void launch.select(pipeline.id)}
            />
            <Workflow size={15} aria-hidden="true" />
            <span>{pipeline.name || $t('Untitled pipeline')}</span>
          </label>
        {/each}
      </div>
      {#if launch.needsInputs}
        <p class="hint">{$t('This pipeline asks for inputs on the next step.')}</p>
      {/if}
    {/if}
    {#if launch.error}<p class="error" role="alert">{$t(launch.error)}</p>{/if}
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (pickerOpen = false)}>{$t('Cancel')}</Button>
    {#if !blocked && launch}
      <Button variant="primary" loading={launch.busy} disabled={!launch.ready || launch.busy} onclick={() => void next()}>
        {#snippet leading()}<Play />{/snippet}
        {launch.needsInputs ? $t('Next…') : $t('Start run')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

{#if launch}
  <RunInputsDialog
    bind:open={inputsOpen}
    pipelineName={launch.selected?.name ?? ''}
    inputs={launch.inputs}
    busy={launch.busy}
    onStart={async (values) => {
      const started = await start(values);
      if (!started && launch.error) toasts.error($t('Could not start the run'), $t(launch.error));
      return started;
    }}
  />
{/if}

<style>
  .list {
    display: grid;
    gap: 2px;
    max-height: 320px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 34px;
    padding: 0 var(--piui-space-2);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text);
    cursor: pointer;
  }
  .row:hover {
    background: var(--piui-hover);
  }
  .row--selected {
    background: var(--piui-selected);
  }
  .row input {
    accent-color: var(--piui-accent);
  }
  .row input:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .message,
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .hint {
    margin-top: var(--piui-space-2);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
