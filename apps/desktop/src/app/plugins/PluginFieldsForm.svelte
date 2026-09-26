<script lang="ts">
  import type { PluginFieldV1, PluginValue } from '../../../../../contracts/piui-plugin-v1';
  import { t } from '../../features/locale/language';
  import { VALUE_ISSUES, valueIssue } from '../../host-api/pluginManifest';
  import { Checkbox, Field, Input, Textarea } from '../../lib/ui';

  /**
   * A form PiUI renders from a plugin's declarative fields (its settings or
   * a node type's configuration). Plugins never render their own forms;
   * values are checked with the host's rules and problems stay next to the
   * field. Labels and descriptions are the plugin's own text.
   */
  interface Props {
    fields: readonly PluginFieldV1[];
    values: Readonly<Record<string, PluginValue>>;
    /** Prefix of element ids, unique on the page. */
    idPrefix: string;
    disabled?: boolean;
    onChange: (key: string, value: PluginValue | undefined) => void;
  }
  let { fields, values, idPrefix, disabled = false, onChange }: Props = $props();

  function issue(field: PluginFieldV1): string | undefined {
    const value = values[field.key];
    if (value === undefined || value === '') return field.required ? $t(VALUE_ISSUES.required, [field.label]) : undefined;
    const problem = valueIssue(field, value);
    return problem === undefined ? undefined : $t(VALUE_ISSUES[problem], [field.label]);
  }

  function numberValue(text: string): number | undefined {
    if (text.trim() === '') return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }

  const id = (field: PluginFieldV1): string => `${idPrefix}-${field.key}`;
</script>

<div class="fields">
  {#each fields as field (field.key)}
    {#if field.type === 'boolean'}
      <Checkbox
        label={field.label}
        description={field.description}
        checked={values[field.key] === true}
        {disabled}
        onCheckedChange={(checked) => onChange(field.key, checked)}
      />
    {:else}
      <Field label={field.label} for={id(field)} description={field.description} error={issue(field)} optionalLabel={field.required ? undefined : $t('optional')}>
        {#if field.type === 'long-text'}
          <Textarea
            id={id(field)}
            value={typeof values[field.key] === 'string' ? String(values[field.key]) : ''}
            minRows={3}
            maxRows={10}
            {disabled}
            invalid={issue(field) !== undefined}
            oninput={(event) => onChange(field.key, event.currentTarget.value)}
          />
        {:else if field.type === 'number'}
          <Input
            id={id(field)}
            type="number"
            inputmode="decimal"
            min={field.minimum}
            max={field.maximum}
            value={typeof values[field.key] === 'number' ? String(values[field.key]) : ''}
            {disabled}
            invalid={issue(field) !== undefined}
            oninput={(event) => onChange(field.key, numberValue(event.currentTarget.value))}
          />
        {:else if field.type === 'choice'}
          <select
            id={id(field)}
            class="select"
            value={typeof values[field.key] === 'string' ? String(values[field.key]) : ''}
            {disabled}
            onchange={(event) => onChange(field.key, event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
          >
            {#if !field.required || values[field.key] === undefined}<option value="">{$t('Not set')}</option>{/if}
            {#each field.options ?? [] as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        {:else}
          <Input
            id={id(field)}
            value={typeof values[field.key] === 'string' ? String(values[field.key]) : ''}
            maxlength={field.maxLength}
            {disabled}
            invalid={issue(field) !== undefined}
            oninput={(event) => onChange(field.key, event.currentTarget.value)}
          />
        {/if}
      </Field>
    {/if}
  {/each}
</div>

<style>
  .fields {
    display: grid;
    gap: var(--piui-space-4);
  }
  .select {
    height: var(--piui-control-md);
    padding: 0 var(--piui-space-2);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .select option {
    background: var(--piui-surface-1);
    color: var(--piui-text);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .select:disabled {
    opacity: 0.6;
  }
</style>
