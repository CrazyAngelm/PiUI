<script lang="ts">
  import { t } from '../locale/language';
  import type { AgentProfile } from '../../../../../contracts/orchestration-v5';
  import type { HarnessResource } from '../../../../../contracts/harness-models-v18';
  export let profile: AgentProfile;
  export let items: HarnessResource[] = [];
  export let disabled = false;
  export let loading = false;
  export let onchange: (patch: Partial<AgentProfile>) => void;
  let kind: HarnessResource['kind'] = 'skill';
  $: visible = items.filter(item => item.kind === kind);
  function enabled(item: HarnessResource): boolean {
    return item.kind === 'tool'
      ? (profile.toolPolicy.rules.find(rule => rule.tool === item.id && rule.enforcement === 'native')?.decision ?? (item.enabled ? 'allow' : 'deny')) === 'allow'
      : profile.resourceRules?.find(rule => rule.id === item.id && rule.kind === item.kind)?.enabled ?? item.enabled;
  }
  function toggle(item: HarnessResource, checked: boolean): void {
    if (!item.configurable || disabled) return;
    if (item.kind === 'tool') {
      const tools = items.filter(entry => entry.kind === 'tool' && entry.configurable);
      const retained = profile.toolPolicy.rules.filter(rule => rule.enforcement !== 'native' || !tools.some(tool => tool.id === rule.tool));
      onchange({ toolPolicy: { rules: [...retained, ...tools.map(tool => ({ tool: tool.id, decision: (tool.id === item.id ? checked : enabled(tool)) ? 'allow' as const : 'deny' as const, enforcement: 'native' as const, mandatory: true }))] } });
    } else onchange({ resourceRules: [...(profile.resourceRules ?? []).filter(rule => rule.id !== item.id || rule.kind !== item.kind), { kind: item.kind, id: item.id, enabled: checked }] });
  }
</script>

<section class="resources" aria-label={$t('Agent resources')}>
  <nav aria-label={$t('Resource category')}>{#each [['skill','Skills'],['mcp','MCP'],['tool','Tools']] as [id, label]}<button type="button" class:active={kind === id} aria-pressed={kind === id} onclick={() => kind = id as HarnessResource['kind']}>{$t(label)}<span>{items.filter(item => item.kind === id).length}</span></button>{/each}</nav>
  {#if loading}<p role="status">{$t('Loading resources…')}</p>
  {:else if !visible.length}<p>{$t('No resources listed by this harness.')}</p>
  {:else}<div class="resource-list">{#each visible as item (`${item.kind}:${item.id}`)}<label title={item.id}><input type="checkbox" checked={enabled(item)} disabled={disabled || !item.configurable} onchange={event => toggle(item, event.currentTarget.checked)} /><span>{item.name}{#if !item.configurable}<small>{$t('Managed by harness')}</small>{/if}</span></label>{/each}</div>{/if}
  {#each profile.resourceRules ?? [] as rule}{#if !items.some(item => item.kind === rule.kind && item.id === rule.id)}<div class="unavailable"><span>{rule.id}<small>{$t('Not in the current catalog')}</small></span><button type="button" disabled={disabled} aria-label={`${$t('Remove')} ${rule.id}`} onclick={() => onchange({ resourceRules: profile.resourceRules?.filter(item => item !== rule) })}>×</button></div>{/if}{/each}
  {#each profile.toolPolicy.rules as rule}{#if rule.enforcement !== 'native' || !items.some(item => item.kind === 'tool' && item.configurable && item.id === rule.tool)}<div class="unavailable"><span>{rule.tool}<small>{$t(rule.enforcement === 'unsupported' ? 'Unsupported' : 'Not in the current catalog')} · {rule.decision}</small></span><button type="button" disabled={disabled} aria-label={`${$t('Remove')} ${rule.tool}`} onclick={() => onchange({ toolPolicy: { rules: profile.toolPolicy.rules.filter(item => item !== rule) } })}>×</button></div>{/if}{/each}
</section>

<style>
  .resources { border-top:1px solid var(--piui-border-subtle); padding-top:var(--piui-space-3); }
  nav { display:flex; gap:var(--piui-space-1); border-bottom:1px solid var(--piui-border-subtle); }
  button { font:inherit; cursor:pointer; color:var(--piui-text-muted); background:transparent; border:0; border-radius:var(--piui-radius-sm); padding:7px 8px; }
  nav button { flex:1; font-size:12px; } button.active { color:var(--piui-text); background:var(--piui-accent-soft); } nav span { margin-left:5px; color:var(--piui-text-faint); font-size:10px; font-variant-numeric:tabular-nums; }
  .resource-list { max-height:35vh; overflow:auto; padding-block:var(--piui-space-2); }
  label,.unavailable { display:flex; align-items:center; gap:var(--piui-space-2); padding:8px 4px; color:var(--piui-text); font-size:12px; } label:hover { background:var(--piui-surface-1); } input { accent-color:var(--piui-action); flex:none; } label span,.unavailable span { min-width:0; overflow-wrap:anywhere; flex:1; }
  p,small { color:var(--piui-text-muted); font-size:11px; line-height:1.5; } small { display:block; } button:focus-visible,input:focus-visible { outline:2px solid var(--piui-focus); outline-offset:1px; }
</style>
