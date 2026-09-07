<script lang="ts">
  import { t } from '../locale/language';
  import type { AgentProfile, DirectedEdge, TeamDefinition, TeamMember } from '../../../../../contracts/orchestration-v5';
  import TeamConnections from './TeamConnections.svelte';
  import {
    cloneTeamDefinition,
    createEmptyTeamDefinition,
    profileById,
    validateTeamDefinition,
  } from './teamForm';

  export let team: TeamDefinition | undefined;
  export let profiles: readonly AgentProfile[] = [];
  export let busy = false;
  export let error: string | undefined;
  export let onSave: (team: TeamDefinition) => void = () => {};
  export let onCancel: () => void = () => {};
  export let onDirtyChange: (dirty: boolean) => void = () => {};
  export let readOnly = false;

  function newDraftId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid === undefined ? `team-${Date.now().toString(36)}` : `team-${uuid}`;
  }

  let sourceTeam = team;
  let draft = team === undefined ? createEmptyTeamDefinition(newDraftId()) : cloneTeamDefinition(team);
  // Keep the original draft snapshot separately so a failed parent save never
  // replaces input, while a clean editor can follow a new selected team.
  let sourceSnapshot = JSON.stringify(draft);
  let cancelConfirmation = false;

  $: if (team !== sourceTeam && JSON.stringify(draft) === sourceSnapshot) {
    sourceTeam = team;
    draft = team === undefined ? createEmptyTeamDefinition(newDraftId()) : cloneTeamDefinition(team);
    sourceSnapshot = JSON.stringify(draft);
    cancelConfirmation = false;
  }
  $: isDirty = JSON.stringify(draft) !== sourceSnapshot;
  $: onDirtyChange(isDirty);
  $: issues = validateTeamDefinition(draft, profiles);
  $: canSave = !readOnly && !busy && issues.length === 0;
  $: memberOptions = draft.members.map((member) => ({ member, profile: profileById(profiles, member.profileId) }));

  function changeName(event: Event): void {
    draft = { ...draft, name: (event.currentTarget as HTMLInputElement).value };
  }

  function addMember(): void {
    if (profiles.length === 0) return;
    let slot = draft.members.length + 1;
    while (draft.members.some(member => member.id === `agent-${slot}`)) slot++;
    const member: TeamMember = { id: `agent-${slot}`, profileId: profiles[0].id };
    draft = { ...draft, members: [...draft.members, member] };
  }

  function updateMember(memberIndex: number, field: 'id' | 'profileId', value: string): void {
    const member = draft.members[memberIndex];
    if (member === undefined) return;
    // Rows retain their index identity while the slot ID is being typed. This
    // also avoids editing every temporarily duplicate ID at once.
    const previousId = member.id;
    draft = {
      ...draft,
      members: draft.members.map((candidate, index) => index === memberIndex ? { ...candidate, [field]: value } : candidate),
      orchestratorMemberId: field === 'id' && draft.orchestratorMemberId === previousId ? value : draft.orchestratorMemberId,
      sendEdges: field === 'id' ? renameEdgeMember(draft.sendEdges, previousId, value) : draft.sendEdges,
      observeEdges: field === 'id' ? renameEdgeMember(draft.observeEdges, previousId, value) : draft.observeEdges,
    };
  }

  function renameEdgeMember(edges: readonly DirectedEdge[], oldId: string, newId: string): readonly DirectedEdge[] {
    return edges.map((edge) => ({
      fromMemberId: edge.fromMemberId === oldId ? newId : edge.fromMemberId,
      toMemberId: edge.toMemberId === oldId ? newId : edge.toMemberId,
    }));
  }

  function removeMember(memberId: string): void {
    draft = {
      ...draft,
      members: draft.members.filter((member) => member.id !== memberId),
      sendEdges: draft.sendEdges.filter((edge) => edge.fromMemberId !== memberId && edge.toMemberId !== memberId),
      observeEdges: draft.observeEdges.filter((edge) => edge.fromMemberId !== memberId && edge.toMemberId !== memberId),
      orchestratorMemberId: draft.orchestratorMemberId === memberId ? '' : draft.orchestratorMemberId,
    };
  }

  function setOrchestrator(event: Event): void {
    draft = { ...draft, orchestratorMemberId: (event.currentTarget as HTMLSelectElement).value };
  }

  function requestCancel(): void {
    if (readOnly || !isDirty) {
      onCancel();
      return;
    }
    cancelConfirmation = true;
  }

  function discardChanges(): void {
    onCancel();
  }

  function save(): void {
    if (!canSave) return;
    // The parent owns persistence. Keep this draft untouched after a rejected save.
    onSave(cloneTeamDefinition(draft));
  }

  function memberLabel(member: TeamMember): string {
    const profile = profileById(profiles, member.profileId);
    return profile === undefined ? `${member.id} — unavailable profile ${member.profileId}` : `${member.id} — ${profile.name} (${profile.harness})`;
  }

