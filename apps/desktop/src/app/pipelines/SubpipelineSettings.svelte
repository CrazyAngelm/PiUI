<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import { t } from '../../features/locale/language';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import type { PipelineInput, RunInputValue, SubpipelineInputSource } from '../../host-api/orchestrationClient';
  import { mappingProblems, outputFields, type PipelineExecutor } from '../../host-api/subpipelines';
  import { Button, Field, IconButton, Input, Picker, Switch, Textarea, type PickerItem } from '../../lib/ui';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import { INPUT_KIND_LABEL } from './inputs/runInputs';

  /**
   * The inspector of a sub-pipeline step (v6.7, ADR-042): which saved
   * pipeline it runs and where each of that pipeline's inputs comes from — a
   * fixed value, a run input of this pipeline or the result of a step
   * connected directly before it. The child runs as its own run with its
   * own team, approvals and history.
   */
  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
  }
  let { editor, node }: Props = $props();

  type Mode = 'unset' | SubpipelineInputSource['kind'];

  const executor = $derived<PipelineExecutor | undefined>(node.executor?.type === 'pipeline' ? node.executor : undefined);
  const child = $derived(executor ? editor.subpipelines.get(executor.launchCommandId) : undefined);
  const readOnly = $derived(editor.readOnly);
  const commandItems = $derived<PickerItem[]>(
    editor.systems
      .filter((item) => item.id !== editor.graph.id)
      .map((item) => ({ value: item.id, label: item.name || $t('Untitled pipeline') })),
  );
  const commandName = $derived(
    child?.name ?? editor.systems.find((item) => item.id === executor?.launchCommandId)?.name ?? '',
  );
  const parentInputs = $derived(editor.graph.inputs ?? []);
  const dependencies = $derived(
    editor.graph.edges
      .filter((edge) => (edge.kind === 'result' || edge.kind === 'route') && edge.to === node.id)
      .map((edge) => edge.from)
      .filter((id, index, all) => all.indexOf(id) === index),
  );
  const problems = $derived(
    executor ? mappingProblems(executor, child, parentInputs, dependencies, (id) => fieldsOf(id)) : [],
  );
  const unknownNames = $derived(
    executor && child ? Object.keys(executor.inputs).filter((name) => !child.inputs.some((input) => input.name === name)) : [],
  );
  const expectedFields = $derived(child ? outputFields(child.outputs) : []);
  const fieldsDiffer = $derived(JSON.stringify(expectedFields) !== JSON.stringify(node.resultFields ?? []));

  function fieldsOf(stepId: string) {
    return editor.graph.nodes.find((item) => item.id === stepId)?.resultFields ?? [];
  }

  function stepName(stepId: string): string {
    return editor.graph.nodes.find((item) => item.id === stepId)?.profile.name || $t('Untitled agent');
  }

  function problemsOf(name: string): string[] {
    return problems.filter((problem) => problem.input === name).map((problem) => problem.message);
  }

  function modeOf(name: string): Mode {
    return executor?.inputs[name]?.kind ?? 'unset';
  }

  function setSource(name: string, source: SubpipelineInputSource | undefined, live = false): void {
    if (!executor) return;
    const inputs = { ...executor.inputs };
    if (source === undefined) delete inputs[name];
    else inputs[name] = source;
    editor.updateNode(node.id, { executor: { ...executor, inputs } }, live);
  }

  function initialValue(input: PipelineInput): RunInputValue {
    if (input.defaultValue !== undefined) return input.defaultValue;
    if (input.kind === 'number') return 0;
    if (input.kind === 'boolean') return false;
    if (input.kind === 'choice') return input.options?.[0] ?? '';
    return '';
  }

  function setMode(input: PipelineInput, mode: Mode): void {
    if (mode === modeOf(input.name)) return;
    switch (mode) {
      case 'unset':
        setSource(input.name, undefined);
        return;
      case 'value':
        setSource(input.name, { kind: 'value', value: initialValue(input) });
        return;
      case 'input': {
        const same = parentInputs.find((candidate) => candidate.name === input.name) ?? parentInputs[0];
        setSource(input.name, { kind: 'input', name: same?.name ?? '' });
        return;
      }
      case 'step':
        setSource(input.name, { kind: 'step', stepId: dependencies[0] ?? '' });
        return;
      default: {
        const exhaustive: never = mode;
        return exhaustive;
      }
    }
  }

  function valueText(name: string): string {
    const source = executor?.inputs[name];
    return source?.kind === 'value' ? String(source.value) : '';
  }

  function setNumber(name: string, text: string): void {
    const value = Number(text.trim().replace(',', '.'));
    // A text that is not a number stays visible and is reported, never coerced.
    setSource(name, { kind: 'value', value: text.trim() !== '' && Number.isFinite(value) ? value : text }, true);
  }
</script>

