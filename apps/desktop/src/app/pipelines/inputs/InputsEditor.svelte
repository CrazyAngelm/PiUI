<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import { t } from '../../../features/locale/language';
  import type { PipelineInput, PipelineInputKind, RunInputValue } from '../../../host-api/orchestrationClient';
  import { Button, Field, IconButton, Input, Switch, Textarea } from '../../../lib/ui';
  import { INPUT_KINDS, INPUT_KIND_LABEL, declarationProblems, inputNameFrom, taskInput } from './runInputs';

  interface Props {
    inputs: readonly PipelineInput[];
    readOnly?: boolean;
    onChange: (inputs: PipelineInput[]) => void;
  }
  let { inputs, readOnly = false, onChange }: Props = $props();

  const problems = $derived(declarationProblems(inputs));

  function update(index: number, patch: Partial<PipelineInput>): void {
    onChange(inputs.map((input, position) => (position === index ? clean({ ...input, ...patch }) : input)));
  }

  /** Drop fields that no longer apply to the kind so the host never sees them. */
  function clean(input: PipelineInput): PipelineInput {
    const next: { -readonly [K in keyof PipelineInput]: PipelineInput[K] } = { ...input };
    if (next.kind !== 'choice') delete next.options;
    if (!next.description?.trim()) delete next.description;
    if (!next.required) delete next.required;
    if (next.defaultValue === undefined || next.defaultValue === '') delete next.defaultValue;
    return next;
  }

  function relabel(index: number, label: string): void {
    const current = inputs[index];
    if (!current) return;
    const taken = new Set(inputs.filter((_, position) => position !== index).map((input) => input.name));
    const auto = inputNameFrom(current.label, taken) === current.name || current.name.startsWith('input');
    update(index, auto ? { label, name: inputNameFrom(label, taken) } : { label });
  }

  function setKind(index: number, kind: PipelineInputKind): void {
    const current = inputs[index];
    if (!current || current.kind === kind) return;
    update(index, { kind, defaultValue: undefined, options: kind === 'choice' ? (current.options ?? [$t('Option 1')]) : undefined });
  }

  function add(): void {
    const taken = new Set(inputs.map((input) => input.name));
    const label = inputs.length === 0 ? $t('What should the pipeline do?') : $t('New input');
    const next: PipelineInput = inputs.length === 0 ? taskInput(label) : { name: inputNameFrom(label, taken), label, kind: 'text' };
    onChange([...inputs, next]);
  }

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= inputs.length) return;
    const next = [...inputs];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  function defaultText(value: RunInputValue | undefined): string {
    return value === undefined ? '' : String(value);
  }

  function parseDefault(input: PipelineInput, text: string): RunInputValue | undefined {
    if (!text.trim()) return undefined;
    if (input.kind === 'number') {
      const value = Number(text.replace(',', '.'));
      return Number.isFinite(value) ? value : text;
    }
    return text;
  }
</script>

