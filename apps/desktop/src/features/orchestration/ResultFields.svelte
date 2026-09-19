<script lang="ts">
  import type { ResultField } from '../../../../../contracts/orchestration-v6';
  import { t } from '../locale/language';
  export let fields: readonly ResultField[] = [];
  export let disabled = false;
  export let onchange: (fields: ResultField[]) => void;
  function update(index: number, change: Partial<ResultField>): void {
    onchange(fields.map((field, position) => position === index ? { ...field, ...change } : field));
  }
</script>

<section aria-label={$t('Result contract')}>
  <header><h3>{$t('Result contract')}</h3><button type="button" {disabled} onclick={() => onchange([...fields, { name: '', kind: 'text' }])}>{$t('Add field')}</button></header>
  <p>{$t(fields.length ? 'The final JSON result must contain these fields. Missing or invalid data blocks dependent tasks.' : 'Free-form result. Add fields when another agent needs structured data.')}</p>
  {#if fields.length}<small>{$t('These names become JSON keys that conditions and routes can read.')}</small>{/if}
  {#each fields as field, index}
    <div class="field">
      <input aria-label={$t('Field name')} placeholder={$t('Field name')} value={field.name} {disabled} oninput={(event) => update(index, { name: event.currentTarget.value })} />
      <select aria-label={$t('Field type')} value={field.kind} {disabled} onchange={(event) => update(index, { kind: event.currentTarget.value as ResultField['kind'] })}>
        <option value="text">{$t('Text')}</option><option value="number">{$t('Number')}</option><option value="boolean">{$t('Boolean')}</option><option value="artifact">{$t('Artifact file')}</option><option value="text-list">{$t('Text list')}</option>
      </select>
      <button type="button" aria-label={`${$t('Remove field')} ${field.name}`} {disabled} onclick={() => onchange(fields.filter((_, position) => position !== index))}>×</button>
    </div>
  {/each}
</section>

<style>
  section { display:grid; gap:var(--piui-space-2); padding-block:var(--piui-space-3); border-block-start:1px solid var(--piui-border-subtle); }
  header,.field { display:flex; gap:var(--piui-space-2); align-items:center; }
  header { justify-content:space-between; } h3,p,small { margin:0; } h3 { font-size:13px; } p,small { font-size:12px; color:var(--piui-text-muted); } small { font-size:11px; color:var(--piui-text-faint); }
  input { min-width:0; flex:1; } select { min-width:0; max-width:45%; }
  input,select,button { background:var(--piui-surface-1); color:var(--piui-text); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); padding:var(--piui-space-2); }
  button { cursor:pointer; } :disabled { opacity:.6; } option { background:var(--piui-surface-1); color:var(--piui-text); }
</style>
