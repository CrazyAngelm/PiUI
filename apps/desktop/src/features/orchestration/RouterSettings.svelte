<script lang="ts">
  import { t } from '../locale/language';
  import type { RouterBranch, RouterConfig, RouterPredicate } from '../../../../../contracts/orchestration-v6';
  import type { GraphNode } from './agentGraph';

  export let node: GraphNode;
  export let nodes: GraphNode[] = [];
  export let disabled = false;
  export let onchange: (change: Partial<GraphNode>) => void;

  let router: RouterConfig;
  $: router = node.router ?? { mode: 'program', inputStepId: '', branches: [] };
  $: sources = nodes.filter(candidate => candidate.id !== node.id && candidate.kind !== 'router');
  $: input = nodes.find(candidate => candidate.id === router.inputStepId);
  $: fields = input?.resultFields ?? [];

  function update(change: Partial<RouterConfig>): void {
    onchange({ router: { ...router, ...change } });
  }
  function updateBranch(index: number, change: Partial<RouterBranch>): void {
    update({ branches: router.branches.map((branch, position) => position === index ? { ...branch, ...change } : branch) });
  }
  function predicate(branch: RouterBranch): RouterPredicate {
    return branch.predicate ?? { op: 'exists', field: '' };
  }
  function setOperator(index: number, op: RouterPredicate['op']): void {
    const branch = router.branches[index];
    if (!branch) return;
    const field = fields[0]?.name ?? '';
    const simple: RouterPredicate = { op: 'exists', field };
    const next: RouterPredicate = op === 'equals'
      ? { op, field, value: fields[0]?.kind === 'boolean' ? true : fields[0]?.kind === 'number' ? 0 : '' }
      : op === 'exists'
        ? simple
        : op === 'not'
          ? { op, predicate: simple }
          : { op, predicates: [simple] };
    updateBranch(index, { predicate: next });
  }
  function setPredicateField(index: number, field: string): void {
    const branch = router.branches[index];
    if (!branch || !branch.predicate || !('field' in branch.predicate)) return;
    const next = branch.predicate.op === 'equals'
      ? { ...branch.predicate, field, value: fields.find(item => item.name === field)?.kind === 'boolean' ? true : fields.find(item => item.name === field)?.kind === 'number' ? 0 : '' }
      : { ...branch.predicate, field };
    updateBranch(index, { predicate: next });
  }
  function setPredicateValue(index: number, value: string): void {
    const branch = router.branches;
    const current = branch[index]?.predicate;
    if (!current || current.op !== 'equals') return;
    const field = fields.find(item => item.name === current.field);
    const parsed = field?.kind === 'number' ? Number(value) : field?.kind === 'boolean' ? value === 'true' : value;
    updateBranch(index, { predicate: { ...current, value: parsed } });
  }
  function addBranch(): void {
    const index = router.branches.length;
    update({ branches: [...router.branches, { id: crypto.randomUUID(), label: `Route ${index + 1}`, ...(router.mode === 'program' ? { predicate: { op: 'exists', field: fields[0]?.name ?? '' } as RouterPredicate } : {}) }] });
  }
  function removeBranch(index: number): void {
    if (router.branches.length <= 1) return;
    update({ branches: router.branches.filter((_, position) => position !== index) });
  }
</script>