<div class="inputs">
  <p class="lead">
    {$t('Asked every time the pipeline starts. Agents receive the values as task context; write {{input.name}} in a task to insert one.')}
  </p>

  {#if inputs.length === 0}
    <div class="empty">
      <p>{$t('No inputs: the pipeline starts right away with the tasks written in its nodes.')}</p>
      {#if !readOnly}
        <Button size="sm" variant="primary" onclick={add}>
          {#snippet leading()}<Plus />{/snippet}
          {$t('Ask for a task when starting')}
        </Button>
      {/if}
    </div>
  {:else}
    <ol class="list">
      {#each inputs as input, index (index)}
        {@const own = problems.filter((problem) => problem.index === index)}
        <li class="card" class:card--problem={own.length > 0}>
          <div class="card__head">
            <span class="card__index">{index + 1}</span>
            <code class="card__name" title={$t('Use {{input.{0}}} in a task', [input.name])}>{`{{input.${input.name}}}`}</code>
            {#if !readOnly}
              <span class="card__actions">
                <IconButton size="sm" label={$t('Move up')} disabled={index === 0} onclick={() => move(index, -1)}><ArrowUp /></IconButton>
                <IconButton size="sm" label={$t('Move down')} disabled={index === inputs.length - 1} onclick={() => move(index, 1)}><ArrowDown /></IconButton>
                <IconButton size="sm" label={$t('Remove input')} onclick={() => onChange(inputs.filter((_, position) => position !== index))}><Trash2 /></IconButton>
              </span>
            {/if}
          </div>
          <Field label={$t('Question')} for={`input-label-${index}`}>
            <Input id={`input-label-${index}`} size="sm" value={input.label} disabled={readOnly} oninput={(event) => relabel(index, event.currentTarget.value)} />
          </Field>
          <div class="row">
            <Field label={$t('Answer type')} for={`input-kind-${index}`}>
              <select id={`input-kind-${index}`} class="select" value={input.kind} disabled={readOnly} onchange={(event) => setKind(index, event.currentTarget.value as PipelineInputKind)}>
                {#each INPUT_KINDS as kind (kind)}
                  <option value={kind}>{$t(INPUT_KIND_LABEL[kind])}</option>
                {/each}
              </select>
            </Field>
            <div class="row__switch">
              <Switch label={$t('Required')} checked={!!input.required} disabled={readOnly} onCheckedChange={(checked) => update(index, { required: checked })} />
            </div>
          </div>
          {#if input.kind === 'choice'}
            <Field label={$t('Options, one per line')} for={`input-options-${index}`}>
              <Textarea
                id={`input-options-${index}`}
                minRows={2}
                maxRows={8}
                value={(input.options ?? []).join('\n')}
                disabled={readOnly}
                oninput={(event) => update(index, { options: event.currentTarget.value.split('\n').map((option) => option.trim()).filter(Boolean) })}
              />
            </Field>
          {/if}
          {#if input.kind !== 'boolean'}
            <Field label={$t('Default')} for={`input-default-${index}`} optionalLabel={$t('optional')}>
              <Input
                id={`input-default-${index}`}
                size="sm"
                value={defaultText(input.defaultValue)}
                disabled={readOnly}
                oninput={(event) => update(index, { defaultValue: parseDefault(input, event.currentTarget.value) })}
              />
            </Field>
          {/if}
          <Field label={$t('Hint for the person starting the run')} for={`input-description-${index}`} optionalLabel={$t('optional')}>
            <Input id={`input-description-${index}`} size="sm" value={input.description ?? ''} disabled={readOnly} oninput={(event) => update(index, { description: event.currentTarget.value })} />
          </Field>
          <details class="advanced">
            <summary>{$t('Name in templates')}</summary>
            <Input size="sm" value={input.name} disabled={readOnly} aria-label={$t('Name in templates')} oninput={(event) => update(index, { name: event.currentTarget.value.trim() })} />
          </details>
          {#each own as problem (problem.message)}
            <p class="problem" role="alert">{$t(problem.message)}</p>
          {/each}
        </li>
      {/each}
    </ol>
    {#if !readOnly}
      <Button size="sm" onclick={add} disabled={inputs.length >= 20}>
        {#snippet leading()}<Plus />{/snippet}
        {$t('Add input')}
      </Button>
    {/if}
  {/if}
</div>

<style>
  .inputs {
    display: grid;
    gap: var(--piui-space-3);
  }
  .lead {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .empty {
    display: grid;
    justify-items: start;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-md);
  }
  .empty p {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .list {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .card--problem {
    border-color: var(--piui-danger-border);
  }
  .card__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .card__index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .card__name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card__actions {
    display: inline-flex;
    gap: 2px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--piui-space-3);
  }
  .row__switch {
    padding-bottom: 6px;
  }
  .select {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .advanced summary {
    cursor: pointer;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .advanced :global(.input) {
    margin-top: 6px;
  }
  .problem {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
