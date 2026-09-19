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

<section aria-label={$t('Result fields')}>
  <header><h3>{$t('Result fields')}</h3><button type="button" {disabled} onclick={() => onchange([...fields, { name: '', kind: 'text' }])}>{$t('Add field')}</button></header>
  {#if fields.length === 0}<p class="empty">{$t('Add fields for conditions and other agents.')}</p>{/if}
  {#each fields as field, index}
    <div class="field">
      <input aria-label={$t('Field name')} placeholder={$t('Field name')} value={field.name} {disabled} oninput={(event) => update(index, { name: event.currentTarget.value })} />
      <select aria-label={$t('Field type')} value={field.kind} {disabled} onchange={(event) => update(index, { kind: event.currentTarget.value as ResultField['kind'] })}>
        <option value="text">{$t('Text')}</option><option value="number">{$t('Number')}</option><option value="boolean">{$t('Boolean')}</option><option value="artifact">{$t('Artifact file')}</option><option value="text-list">{$t('Text list')}</option>
      </select>
      <button type="button" aria-label={`${$t('Remove field')} ${field.name}`} {disabled} onclick={() => onchange(fields.filter((_, position) => position !== index))}>×</button>
    </div>
  {/each}
  {#if fields.length}
    <details class="field-help"><summary>{$t('About result fields')}</summary><p>{$t('Missing or invalid fields can stop dependent tasks.')}</p></details>
  {/if}
</section>

<style>
  section { display:grid; gap:var(--piui-space-2); padding-block:var(--piui-space-3); border-block-start:1px solid var(--piui-border-subtle); }
  header,.field { display:flex; gap:var(--piui-space-2); align-items:center; }
  header { justify-content:space-between; } h3,p { margin:0; } h3 { font-size:13px; } p { font-size:12px; color:var(--piui-text-muted); }
  .field-help { border-top:1px solid var(--piui-border-subtle); padding-top:var(--piui-space-2); }.field-help summary { cursor:pointer; color:var(--piui-text-faint); font-size:11px; }.field-help p { margin-top:var(--piui-space-2); color:var(--piui-text-faint); font-size:11px; }.empty { color:var(--piui-text-muted); }
  input { min-width:0; flex:1; } select { min-width:0; max-width:45%; }
  input,select,button { background:var(--piui-surface-1); color:var(--piui-text); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); padding:var(--piui-space-2); }
  button { cursor:pointer; } :disabled { opacity:.6; } option { background:var(--piui-surface-1); color:var(--piui-text); }
</style>