</script>

<section class="team-editor" aria-labelledby="team-editor-title">
  <header>
    <div>
      <p class="eyebrow">{$t('Team definition')}</p>
      <h1 id="team-editor-title">{$t(team === undefined ? 'Create team' : 'Edit team')}</h1>
    </div>
    {#if readOnly}<p class="state" role="status">{$t('This team is read-only.')}</p>{:else if busy}<p class="state" role="status">{$t('Saving team…')}</p>{:else if isDirty}<p class="state" role="status">{$t('Unsaved changes')}</p>{/if}
  </header>

  {#if error}<div class="error" role="alert"><strong>{$t('Could not save team.')}</strong> {error}</div>{/if}
  {#if issues.length > 0 && !readOnly}
    <div class="validation" role="alert" aria-label={$t('Team validation issues')}>
      <strong>{$t('Complete the team before saving.')}</strong>
      <ul>{#each issues as issue}<li>{issue.message}</li>{/each}</ul>
    </div>
  {/if}

  <fieldset disabled={readOnly || busy}>
    <legend class="visually-hidden">{$t('Team details')}</legend>
    <label class="field">
      <span>{$t('Team name')}</span>
      <input value={draft.name} oninput={changeName} autocomplete="off" aria-invalid={issues.some((issue) => issue.path === 'name')} />
    </label>

    <section class="editor-section" aria-labelledby="members-title">
      <div class="section-heading"><div><h2 id="members-title">{$t('Members')}</h2><p>{$t('Choose a saved agent profile for each role.')}</p></div><button type="button" onclick={addMember} disabled={profiles.length === 0}>{$t('Add member')}</button></div>
      {#if profiles.length === 0}<p class="empty">{$t('No profiles are available. Create a profile before adding a member.')}</p>{/if}
      <div class="member-list">
        {#each draft.members as member, memberIndex (memberIndex)}
          <article class="member-row">
            <label><span>{$t('Role name')}</span><input value={member.id} oninput={(event) => updateMember(memberIndex, 'id', (event.currentTarget as HTMLInputElement).value)} /></label>
            <label><span>{$t('Profile')}</span><select value={member.profileId} oninput={(event) => updateMember(memberIndex, 'profileId', (event.currentTarget as HTMLSelectElement).value)}>{#each profiles as profile}<option value={profile.id}>{profile.name} · {profile.harness}</option>{/each}</select></label>
            <button type="button" class="remove" aria-label={`Remove member ${member.id}`} onclick={() => removeMember(member.id)}>{$t('Remove')}</button>
          </article>
        {/each}
      </div>
    </section>

    <section class="editor-section" aria-labelledby="orchestrator-title">
      <h2 id="orchestrator-title">{$t('Orchestrator')}</h2>
      <p>{$t('Choose who coordinates the team. Set its connections below.')}</p>
      <label class="field compact"><span>{$t('Orchestrator member')}</span><select value={draft.orchestratorMemberId} oninput={setOrchestrator}><option value="">{$t('Choose a member')}</option>{#each memberOptions as option}<option value={option.member.id}>{memberLabel(option.member)}</option>{/each}</select></label>
    </section>

  </fieldset>
  <TeamConnections team={draft} {profiles} disabled={readOnly || busy} onChange={(kind, edges) => draft = { ...draft, [kind]: edges }} />
  <details class="subagents"><summary>{$t('Subagents')}</summary>
  <fieldset disabled={readOnly || busy}>
    <legend class="visually-hidden">{$t('Agent creation permissions')}</legend>
    <label class="spawn-communication"><input type="checkbox" checked={draft.spawnedAgentsJoinTeam ?? false} onchange={(event) => draft = { ...draft, spawnedAgentsJoinTeam: event.currentTarget.checked }} /> {$t('Let subagents inherit their parent’s team connections')}</label>
    <p class="empty">{$t('Otherwise they can message only the agent that created them. Profile permissions still apply.')}</p>
    <section class="editor-section" aria-labelledby="spawning-title">
      <h2 id="spawning-title">{$t('Allowed profiles')}</h2>
      <p>{$t('Each agent can create only the profiles allowed in its settings.')}</p>
      {#if draft.members.length === 0}<p class="empty">{$t('Add a member to see its profile-owned workspace child templates.')}</p>
      {:else}<ul class="spawn-list">{#each draft.members as member}<li><strong>{memberLabel(member)}</strong><span>{#if profileById(profiles, member.profileId)?.allowedSpawnProfileIds.length}{profileById(profiles, member.profileId)?.allowedSpawnProfileIds.map((id) => profileById(profiles, id)?.name ?? `Unavailable profile ${id}`).join(', ')}{:else}Disabled.{/if}</span></li>{/each}</ul>{/if}
    </section>

  </fieldset>

  </details>

  {#if cancelConfirmation}
    <aside class="cancel-confirmation" aria-live="polite"><strong>{$t('Discard unsaved changes?')}</strong><span>{$t('Keep editing to return to this draft.')}</span><div><button type="button" onclick={() => (cancelConfirmation = false)}>{$t('Keep editing')}</button><button type="button" class="remove" onclick={discardChanges}>{$t('Discard changes')}</button></div></aside>
  {/if}
  <footer><button type="button" onclick={requestCancel} disabled={busy}>{readOnly ? 'Close' : 'Cancel'}</button>{#if !readOnly}<button type="button" class="primary" onclick={save} disabled={!canSave}>{$t('Save team')}</button>{/if}</footer>
</section>

<style>
  .subagents { margin-top:20px; border-top:1px solid var(--piui-border-subtle); }
  .subagents summary { padding:14px 0; cursor:pointer; font-weight:600; font-size:14px; }
  .subagents summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .spawn-communication { display:flex; align-items:center; gap:8px; font-size:13px; }
  .spawn-communication input { min-height:0; width:16px; height:16px; padding:0; accent-color:var(--piui-accent); }

  .team-editor { max-width: 900px; color: var(--piui-text); } header, .section-heading, footer, .member-row, .spawn-list li, .cancel-confirmation > div { display: flex; align-items: center; gap: 12px; } header, .section-heading { justify-content: space-between; } h1, h2, p { margin: 0; } h1 { font-size: 22px; } h2 { font-size: 15px; } .eyebrow { color: var(--piui-text-faint); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; } .state { color: var(--piui-text-muted); font-size: 13px; } fieldset { min-width: 0; margin: 20px 0; padding: 0; border: 0; } .field, .member-row label { display: grid; gap: 5px; color: var(--piui-text-muted); font-size: 12px; } input, select { min-height: 34px; border: 1px solid var(--piui-border); border-radius: 6px; background: var(--piui-bg-raised); color: var(--piui-text); font: inherit; padding: 0 8px; } .field { max-width: 460px; } .compact { margin-top: 12px; } .editor-section { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--piui-border-subtle); } .editor-section > p, .section-heading p { margin-top: 5px; color: var(--piui-text-muted); font-size: 13px; } .member-list { display: grid; gap: 8px; margin-top: 12px; }     .member-row { align-items: end; padding: 10px; border: 1px solid var(--piui-border-subtle); border-radius: 8px; } .member-row label { flex: 1 1 180px; } button { min-height: 34px; border: 1px solid var(--piui-border); border-radius: 6px; background: var(--piui-bg-raised); color: var(--piui-text); font: inherit; padding: 0 10px; } button:hover:not(:disabled) { background: var(--piui-surface-2); } button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; } button:disabled { cursor: not-allowed; opacity: .55; } .primary { border-color: var(--piui-accent); background: var(--piui-accent); color: var(--piui-bg); font-weight: 700; } .remove { color: var(--piui-danger); } .empty { padding: 10px 0; color: var(--piui-text-muted); font-size: 13px; } .error, .validation, .cancel-confirmation { margin-top: 16px; padding: 12px; border: 1px solid var(--piui-danger); border-radius: 8px; background: color-mix(in srgb, var(--piui-danger) 9%, transparent); color: var(--piui-text); font-size: 13px; } .validation ul { margin: 6px 0 0; padding-left: 18px; } .spawn-list { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; } .spawn-list li { align-items: baseline; flex-wrap: wrap; } .spawn-list span { color: var(--piui-text-muted); font-size: 13px; }   .cancel-confirmation { display: grid; gap: 8px; } .cancel-confirmation span { color: var(--piui-text-muted); } footer { justify-content: flex-end; padding-top: 16px; border-top: 1px solid var(--piui-border-subtle); } .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; } @media (max-width: 620px) { header, .section-heading, .member-row { align-items: stretch; flex-direction: column; } .member-row label, .field { max-width: none; width: 100%; } }
</style>