<section class="router-settings" aria-label={$t('Router settings')}>
  <div class="section-heading"><div><h3>{$t('Router')}</h3><small>{$t('Select one or more downstream routes from one structured input.')}</small></div><span class="router-badge">{$t(router.mode === 'program' ? 'Program' : 'Agent')}</span></div>
  <label>{$t('Routing mode')}<select value={router.mode} {disabled} onchange={(event) => { const mode = event.currentTarget.value as RouterConfig['mode']; update({ mode, selectionField: mode === 'agent' ? router.selectionField ?? 'selectedBranchIds' : undefined, branches: router.branches.map(branch => ({ ...branch, ...(mode === 'program' ? { predicate: branch.predicate ?? { op: 'exists', field: fields[0]?.name ?? '' } } : { predicate: undefined }) })) }); }}><option value="program">{$t('Programmatic')}</option><option value="agent">{$t('Agent decides')}</option></select></label>
  <label>{$t('Input agent')}<select value={router.inputStepId} {disabled} onchange={(event) => update({ inputStepId: event.currentTarget.value })}><option value="">{$t('Select upstream result')}</option>{#each sources as source}<option value={source.id}>{source.profile.name}</option>{/each}</select></label>
  {#if router.mode === 'agent'}
    <label>{$t('Selection field')}<input value={router.selectionField ?? 'selectedBranchIds'} {disabled} oninput={(event) => update({ selectionField: event.currentTarget.value })} /></label>
    <small>{$t('The agent must return an array of branch IDs. An empty array skips every route.')}</small>
  {/if}
  <div class="branch-list">
    <div class="section-heading"><h4>{$t('Routes')}</h4><button type="button" {disabled} onclick={addBranch}>＋ {$t('Add route')}</button></div>
    {#each router.branches as branch, index (branch.id)}
      <article class="branch">
        <div class="branch-heading"><span class="branch-index">{index + 1}</span><input aria-label={`${$t('Route')} ${index + 1}`} value={branch.label} {disabled} oninput={(event) => updateBranch(index, { label: event.currentTarget.value })} /><button type="button" aria-label={`${$t('Remove route')} ${index + 1}`} disabled={disabled || router.branches.length <= 1} onclick={() => removeBranch(index)}>×</button></div>
        {#if router.mode === 'program'}
          {@const current = predicate(branch)}
          <label>{$t('Rule')}<select value={current.op} disabled={disabled || !(['equals', 'exists'].includes(current.op))} onchange={(event) => setOperator(index, event.currentTarget.value as RouterPredicate['op'])}><option value="equals">{$t('Equals')}</option><option value="exists">{$t('Exists')}</option><option value="all">{$t('All conditions')}</option><option value="any">{$t('Any condition')}</option><option value="not">{$t('Negated condition')}</option></select></label>
          {#if current.op === 'equals' || current.op === 'exists'}<label>{$t('Field')}<select value={'field' in current ? current.field : ''} {disabled} onchange={(event) => setPredicateField(index, event.currentTarget.value)}><option value="">{$t('Select field')}</option>{#each fields as field}<option value={field.name}>{field.name} · {field.kind}</option>{/each}</select></label>{:else}<code class="advanced-predicate">{$t('Advanced predicate')}: {JSON.stringify(current)}</code>{/if}
          {#if current.op === 'equals'}
            <label>{$t('Expected value')}{#if fields.find(field => field.name === current.field)?.kind === 'boolean'}<select value={String(current.value)} {disabled} onchange={(event) => setPredicateValue(index, event.currentTarget.value)}><option value="true">{$t('true')}</option><option value="false">{$t('false')}</option></select>{:else}<input value={String(current.value)} {disabled} oninput={(event) => setPredicateValue(index, event.currentTarget.value)} />{/if}</label>
          {/if}
        {:else}
          <label>{$t('Route description')}<textarea rows="2" value={branch.description ?? ''} {disabled} oninput={(event) => updateBranch(index, { description: event.currentTarget.value })} placeholder={$t('When should this route run?')}></textarea></label>
        {/if}
        <code>{branch.id}</code>
      </article>
    {/each}
  </div>
</section>

<style>
  section { display:grid; gap:var(--piui-space-3); padding-block:var(--piui-space-3); border-top:1px solid var(--piui-border-subtle); }
  .section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--piui-space-2); }
  h3,h4 { margin:0; } h3 { font-size:14px; } h4 { font-size:12px; }
  small { display:block; color:var(--piui-text-faint); font-size:11px; line-height:1.45; }
  label { display:grid; gap:5px; font-size:12px; color:var(--piui-text-muted); }
  input,select,textarea,button { font:inherit; min-width:0; color:var(--piui-text); background:var(--piui-surface-1); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); padding:var(--piui-space-2); }
  button { cursor:pointer; } button:disabled { opacity:.55; cursor:default; }
  .router-badge { flex:0 0 auto; padding:3px 7px; border-radius:999px; color:var(--piui-accent); background:var(--piui-accent-soft); font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
  .branch-list { display:grid; gap:var(--piui-space-2); }
  .branch-list > .section-heading { align-items:center; }
  .branch { display:grid; gap:var(--piui-space-2); padding:10px; border:1px solid var(--piui-border-subtle); border-radius:var(--piui-radius-sm); background:var(--piui-bg); }
  .branch-heading { display:flex; align-items:center; gap:6px; } .branch-heading input { flex:1; font-weight:600; } .branch-heading button { border:0; background:transparent; padding:3px 6px; }
  .branch-index { display:grid; place-items:center; width:20px; height:20px; border-radius:50%; color:var(--piui-action-ink); background:var(--piui-action); font-size:10px; font-weight:700; }
  code { overflow:hidden; text-overflow:ellipsis; color:var(--piui-text-faint); font:10px ui-monospace,monospace; } .advanced-predicate { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.4; }
</style>
