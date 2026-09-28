<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import LogOut from '@lucide/svelte/icons/log-out';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t } from '../../features/locale/language';
  import type { PipelineOutput } from '../../host-api/orchestrationClient';
  import { MAX_PIPELINE_OUTPUTS, SUBPIPELINE_ISSUES } from '../../host-api/subpipelines';
  import { Button, IconButton, Input } from '../../lib/ui';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import { inputNameFrom } from './inputs/runInputs';

  /**
   * The Output block's settings (v6.7, ADR-042): the results this pipeline
   * returns when another pipeline runs it as a sub-pipeline. Each output is
   * a named result field of one step, or that step's whole text. Typing
   * edits the draft live; leaving the panel records one undo step.
   */
  interface Props {
    editor: PipelineEditorStore;
    onClose: () => void;
  }
  let { editor, onClose }: Props = $props();

  const outputs = $derived(editor.graph.outputs ?? []);
  /** Callable roles return results only to their caller. */
  const sources = $derived(editor.graph.nodes.filter((node) => node.executionMode !== 'callable'));
  const problem = $derived(editor.issues.some((issue) => issue.message === SUBPIPELINE_ISSUES.outputs));

  function fieldsOf(stepId: string) {
    return editor.graph.nodes.find((node) => node.id === stepId)?.resultFields ?? [];
  }

  function stepName(stepId: string): string {
    const node = editor.graph.nodes.find((item) => item.id === stepId);
    return node?.profile.name || $t('Untitled agent');
  }

  function taken(except: number): Set<string> {
    return new Set(outputs.filter((_, index) => index !== except).map((output) => output.name));
  }

  function update(index: number, patch: Partial<PipelineOutput>): void {
    editor.setOutputs(outputs.map((output, position) => (position === index ? clean({ ...output, ...patch }) : output)), true);
  }

  /** An absent field is the whole result text, which is always `text`. */
  function clean(output: PipelineOutput): PipelineOutput {
    const { field, ...rest } = output;
    if (field === undefined || field === '') return { ...rest, kind: 'text' };
    const declared = fieldsOf(output.sourceStepId).find((item) => item.name === field);
    return { ...rest, field, kind: declared?.kind ?? output.kind };
  }

  function setSource(index: number, stepId: string): void {
    const current = outputs[index];
    if (!current) return;
    const keep = current.field !== undefined && fieldsOf(stepId).some((item) => item.name === current.field);
    update(index, { sourceStepId: stepId, field: keep ? current.field : undefined });
  }

  function setField(index: number, field: string): void {
    const current = outputs[index];
    if (!current) return;
    // A name that followed the old field follows the new one.
    const followed = current.name === (current.field ?? 'result') || current.name.startsWith('output');
    update(index, { field: field || undefined, ...(followed ? { name: inputNameFrom(field || 'result', taken(index)) } : {}) });
  }

  function add(): void {
    const last = [...sources].reverse().find((node) => !editor.graph.edges.some((edge) => edge.from === node.id && (edge.kind === 'result' || edge.kind === 'route')));
    const source = last ?? sources[0];
    if (!source) return;
    const field = source.resultFields?.[0];
    const name = inputNameFrom(field?.name ?? 'result', taken(-1));
    editor.setOutputs([...outputs, field ? { name, kind: field.kind, sourceStepId: source.id, field: field.name } : { name, kind: 'text', sourceStepId: source.id }]);
  }

  function remove(index: number): void {
    editor.setOutputs(outputs.filter((_, position) => position !== index));
  }
</script>

<aside class="panel" aria-labelledby="output-title" onfocusout={() => editor.settle()}>
  <header>
    <span class="mark" aria-hidden="true"><LogOut size={12} /></span>
    <h2 id="output-title">{$t('Output')}</h2>
    <span class="spacer"></span>
    <IconButton label={$t('Close output settings')} size="sm" onclick={onClose}><X /></IconButton>
  </header>
  <div class="body">
    <p class="note">{$t('What this pipeline returns when another pipeline runs it as a sub-pipeline. Without outputs, it returns the text of its last finished step.')}</p>
    {#if problem}
      <p class="problem" role="alert"><CircleAlert size={13} /> {$t(SUBPIPELINE_ISSUES.outputs)}</p>
    {/if}
    {#if outputs.length}
      <ul class="rows" aria-label={$t('Outputs')}>
        {#each outputs as output, index (index)}
          {@const fields = fieldsOf(output.sourceStepId)}
          <li class="row">
            <div class="row__head">
              <Input
                size="sm"
                value={output.name}
                aria-label={$t('Output name')}
                disabled={editor.readOnly}
                oninput={(event) => update(index, { name: event.currentTarget.value })}
              />
              <span class="kind" title={$t('Type')}>{output.kind}</span>
              <IconButton size="sm" label={$t('Remove output {0}', [output.name])} disabled={editor.readOnly} onclick={() => remove(index)}><Trash2 /></IconButton>
            </div>
            <div class="row__source">
              <label>
                <span>{$t('From step')}</span>
                <select class="select" value={output.sourceStepId} disabled={editor.readOnly} onchange={(event) => setSource(index, event.currentTarget.value)}>
                  {#if !sources.some((node) => node.id === output.sourceStepId)}
                    <option value={output.sourceStepId}>{$t('Missing step')}</option>
                  {/if}
                  {#each sources as node (node.id)}
                    <option value={node.id}>{stepName(node.id)}</option>
                  {/each}
                </select>
              </label>
              <label>
                <span>{$t('Value')}</span>
                <select class="select" value={output.field ?? ''} disabled={editor.readOnly} onchange={(event) => setField(index, event.currentTarget.value)}>
                  <option value="">{$t('Whole result text')}</option>
                  {#if output.field !== undefined && !fields.some((item) => item.name === output.field)}
                    <option value={output.field}>{output.field} · {$t('not declared')}</option>
                  {/if}
                  {#each fields as field (field.name)}
                    <option value={field.name}>{field.name} · {field.kind}</option>
                  {/each}
                </select>
              </label>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">{$t('No declared outputs')}</p>
    {/if}
    <Button size="sm" variant="secondary" disabled={editor.readOnly || sources.length === 0 || outputs.length >= MAX_PIPELINE_OUTPUTS} onclick={add}>
      {#snippet leading()}<Plus />{/snippet}
      {$t('Add output')}
    </Button>
  </div>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: none;
    width: clamp(320px, 26vw, 400px);
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 44px;
    padding: 0 var(--piui-space-2) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--piui-chaos-gold);
    color: var(--piui-bg);
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .spacer {
    flex: 1;
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  .body > :global(.btn) {
    justify-self: start;
  }
  .note,
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .problem {
    display: flex;
    gap: 6px;
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
  .rows {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .row__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .row__head > :global(:first-child) {
    flex: 1;
    min-width: 0;
  }
  .kind {
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .row__source {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--piui-space-2);
  }
  label {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  label span {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .select {
    width: 100%;
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font: inherit;
    font-size: var(--piui-text-sm);
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
