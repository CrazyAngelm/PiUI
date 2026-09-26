<script lang="ts">
  import { t } from '../locale/language';
  import type { GraphNode, GraphEdge } from './agentGraph';
  export let node: GraphNode;
  export let nodes: GraphNode[];
  export let edges: GraphEdge[];
  export let disabled = false;
  export let onchange: (change: Partial<GraphNode>) => void;
  $: sources = nodes.filter(source => edges.some(edge => edge.kind === 'result' && edge.from === source.id && edge.to === node.id));
  $: source = sources.find(source => source.id === node.condition?.sourceStepId);
  $: conditionField = source?.resultFields?.find(field => field.name === node.condition?.field);
  $: verdicts = node.resultFields?.filter(field => field.kind === 'boolean') ?? [];
  function conditionSource(id: string): void {
    onchange({ condition: id ? { sourceStepId: id, field: '', equals: true } : undefined });
  }
</script>
<section aria-label={$t('Flow')}>
  <h3>{$t('Flow')}</h3>
  {#each sources as source}
    {#if source.resultFields?.length}
      <fieldset disabled={disabled}><legend>{source.profile.name} · {$t('Input fields')}</legend><small>{$t('With no selection, the complete result is passed.')}</small>
        {#each source.resultFields as field}
          <label class="check"><input type="checkbox" checked={node.inputBindings?.some(binding => binding.sourceStepId === source.id && binding.field === field.name) ?? false} onchange={(event) => onchange({inputBindings:event.currentTarget.checked ? [...(node.inputBindings ?? []),{sourceStepId:source.id,field:field.name,name:field.name}] : (node.inputBindings ?? []).filter(binding => !(binding.sourceStepId === source.id && binding.field === field.name))})} />{field.name}</label>
          {#each node.inputBindings?.filter(binding => binding.sourceStepId === source.id && binding.field === field.name) ?? [] as binding}<label>{$t('Input name')}<input value={binding.name} oninput={(event) => onchange({inputBindings:node.inputBindings?.map(item => item === binding ? {...item,name:event.currentTarget.value} : item)})} /></label>{/each}
        {/each}
      </fieldset>
    {/if}
  {/each}
  <label class="check"><input type="checkbox" checked={node.requireApproval ?? false} {disabled} onchange={(event) => onchange({ requireApproval:event.currentTarget.checked })} />{$t('Accept result only after my approval')}</label>
  {#if node.executionMode !== 'callable'}
    <label>{$t('Run condition')}<select {disabled} value={node.condition?.sourceStepId ?? ''} onchange={(event) => conditionSource(event.currentTarget.value)}><option value="">{$t('All dependencies succeeded')}</option>{#each sources as source}<option value={source.id}>{source.profile.name}</option>{/each}</select></label>
    {#if node.condition}
      <label>{$t('Result field')}<select {disabled} value={node.condition.field} onchange={(event) => { if (node.condition) onchange({condition:{...node.condition,field:event.currentTarget.value,equals:source?.resultFields?.find(field => field.name === event.currentTarget.value)?.kind === 'boolean' ? true : ''}}); }}><option value="" disabled>{$t('Select field')}</option>{#each source?.resultFields?.filter(field => field.kind !== 'text-list') ?? [] as field}<option value={field.name}>{field.name}</option>{/each}</select></label>
      <label>{$t('Equals')}
        {#if conditionField?.kind === 'boolean'}<select {disabled} value={String(node.condition.equals)} onchange={(event) => node.condition && onchange({condition:{...node.condition,equals:event.currentTarget.value === 'true'}})}><option value="true">{$t("true")}</option><option value="false">{$t("false")}</option></select>
        {:else}<input {disabled} value={String(node.condition.equals)} oninput={(event) => node.condition && onchange({condition:{...node.condition,equals:conditionField?.kind === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value}})} />{/if}
      </label>
    {/if}
    <label>{$t('Review verdict')}<select {disabled} value={node.review?.field ?? ''} onchange={(event) => onchange({ review:event.currentTarget.value ? { field:event.currentTarget.value,retryFromStepId:node.review?.retryFromStepId ?? '',maxIterations:node.review?.maxIterations ?? 3 } : undefined })}><option value="">{$t('No revision loop')}</option>{#each verdicts as field}<option value={field.name}>{field.name}</option>{/each}</select></label>
    {#if node.review}
      <label>{$t('If false, return to')}<select {disabled} value={node.review.retryFromStepId} onchange={(event) => node.review && onchange({review:{...node.review,retryFromStepId:event.currentTarget.value}})}><option value="" disabled>{$t('Select agent')}</option>{#each nodes.filter(candidate => candidate.id !== node.id && candidate.executionMode !== 'callable') as candidate}<option value={candidate.id}>{candidate.profile.name}</option>{/each}</select></label>
      <label>{$t('Maximum rounds')}<input {disabled} type="number" min="1" max="20" step="1" inputmode="numeric" placeholder={$t('No limit')} value={node.review.maxIterations ?? ''} onchange={(event) => { if (!node.review) return; const raw = event.currentTarget.value.trim(); const limit = Number(raw); const { maxIterations: _previous, ...rest } = node.review; onchange({ review: raw === '' ? rest : { ...rest, maxIterations: Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 3 } }); }} /></label>
      <small>{$t('True accepts the review. False repeats the upstream work with feedback. After the maximum rounds a person decides; repeated identical feedback pauses scheduling.')}</small>
    {/if}
  {/if}
</section>
<style>
  fieldset { border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); display:grid; gap:var(--piui-space-2); }
  section,label { display:grid; gap:var(--piui-space-2); } section { gap:var(--piui-space-3); padding-block:var(--piui-space-3); border-top:1px solid var(--piui-border-subtle); } h3 { font-size:13px; margin:0; } label,small { font-size:12px; color:var(--piui-text-muted); } .check { display:flex; align-items:center; } select,input { min-width:0; color:var(--piui-text); background:var(--piui-surface-1); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); padding:var(--piui-space-2); } option { color:var(--piui-text); background:var(--piui-surface-1); }
</style>
