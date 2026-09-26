<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import { tick } from 'svelte';
  import { t } from '../../../features/locale/language';
  import type { PipelineInput, RunInputValue } from '../../../host-api/orchestrationClient';
  import { Button, Dialog } from '../../../lib/ui';
  import InputFields, { formState, formValues, type InputFormState } from './InputFields.svelte';
  import { checkValues, initialValues } from './runInputs';

  interface Props {
    open: boolean;
    pipelineName: string;
    inputs: readonly PipelineInput[];
    busy?: boolean;
    /** Resolves true when the run started; the dialog then closes. */
    onStart: (values: Record<string, RunInputValue>) => Promise<boolean>;
  }
  let { open = $bindable(false), pipelineName, inputs, busy = false, onStart }: Props = $props();

  let form = $state<InputFormState>({ values: {}, numbers: {} });
  let errors = $state<Record<string, string>>({});
  let element = $state<HTMLFormElement | null>(null);

  // Fresh values every time the dialog opens, from the declared defaults.
  $effect(() => {
    if (!open) return;
    form = formState(inputs, initialValues(inputs));
    errors = {};
    void tick().then(() => element?.querySelector<HTMLElement>('input, textarea, button[role="radio"]')?.focus());
  });

  async function submit(event: SubmitEvent | undefined = undefined): Promise<void> {
    event?.preventDefault();
    const result = checkValues(inputs, formValues(inputs, form));
    errors = result.errors;
    if (Object.keys(result.errors).length) {
      await tick();
      element?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    if (await onStart(result.values)) open = false;
  }
</script>

<Dialog bind:open title={$t('Run {0}', [pipelineName || $t('pipeline')])} description={$t('Agents receive these values as task context.')} size="md">
  <form bind:this={element} class="form" id="run-inputs-form" onsubmit={(event) => void submit(event)} novalidate>
    <InputFields {inputs} bind:form {errors} idPrefix="run-input" disabled={busy} onSubmitShortcut={() => void submit()} />
  </form>
  {#snippet footer()}
    <span class="hint">{$t('Ctrl+Enter to start')}</span>
    <Button variant="ghost" onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="run-inputs-form" loading={busy}>
      {#snippet leading()}<Play />{/snippet}
      {$t('Start run')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: var(--piui-space-4);
  }
  .hint {
    margin-right: auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
</style>
