<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import { tick } from 'svelte';
  import { t } from '../../../features/locale/language';
  import type { PipelineInput, RunInputValue } from '../../../host-api/orchestrationClient';
  import { Button, Dialog, Field, Input, Segmented, Switch, Textarea } from '../../../lib/ui';
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

  let raw = $state<Record<string, RunInputValue | undefined>>({});
  let numbers = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let form = $state<HTMLFormElement | null>(null);

  // Fresh values every time the dialog opens, from the declared defaults.
  $effect(() => {
    if (!open) return;
    raw = initialValues(inputs);
    numbers = Object.fromEntries(inputs.filter((input) => input.kind === 'number').map((input) => [input.name, input.defaultValue === undefined ? '' : String(input.defaultValue)]));
    errors = {};
    void tick().then(() => form?.querySelector<HTMLElement>('input, textarea, button[role="radio"]')?.focus());
  });

  function text(name: string): string {
    const value = raw[name];
    return typeof value === 'string' ? value : '';
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const merged: Record<string, RunInputValue | undefined> = { ...raw };
    for (const input of inputs) {
      if (input.kind !== 'number') continue;
      const entry = (numbers[input.name] ?? '').trim();
      merged[input.name] = entry === '' ? undefined : Number(entry.replace(',', '.'));
    }
    const result = checkValues(inputs, merged);
    errors = result.errors;
    if (Object.keys(result.errors).length) {
      await tick();
      form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    if (await onStart(result.values)) open = false;
  }
</script>

<Dialog bind:open title={$t('Run {0}', [pipelineName || $t('pipeline')])} description={$t('Agents receive these values as task context.')} size="md">
  <form bind:this={form} class="form" id="run-inputs-form" onsubmit={(event) => void submit(event)} novalidate>
    {#each inputs as input (input.name)}
      {@const id = `run-input-${input.name}`}
      <Field label={input.label} for={id} description={input.description} error={errors[input.name] ? $t(errors[input.name]!) : undefined} optionalLabel={input.required ? undefined : $t('optional')}>
        {#if input.kind === 'long-text'}
          <Textarea
            {id}
            value={text(input.name)}
            minRows={4}
            maxRows={14}
            invalid={!!errors[input.name]}
            aria-invalid={errors[input.name] ? 'true' : undefined}
            oninput={(event) => (raw = { ...raw, [input.name]: event.currentTarget.value })}
            onkeydown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form?.requestSubmit();
            }}
          />
        {:else if input.kind === 'text'}
          <Input
            {id}
            value={text(input.name)}
            invalid={!!errors[input.name]}
            aria-invalid={errors[input.name] ? 'true' : undefined}
            oninput={(event) => (raw = { ...raw, [input.name]: event.currentTarget.value })}
          />
        {:else if input.kind === 'number'}
          <Input
            {id}
            inputmode="decimal"
            value={numbers[input.name] ?? ''}
            invalid={!!errors[input.name]}
            aria-invalid={errors[input.name] ? 'true' : undefined}
            oninput={(event) => (numbers = { ...numbers, [input.name]: event.currentTarget.value })}
          />
        {:else if input.kind === 'boolean'}
          <Switch {id} label={input.label} hideLabel checked={raw[input.name] === true} onCheckedChange={(checked) => (raw = { ...raw, [input.name]: checked })} />
        {:else if (input.options?.length ?? 0) <= 4}
          <Segmented
            label={input.label}
            value={typeof raw[input.name] === 'string' ? (raw[input.name] as string) : ''}
            options={(input.options ?? []).map((option) => ({ value: option, label: option }))}
            onValueChange={(value) => (raw = { ...raw, [input.name]: value })}
          />
        {:else}
          <select
            {id}
            class="select"
            aria-invalid={errors[input.name] ? 'true' : undefined}
            value={typeof raw[input.name] === 'string' ? raw[input.name] : ''}
            onchange={(event) => (raw = { ...raw, [input.name]: event.currentTarget.value || undefined })}
          >
            <option value="">{$t('Choose…')}</option>
            {#each input.options ?? [] as option (option)}
              <option value={option}>{option}</option>
            {/each}
          </select>
        {/if}
      </Field>
    {/each}
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
  .select {
    height: var(--piui-control-md, 32px);
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
  }
  .select[aria-invalid='true'] {
    border-color: var(--piui-danger);
  }
  .hint {
    margin-right: auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
</style>
