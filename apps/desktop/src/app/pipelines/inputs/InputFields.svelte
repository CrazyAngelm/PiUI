<script lang="ts" module>
  import type { PipelineInput, RunInputValue } from '../../../host-api/orchestrationClient';

  /** Raw form state: numbers stay text until submit so typing is not coerced. */
  export interface InputFormState {
    values: Record<string, RunInputValue | undefined>;
    numbers: Record<string, string>;
  }

  export function formState(inputs: readonly PipelineInput[], values: Readonly<Record<string, RunInputValue | undefined>>): InputFormState {
    return {
      values: { ...values },
      numbers: Object.fromEntries(
        inputs.filter((input) => input.kind === 'number').map((input) => [input.name, values[input.name] === undefined ? '' : String(values[input.name])]),
      ),
    };
  }

  /** Form state -> raw values for `checkValues`. */
  export function formValues(inputs: readonly PipelineInput[], state: InputFormState): Record<string, RunInputValue | undefined> {
    const merged: Record<string, RunInputValue | undefined> = { ...state.values };
    for (const input of inputs) {
      if (input.kind !== 'number') continue;
      const entry = (state.numbers[input.name] ?? '').trim();
      merged[input.name] = entry === '' ? undefined : Number(entry.replace(',', '.'));
    }
    return merged;
  }
</script>

<script lang="ts">
  import { t } from '../../../features/locale/language';
  import { Field, Input, Segmented, Switch, Textarea } from '../../../lib/ui';

  interface Props {
    inputs: readonly PipelineInput[];
    form: InputFormState;
    errors: Readonly<Record<string, string>>;
    idPrefix: string;
    disabled?: boolean;
    onSubmitShortcut?: () => void;
  }
  let { inputs, form = $bindable(), errors, idPrefix, disabled = false, onSubmitShortcut }: Props = $props();

  function text(name: string): string {
    const value = form.values[name];
    return typeof value === 'string' ? value : '';
  }
  function set(name: string, value: RunInputValue | undefined): void {
    form = { ...form, values: { ...form.values, [name]: value } };
  }
</script>

{#each inputs as input (input.name)}
  {@const id = `${idPrefix}-${input.name}`}
  {@const error = errors[input.name]}
  <Field label={input.label} for={id} description={input.description} error={error ? $t(error) : undefined} optionalLabel={input.required ? undefined : $t('optional')}>
    {#if input.kind === 'long-text'}
      <Textarea
        {id}
        value={text(input.name)}
        minRows={4}
        maxRows={14}
        {disabled}
        invalid={!!error}
        aria-invalid={error ? 'true' : undefined}
        oninput={(event) => set(input.name, event.currentTarget.value)}
        onkeydown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onSubmitShortcut?.();
        }}
      />
    {:else if input.kind === 'text'}
      <Input {id} value={text(input.name)} {disabled} invalid={!!error} aria-invalid={error ? 'true' : undefined} oninput={(event) => set(input.name, event.currentTarget.value)} />
    {:else if input.kind === 'number'}
      <Input
        {id}
        inputmode="decimal"
        value={form.numbers[input.name] ?? ''}
        {disabled}
        invalid={!!error}
        aria-invalid={error ? 'true' : undefined}
        oninput={(event) => (form = { ...form, numbers: { ...form.numbers, [input.name]: event.currentTarget.value } })}
      />
    {:else if input.kind === 'boolean'}
      <Switch {id} label={input.label} hideLabel {disabled} checked={form.values[input.name] === true} onCheckedChange={(checked) => set(input.name, checked)} />
    {:else if (input.options?.length ?? 0) <= 4}
      <Segmented
        label={input.label}
        value={typeof form.values[input.name] === 'string' ? (form.values[input.name] as string) : ''}
        options={(input.options ?? []).map((option) => ({ value: option, label: option }))}
        onValueChange={(value) => set(input.name, value)}
      />
    {:else}
      <select
        {id}
        class="select"
        {disabled}
        aria-invalid={error ? 'true' : undefined}
        value={typeof form.values[input.name] === 'string' ? form.values[input.name] : ''}
        onchange={(event) => set(input.name, event.currentTarget.value || undefined)}
      >
        <option value="">{$t('Choose…')}</option>
        {#each input.options ?? [] as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {/if}
  </Field>
{/each}

<style>
  .select {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .select[aria-invalid='true'] {
    border-color: var(--piui-danger);
  }
</style>
