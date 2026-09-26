<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import { tick } from 'svelte';
  import { t } from '../../../features/locale/language';
  import type { PipelineInput, RunInputValue } from '../../../host-api/orchestrationClient';
  import { Button, Dialog } from '../../../lib/ui';
  import InputFields, { formState, formValues, type InputFormState } from './InputFields.svelte';
  import PinnedRunOption from './PinnedRunOption.svelte';
  import { checkValues, initialValues } from './runInputs';

  interface Props {
    open: boolean;
    pipelineName: string;
    inputs: readonly PipelineInput[];
    /** Names of pinned steps (v6.3); the explicit pinned-data choice shows only with some. */
    pinned?: readonly string[];
    busy?: boolean;
    /** Resolves true when the run started; the dialog then closes. */
    onStart: (values: Record<string, RunInputValue>, options: { usePinnedData: boolean }) => Promise<boolean>;
  }
  let { open = $bindable(false), pipelineName, inputs, pinned = [], busy = false, onStart }: Props = $props();

  let form = $state<InputFormState>({ values: {}, numbers: {} });
  let errors = $state<Record<string, string>>({});
  let usePinned = $state(true);
  let element = $state<HTMLFormElement | null>(null);

  // Fresh values every time the dialog opens, from the declared defaults.
  $effect(() => {
    if (!open) return;
    form = formState(inputs, initialValues(inputs));
    errors = {};
    usePinned = true;
    void tick().then(() => element?.querySelector<HTMLElement>('input, textarea, button[role="radio"], button[role="checkbox"]')?.focus());
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
    if (await onStart(result.values, { usePinnedData: pinned.length > 0 && usePinned })) open = false;
  }
</script>

<Dialog bind:open title={$t('Run {0}', [pipelineName || $t('pipeline')])} description={inputs.length ? $t('Agents receive these values as task context.') : undefined} size="md">
  <form bind:this={element} class="form" id="run-inputs-form" onsubmit={(event) => void submit(event)} novalidate>
    <InputFields {inputs} bind:form {errors} idPrefix="run-input" disabled={busy} onSubmitShortcut={() => void submit()} />
    <PinnedRunOption bind:checked={usePinned} steps={pinned} disabled={busy} />
  </form>
  {#snippet footer()}
    {#if inputs.length}<span class="hint">{$t('Ctrl+Enter to start')}</span>{/if}
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
