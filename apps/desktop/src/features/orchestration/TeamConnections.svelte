<script lang="ts">
  import { t } from '../locale/language';
  import type { AgentProfile, DirectedEdge, TeamDefinition } from '../../../../../contracts/orchestration-v5';
  import { connectionPreset, setConnection } from './connections';
  export let team: TeamDefinition;
  export let profiles: readonly AgentProfile[];
  export let disabled = false;
  export let onChange: (kind: 'sendEdges' | 'observeEdges', edges: readonly DirectedEdge[]) => void;
  let selected = team.orchestratorMemberId;
  let kind: 'sendEdges' | 'observeEdges' = 'sendEdges';
  let query = '';
  $: if (!team.members.some(member => member.id === selected)) selected = team.members[0]?.id ?? '';
  $: targets = team.members.filter(member => member.id !== selected && label(member.id).toLowerCase().includes(query.toLowerCase()));
  function label(id: string): string {
    const member = team.members.find(member => member.id === id);
    const profileName = profiles.find(profile => profile.id === member?.profileId)?.name;
    return profileName ? `${id} · ${profileName}` : id;
  }
  function connected(from: string, to: string): boolean {
    return team[kind].some(edge => edge.fromMemberId === from && edge.toMemberId === to);
  }
</script>

<section class="connections" aria-labelledby="connections-title">
  <header><div><h2 id="connections-title">{$t('Connections')}</h2><p>{$t('Choose an agent, then set each direction independently.')}</p></div><span class="count">{team.members.length} agents · {team.sendEdges.length} message routes</span></header>
  <div class="presets" aria-label={$t('Message topology presets')}>
    <span>{$t('Messaging')}</span>
    <button type="button" disabled={disabled || !team.orchestratorMemberId} onclick={() => onChange('sendEdges', connectionPreset(team.members, team.orchestratorMemberId, 'orchestrator'))}>{$t('Through orchestrator')}</button>
    <button type="button" disabled={disabled} onclick={() => onChange('sendEdges', connectionPreset(team.members, team.orchestratorMemberId, 'everyone'))}>{$t('Everyone to everyone')}</button>
    <button type="button" disabled={disabled} onclick={() => onChange('sendEdges', [])}>{$t('No messages')}</button>
  </div>
  {#if team.members.length === 0}<p class="empty">{$t('Add agents to connect them.')}</p>{:else}
    <div class="network">
      <nav aria-label={$t('Select agent connections')}>
        {#each team.members as member (member.id)}
          <button class:selected={selected === member.id} aria-pressed={selected === member.id} type="button" onclick={() => selected = member.id}>
            <span class="avatar" aria-hidden="true">{label(member.id).slice(0, 1)}</span>
            <span><strong>{label(member.id)}</strong><small>{member.id === team.orchestratorMemberId ? 'Orchestrator' : profiles.find(p => p.id === member.profileId)?.harness}</small></span>
          </button>
        {/each}
      </nav>
      <div class="routes">
        <div class="route-heading"><h3>{label(selected)}</h3><div class="modes" aria-label={$t('Connection type')}><button type="button" aria-pressed={kind === 'sendEdges'} onclick={() => kind = 'sendEdges'}>{$t('Messaging')}</button><button type="button" aria-pressed={kind === 'observeEdges'} onclick={() => kind = 'observeEdges'}>{$t('Observation')}</button></div></div>
        <label class="search"><span class="visually-hidden">{$t('Find a connection target')}</span><input type="search" bind:value={query} placeholder={$t('Find an agent')} /></label>
        {#if kind === 'observeEdges'}<p class="note">{$t('Observation grants access to recorded results. It does not grant messaging.')}</p>{/if}
        <div class="direction-head" aria-hidden="true"><span>{$t('Agent')}</span><span>{$t('Outgoing →')}</span><span>← Incoming</span></div>
        {#each targets as target (target.id)}
          <div class="route"><strong>{label(target.id)}</strong>
            <label><input type="checkbox" checked={connected(selected, target.id)} disabled={disabled} onchange={(event) => onChange(kind, setConnection(team[kind], selected, target.id, event.currentTarget.checked))} /><span>{kind === 'sendEdges' ? 'Send' : 'Observe'}</span><span class="visually-hidden"> from {label(selected)} to {label(target.id)}</span></label>
            <label><input type="checkbox" checked={connected(target.id, selected)} disabled={disabled} onchange={(event) => onChange(kind, setConnection(team[kind], target.id, selected, event.currentTarget.checked))} /><span>{kind === 'sendEdges' ? 'Receive' : 'Be observed'}</span><span class="visually-hidden"> from {label(target.id)} to {label(selected)}</span></label>
          </div>
        {/each}
        {#if targets.length === 0}<p class="empty">{team.members.length < 2 ? 'Add another agent to create a connection.' : 'No agents match your search.'}</p>{/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .connections { display:grid; gap:1rem; } header,.presets,.route-heading,.modes { display:flex; gap:.65rem; align-items:center; flex-wrap:wrap; } header,.route-heading { justify-content:space-between; } h2,h3,p { margin:0; } h2 { font-size:1rem; } h3 { font-size:.95rem; } p,.count,.note { color:var(--piui-text-muted); font-size:.8rem; } p { margin-top:.3rem; } .count { font-variant-numeric:tabular-nums; } button,input { font:inherit; color:inherit; } button { border:1px solid var(--piui-border); background:var(--piui-bg-raised); padding:.5rem .65rem; border-radius:var(--piui-radius-sm); cursor:pointer; } button:hover { background:var(--piui-surface-2); } button:focus-visible,input:focus-visible { outline:2px solid var(--piui-accent); outline-offset:2px; } button:disabled { opacity:.5; cursor:default; } .presets { font-size:.8rem; } .presets>span { color:var(--piui-text-muted); } .network { display:grid; grid-template-columns:minmax(10rem,1fr) minmax(0,2fr); border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); overflow:hidden; } nav { display:flex; flex-direction:column; padding:.5rem; gap:.35rem; background:var(--piui-bg-raised); } nav button { display:flex; gap:.65rem; text-align:left; border-color:transparent; } nav button.selected { background:var(--piui-accent-soft); border-color:var(--piui-accent); } nav strong,nav small { display:block; overflow-wrap:anywhere; } nav small { font-size:.72rem; color:var(--piui-text-muted); margin-top:.2rem; } .avatar { display:grid; place-items:center; flex-shrink:0; width:2rem; height:2rem; background:var(--piui-bg); border-radius:var(--piui-radius-sm); font-weight:600; } .routes { min-width:0; padding:1rem; border-left:1px solid var(--piui-border); } .modes { gap:0; font-size:.75rem; } .modes button[aria-pressed=true] { color:var(--piui-accent); background:var(--piui-accent-soft); } .search input { box-sizing:border-box; width:100%; margin:.85rem 0; padding:.6rem; border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); background:var(--piui-bg); } .route,.direction-head { display:grid; grid-template-columns:minmax(0,1fr) 6rem 6rem; gap:.5rem; align-items:center; padding:.65rem 0; } .direction-head { color:var(--piui-text-muted); font-size:.72rem; } .route { border-top:1px solid var(--piui-border); font-size:.8rem; } .route strong { overflow-wrap:anywhere; } .route label { display:flex; align-items:center; gap:.35rem; cursor:pointer; } input[type=checkbox] { accent-color:var(--piui-accent); } .empty { padding:1rem 0; } .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); } @media(max-width:640px) { .network { grid-template-columns:1fr; } nav { flex-direction:row; flex-wrap:wrap; } .routes { border-left:0; border-top:1px solid var(--piui-border); } .route,.direction-head { grid-template-columns:minmax(0,1fr) 5rem 5rem; } }
</style>
