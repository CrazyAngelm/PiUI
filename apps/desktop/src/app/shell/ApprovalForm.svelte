<script lang="ts">
  import { t } from '../../features/locale/language';
  import type { WorkspaceApprovalField, WorkspaceApprovalForm } from '../../../../../contracts/workspace-v15';
  import type { ApprovalFieldIssue, ApprovalFormDraft } from '../../host-api/approvalForms';
  import { Checkbox, Field, Input } from '../../lib/ui';

  /**
   * Fields of a native form request (a Codex MCP elicitation). Labels and
   * descriptions are the MCP server's own text and are never translated.
   */
  interface Props {
    form: WorkspaceApprovalForm;
    draft: ApprovalFormDraft;
    issues: Record<string, ApprovalFieldIssue>;
    /** Unique per approval so labels and error messages stay bound to their inputs. */
    idPrefix: string;
    disabled?: boolean;
    onchange: (fieldId: string, value: string | boolean) => void;
  }
  let { form, draft, issues, idPrefix, disabled = false, onchange }: Props = $props();

  const PLACEHOLDERS: Record<string, string> = {
    email: 'name@example.com',
    uri: 'https://',
    date: 'YYYY-MM-DD',
    'date-time': 'YYYY-MM-DDThh:mm:ssZ',
  };

  function inputType(field: WorkspaceApprovalField): string {
    return field.type === 'text' && field.format === 'email' ? 'email' : field.type === 'text' && field.format === 'uri' ? 'url' : 'text';
  }

  function hint(field: WorkspaceApprovalField): string | undefined {
    if (field.type !== 'number') return field.description;
    const range =
      field.minimum !== undefined && field.maximum !== undefined
        ? $t('From {0} to {1}.', [field.minimum, field.maximum])
        : field.minimum !== undefined
          ? $t('{0} or more.', [field.minimum])
          : field.maximum !== undefined
            ? $t('{0} or less.', [field.maximum])
            : '';
    return [field.description, range].filter(Boolean).join(' ') || undefined;
  }
</script>

<div class="form" role="group" aria-label={$t('Requested values')}>
  {#each form.fields as field (field.id)}
    {@const id = `${idPrefix}-${field.id}`}
    {@const issue = issues[field.id]}
    {#if field.type === 'boolean'}
      <Checkbox
        label={field.label}
        description={field.description}
        checked={draft[field.id] === true}
        {disabled}
        onCheckedChange={(checked) => onchange(field.id, checked)}
      />
    {:else}
      <Field
        label={field.label}
        for={id}
        description={hint(field)}
        optionalLabel={field.required ? undefined : $t('optional')}
        error={issue ? $t(issue.message, issue.args) : undefined}
      >
        {#if field.type === 'choice'}
          <select
            {id}
            class="select"
            value={typeof draft[field.id] === 'string' ? draft[field.id] : ''}
            {disabled}
            aria-invalid={issue ? true : undefined}
            aria-required={field.required}
            onchange={(event) => onchange(field.id, event.currentTarget.value)}
          >
            <option value="">{field.required ? $t('Choose…') : $t('No answer')}</option>
            {#each field.options as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        {:else}
          <Input
            {id}
            size="sm"
            type={inputType(field)}
            inputmode={field.type === 'number' ? (field.integer ? 'numeric' : 'decimal') : undefined}
            placeholder={field.type === 'text' && field.format ? PLACEHOLDERS[field.format] : undefined}
            value={typeof draft[field.id] === 'string' ? String(draft[field.id]) : ''}
            invalid={issue !== undefined}
            aria-required={field.required}
            autocomplete="off"
            {disabled}
            oninput={(event) => onchange(field.id, event.currentTarget.value)}
          />
        {/if}
      </Field>
    {/if}
  {/each}
</div>

<style>
  .form {
    display: grid;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .select {
    height: var(--piui-control-sm);
    padding: 0 var(--piui-space-2);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font: inherit;
    font-size: var(--piui-text-sm);
  }
  .select:hover:not(:disabled) {
    border-color: var(--piui-border-strong);
  }
  .select:focus-visible {
    border-color: var(--piui-focus);
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-focus) 18%, transparent);
  }
  .select[aria-invalid='true'] {
    border-color: var(--piui-danger);
  }
  .select option {
    background: var(--piui-surface-1);
    color: var(--piui-text);
  }
</style>