{#if executor}
  <div class="subpipeline">
    <p class="note" role="note">
      <Info size={14} />
      <span>{$t('Runs a saved pipeline of this project as its own run, with its own agents, approvals and history. This step finishes when that run finishes.')}</span>
    </p>

    <Field label={$t('Pipeline to run')}>
      <Picker
        items={commandItems}
        value={executor.launchCommandId}
        label={$t('Pipeline to run')}
        searchPlaceholder={$t('Search pipelines')}
        emptyText={$t('No other saved pipelines')}
        width={320}
        onSelect={(id) => editor.setSubpipeline(node.id, id)}
      >
        {#snippet trigger(props)}
          <button type="button" class="select" {...props} disabled={readOnly}>
            <span class:placeholder={!commandName}>{commandName || $t('Choose a pipeline')}</span>
            <ChevronDown size={13} />
          </button>
        {/snippet}
      </Picker>
    </Field>
    {#if executor.launchCommandId}
      <Button size="sm" variant="secondary" onclick={() => editor.open(executor.launchCommandId)}>
        {#snippet leading()}<SquareArrowOutUpRight />{/snippet}
        {$t('Open pipeline')}
      </Button>
    {/if}

    {#if !executor.launchCommandId && node.pipelineName}
      <!-- A system file (v5) named a pipeline this project does not have: nothing was created. -->
      <p class="problem" role="alert">
        <CircleAlert size={12} />
        {$t('Pipeline “{0}” is not in this project. Pick a saved pipeline for this step.', [node.pipelineName])}
      </p>
    {/if}

    {#if executor.launchCommandId && !child}
      <p class="hint">
        {editor.systemsLoaded && !editor.systems.some((item) => item.id === executor.launchCommandId)
          ? $t('The pipeline this sub-pipeline step runs no longer exists.')
          : $t('Reading the pipeline…')}
      </p>
    {/if}

    {#if child}
      <section class="section" aria-labelledby="subpipeline-inputs-{node.id}">
        <h3 id="subpipeline-inputs-{node.id}">{$t('Inputs of {0}', [child.name])}</h3>
        {#if child.inputs.length === 0}
          <p class="hint">{$t('This pipeline asks for no inputs.')}</p>
        {/if}
        {#each child.inputs as input (input.name)}
          {@const mode = modeOf(input.name)}
          {@const source = executor.inputs[input.name]}
          {@const inputProblems = problemsOf(input.name)}
          {@const id = `subpipeline-${node.id}-${input.name}`}
          <div class="mapping" class:mapping--problem={inputProblems.length > 0} role="group" aria-labelledby="{id}-label">
            <div class="mapping__head">
              <span id="{id}-label" class="mapping__label">
                {input.label}{#if input.required}<span class="req" aria-label={$t('Required')}>*</span>{/if}
              </span>
              <span class="mapping__kind">{$t(INPUT_KIND_LABEL[input.kind])}</span>
            </div>
            <label class="control">
              <span>{$t('Value from')}</span>
              <select class="select select--native" value={mode} disabled={readOnly} onchange={(event) => setMode(input, event.currentTarget.value as Mode)}>
                <option value="unset">{input.defaultValue !== undefined ? $t('Default: {0}', [String(input.defaultValue)]) : $t('Not set')}</option>
                <option value="value">{$t('Fixed value')}</option>
                <option value="input" disabled={parentInputs.length === 0}>{$t('Run input of this pipeline')}</option>
                <option value="step" disabled={dependencies.length === 0}>{$t('Result of a connected step')}</option>
              </select>
            </label>
            {#if source?.kind === 'value'}
              {#if input.kind === 'long-text'}
                <Textarea
                  id="{id}-value"
                  aria-label={$t('Fixed value for {0}', [input.label])}
                  value={valueText(input.name)}
                  minRows={2}
                  maxRows={8}
                  disabled={readOnly}
                  oninput={(event) => setSource(input.name, { kind: 'value', value: event.currentTarget.value }, true)}
                  onblur={() => editor.settle()}
                />
              {:else if input.kind === 'text'}
                <Input
                  id="{id}-value"
                  aria-label={$t('Fixed value for {0}', [input.label])}
                  value={valueText(input.name)}
                  disabled={readOnly}
                  oninput={(event) => setSource(input.name, { kind: 'value', value: event.currentTarget.value }, true)}
                  onblur={() => editor.settle()}
                />
              {:else if input.kind === 'number'}
                <Input
                  id="{id}-value"
                  inputmode="decimal"
                  aria-label={$t('Fixed value for {0}', [input.label])}
                  value={valueText(input.name)}
                  disabled={readOnly}
                  oninput={(event) => setNumber(input.name, event.currentTarget.value)}
                  onblur={() => editor.settle()}
                />
              {:else if input.kind === 'boolean'}
                <Switch
                  label={$t('Fixed value for {0}', [input.label])}
                  checked={source.value === true}
                  disabled={readOnly}
                  onCheckedChange={(checked) => setSource(input.name, { kind: 'value', value: checked })}
                />
              {:else}
                <select
                  class="select select--native"
                  aria-label={$t('Fixed value for {0}', [input.label])}
                  value={typeof source.value === 'string' ? source.value : ''}
                  disabled={readOnly}
                  onchange={(event) => setSource(input.name, { kind: 'value', value: event.currentTarget.value })}
                >
                  {#each input.options ?? [] as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              {/if}
            {:else if source?.kind === 'input'}
              <select
                class="select select--native"
                aria-label={$t('Run input for {0}', [input.label])}
                value={source.name}
                disabled={readOnly}
                onchange={(event) => setSource(input.name, { kind: 'input', name: event.currentTarget.value })}
              >
                {#if !parentInputs.some((candidate) => candidate.name === source.name)}
                  <option value={source.name}>{source.name || $t('Choose…')}</option>
                {/if}
                {#each parentInputs as parent (parent.name)}
                  <option value={parent.name}>{parent.label} ({parent.name})</option>
                {/each}
              </select>
            {:else if source?.kind === 'step'}
              <div class="pair">
                <select
                  class="select select--native"
                  aria-label={$t('Source step for {0}', [input.label])}
                  value={source.stepId}
                  disabled={readOnly}
                  onchange={(event) => setSource(input.name, { kind: 'step', stepId: event.currentTarget.value })}
                >
                  {#if !dependencies.includes(source.stepId)}
                    <option value={source.stepId}>{source.stepId ? $t('Not connected') : $t('Choose…')}</option>
                  {/if}
                  {#each dependencies as dependency (dependency)}
                    <option value={dependency}>{stepName(dependency)}</option>
                  {/each}
                </select>
                <select
                  class="select select--native"
                  aria-label={$t('Result field for {0}', [input.label])}
                  value={source.field ?? ''}
                  disabled={readOnly}
                  onchange={(event) =>
                    setSource(input.name, {
                      kind: 'step',
                      stepId: source.stepId,
                      ...(event.currentTarget.value ? { field: event.currentTarget.value } : {}),
                    })}
                >
                  <option value="">{$t('Whole result text')}</option>
                  {#each fieldsOf(source.stepId) as field (field.name)}
                    <option value={field.name}>{field.name} · {field.kind}</option>
                  {/each}
                </select>
              </div>
            {/if}
            {#if input.description}<p class="hint">{input.description}</p>{/if}
            {#each inputProblems as problem (problem)}
              <p class="problem" role="alert"><CircleAlert size={12} /> {$t(problem)}</p>
            {/each}
          </div>
        {/each}
        {#each unknownNames as name (name)}
          <div class="mapping mapping--problem">
            <div class="mapping__head">
              <span class="mapping__label"><code>{name}</code></span>
              <IconButton size="sm" label={$t('Remove mapping {0}', [name])} disabled={readOnly} onclick={() => setSource(name, undefined)}><Trash2 /></IconButton>
            </div>
            <p class="problem" role="alert"><CircleAlert size={12} /> {$t('A mapped input is not declared by the sub-pipeline.')}</p>
          </div>
        {/each}
      </section>

      <section class="section" aria-labelledby="subpipeline-outputs-{node.id}">
        <h3 id="subpipeline-outputs-{node.id}">{$t('Result')}</h3>
        {#if child.outputs.length === 0}
          <p class="hint">{$t('This pipeline declares no outputs, so this step returns the text of its last finished step. Declare outputs on its Output block to return named fields.')}</p>
        {:else}
          <p class="hint">{$t('Its outputs become this step’s result fields: {0}.', [child.outputs.map((output) => `${output.name} (${output.kind})`).join(', ')])}</p>
        {/if}
        {#if fieldsDiffer}
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            onclick={() => editor.updateNode(node.id, { resultFields: expectedFields.length ? expectedFields : undefined })}
          >
            {$t('Use the pipeline’s outputs as result fields')}
          </Button>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  .subpipeline {
    display: grid;
    gap: var(--piui-space-4);
  }
  .subpipeline > :global(.btn) {
    justify-self: start;
  }
  .note {
    display: flex;
    gap: var(--piui-space-2);
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: 1.45;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .section {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .section > :global(.btn) {
    justify-self: start;
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .mapping {
    display: grid;
    gap: 6px;
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .mapping--problem {
    border-color: var(--piui-danger-border);
  }
  .mapping__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .mapping__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mapping__kind {
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .req {
    margin-left: 2px;
    color: var(--piui-danger);
  }
  .control {
    display: grid;
    gap: 2px;
  }
  .control span {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--piui-space-2);
  }
  .problem {
    display: flex;
    gap: 4px;
    margin: 0;
    color: var(--piui-danger-text);
    font-size: var(--piui-text-xs);
  }
  .problem :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .select {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--piui-control-md);
    padding: 0 10px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    text-align: left;
  }
  .select span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .select:hover:not(:disabled) {
    border-color: var(--piui-border-strong);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .select--native {
    height: 28px;
    padding: 0 6px;
    font: inherit;
    font-size: var(--piui-text-sm);
  }
  .select--native option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .placeholder {
    color: var(--piui-text-disabled);
  }
</style>
