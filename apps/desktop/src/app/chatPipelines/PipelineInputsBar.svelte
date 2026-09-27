<script lang="ts">
  import Route from '@lucide/svelte/icons/route';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import type { RunInputValue } from '../../host-api/orchestrationClient';
  import { Popover, Spinner } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import InputFields, { formState, formValues, type InputFormState } from '../pipelines/inputs/InputFields.svelte';
  import { checkValues, initialValues } from '../pipelines/inputs/runInputs';
  import { chatInput, extraInputs } from './chatPipeline';
  import type { ChatPipelineDetail } from './chatPipelines.svelte';

  /** Above the composer while a message goes through a pipeline: who answers, and the pipeline's other inputs. */
  interface Props {
    detail: ChatPipelineDetail | undefined;
    loading?: boolean;
    error?: string;
    disabled?: boolean;
    /** The chat already exists: its own agent continues after the run. */
    existingChat?: boolean;
  }
  let { detail, loading = false, error = '', disabled = false, existingChat = false }: Props = $props();

  const extra = $derived(extraInputs(detail?.inputs));
  const message = $derived(chatInput(detail?.inputs));
  let form = $state<InputFormState>({ values: {}, numbers: {} });
  let errors = $state<Record<string, string>>({});
  let open = $state(false);
  let formFor = '';

  // Fresh values from the declared defaults whenever the pipeline changes.
  $effect(() => {
    const key = detail ? `${detail.commandId}:${JSON.stringify(extra)}` : '';
    if (key === formFor) return;
    formFor = key;
    form = formState(extra, initialValues(extra));
    errors = {};
  });

  /** The extra input values, or undefined after opening the form on its errors. */
  export function collect(): Record<string, RunInputValue> | undefined {
    const result = checkValues(extra, formValues(extra, form));
    errors = result.errors;
    if (Object.keys(result.errors).length) {
      open = true;
      return undefined;
    }
    return result.values;
  }
</script>

<div class="bar" role="group" aria-label={$t('Pipeline for this message')}>
  {#if loading && !detail}
    <span class="line"><Spinner size={12} /> {$t('Loading the pipeline…')}</span>
  {:else if error}
    <span class="line line--warn"><TriangleAlert size={13} /> {$t(error)}</span>
  {:else if detail && !detail.accepts}
    <span class="line line--warn"><TriangleAlert size={13} /> {$t('This pipeline has no message input. Open it in Pipelines and choose “Accept chat messages” on its start.')}</span>
  {:else if detail}
    <span class="line">
      <Route size={13} />
      <span class="text">
        {$t('Runs {0}', [detail.name])}{#if message}<span class="muted">{' · '}{$t('message → {0}', [message.label || message.name])}</span>{/if}
        {#if detail.reply && !existingChat}<span class="muted">{' · '}{$t('then {0} continues the chat', [harnessMeta(detail.reply.harness).label])}</span>{/if}
      </span>
    </span>
    {#if extra.length}
      <Popover bind:open width={340} align="end" side="top" label={$t('Pipeline inputs')}>
        {#snippet trigger(props)}
          <button type="button" class="inputs" class:inputs--error={Object.keys(errors).length > 0} {...props} {disabled}>
            <SlidersHorizontal size={13} />
            {$t('Inputs ({0})', [extra.length])}
          </button>
        {/snippet}
        <form class="form" onsubmit={(event) => { event.preventDefault(); open = false; }}>
          <InputFields inputs={extra} bind:form {errors} idPrefix="chat-pipeline-input" {disabled} onSubmitShortcut={() => (open = false)} />
        </form>
      </Popover>
    {/if}
  {/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 30px;
    padding: 6px 12px 0 14px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }
  .line :global(svg) {
    flex: none;
    color: var(--piui-accent);
  }
  .line--warn,
  .line--warn :global(svg) {
    color: var(--piui-warning);
  }
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .inputs {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .inputs:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .inputs--error {
    border-color: var(--piui-danger-border);
    color: var(--piui-danger);
  }
  .form {
    display: grid;
    gap: var(--piui-space-3);
  }
</style>
