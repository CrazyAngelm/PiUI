<script lang="ts">
  import { tick } from 'svelte';
  import type { AgentProfile, Harness, PermissionMode, ToolRule } from '../../../../../contracts/orchestration-v1';
  import {
    createProfileDraft,
    enforcementLabel,
    newToolRule,
    profileFromDraft,
    spawnProfileOptions,
    toolDecisionLabel,
    validateProfileDraft,
    type ProfileDraft,
  } from './profileForm';

  export let profile: AgentProfile | undefined;
  export let profiles: readonly AgentProfile[] = [];
  export let busy = false;
  export let error: string | undefined;
  export let onSave: (profile: AgentProfile) => void;
  export let onCancel: () => void;
  export let readOnly = false;
  export let onDirtyChange: (dirty: boolean) => void = () => {};

  let draft: ProfileDraft = createProfileDraft(profile);
  let sourceProfileId: string | undefined = profile?.id;
  let baseline = fingerprint(draft);
  let validationErrors: readonly string[] = [];
  let confirmDiscard = false;
  let errorSummary: HTMLElement | undefined;
  let lastError: string | undefined;
  let lastReportedDirty: boolean | undefined;

  $: disabled = busy || readOnly;
  $: dirty = fingerprint(draft) !== baseline;
  $: spawnOptions = spawnProfileOptions(profiles, draft.id);
  $: primeStrictPermission = draft.harness === 'prime-agent' && (draft.permissionMode === 'read-only' || draft.permissionMode === 'workspace-write');
  $: if (dirty !== lastReportedDirty) {
    lastReportedDirty = dirty;
    onDirtyChange(dirty);
  }
  $: if (profile?.id !== sourceProfileId) {
    sourceProfileId = profile?.id;
    draft = createProfileDraft(profile);
    baseline = fingerprint(draft);
    validationErrors = [];
    confirmDiscard = false;
    lastReportedDirty = undefined;
  }
  $: if (error !== undefined && error !== lastError) {
    lastError = error;
    void tick().then(() => errorSummary?.focus());
  }
  $: if (error === undefined) lastError = undefined;

  function fingerprint(value: ProfileDraft): string {
    return JSON.stringify(value);
  }

  function updateDraft(change: Partial<ProfileDraft>): void {
    draft = { ...draft, ...change };
    validationErrors = [];
  }

  function updateRule(index: number, change: Partial<ToolRule>): void {
    const toolRules = draft.toolRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...change } : rule);
    updateDraft({ toolRules });
  }

  function addRule(): void {
    updateDraft({ toolRules: [...draft.toolRules, newToolRule()] });
  }

  function removeRule(index: number): void {
    updateDraft({ toolRules: draft.toolRules.filter((_, ruleIndex) => ruleIndex !== index) });
  }

  function toggleSpawnProfile(id: string): void {
    const selected = draft.allowedSpawnProfileIds.includes(id);
    updateDraft({
      allowedSpawnProfileIds: selected
        ? draft.allowedSpawnProfileIds.filter((candidate) => candidate !== id)
        : [...draft.allowedSpawnProfileIds, id],
    });
  }

  function requestCancel(): void {
    if (!dirty || readOnly) {
      onCancel();
      return;
    }
    confirmDiscard = true;
  }

  function save(): void {
    if (disabled) return;
    const validation = validateProfileDraft(draft);
    validationErrors = validation.errors;
    if (!validation.valid) {
      void tick().then(() => errorSummary?.focus());
      return;
    }
    onSave(profileFromDraft(draft));
  }

  function harnessLabel(harness: Harness): string {
    switch (harness) {
      case 'pi': return 'Pi';
      case 'prime-agent': return 'Prime Agent';
      case 'codex': return 'Codex';
    }
  }

  function isNativeRlmRule(rule: ToolRule): boolean {
    return rule.tool.trim().toLowerCase() === 'rlm';
  }

  function permissionDescription(mode: PermissionMode): string {
    switch (mode) {
      case 'native': return 'Preserves the selected harness policy. This makes no extra OS isolation guarantee.';
      case 'read-only': return 'Requested strict policy. Its enforcement is not verified by this editor.';
      case 'workspace-write': return 'Requested strict policy. Its enforcement is not verified by this editor.';
      case 'full-access': return 'Explicit native policy bypass where supported. It does not grant project trust or create a sandbox.';
    }
  }
</script>

<form class="editor" onsubmit={(event) => { event.preventDefault(); save(); }} aria-labelledby="profile-editor-title">
  <header>
    <p class="eyebrow">Agent profile</p>
    <h1 id="profile-editor-title">{profile === undefined ? 'Create profile' : 'Edit profile'}</h1>
    <p class="intro">Save settings to reuse when launching an agent.</p>
    {#if readOnly}<p class="notice" role="status">Read-only mode. Profile data is shown, but changes cannot be saved.</p>{/if}
  </header>

  {#if error || validationErrors.length > 0}
    <div class="error-summary" role="alert" tabindex="-1" bind:this={errorSummary}>
      <strong>Profile was not saved.</strong>
      {#if error}<p>{error}</p>{/if}
      {#if validationErrors.length > 0}<ul>{#each validationErrors as validationError}<li>{validationError}</li>{/each}</ul>{/if}
    </div>
  {/if}

  <section aria-labelledby="identity-heading">
    <h2 id="identity-heading">Identity</h2>
    <label for="profile-name">Name</label>
    <input id="profile-name" value={draft.name} oninput={(event) => updateDraft({ name: event.currentTarget.value })} disabled={disabled} autocomplete="off" />
  </section>

  <section aria-labelledby="runtime-heading">
    <h2 id="runtime-heading">Runtime</h2>
    {#if profile === undefined}
      <label for="profile-harness">Harness</label>
      <select id="profile-harness" value={draft.harness} onchange={(event) => updateDraft({ harness: event.currentTarget.value as Harness })} disabled={disabled}>
        <option value="pi">Pi</option>
        <option value="prime-agent">Prime Agent</option>
        <option value="codex">Codex</option>
      </select>
    {:else}
      <p class="static-field"><strong>Harness</strong><span>{harnessLabel(draft.harness)}</span></p>
      <p class="field-note">A saved profile keeps its harness. Create a copy to use another harness.</p>
    {/if}

    <div class="field-grid">
      <div><label for="profile-model-provider">Model provider <span>(optional)</span></label><input id="profile-model-provider" value={draft.modelProvider} oninput={(event) => updateDraft({ modelProvider: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
      <div><label for="profile-model">Model</label><input id="profile-model" value={draft.model} oninput={(event) => updateDraft({ model: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
    </div>

    <fieldset class="permission-mode" disabled={disabled}>
      <legend>Native permissions</legend>
      {#each ['native', 'read-only', 'workspace-write', 'full-access'] as mode}
        {@const permission = mode as PermissionMode}
        <label class:chosen={draft.permissionMode === permission}>
          <input type="radio" name="permission-mode" value={permission} checked={draft.permissionMode === permission} onchange={() => updateDraft({ permissionMode: permission })} />
          <span><strong>{permission === 'native' ? 'Native permissions' : permission === 'read-only' ? 'Read-only' : permission === 'workspace-write' ? 'Workspace write' : 'Full access'}</strong><small>{permissionDescription(permission)}</small></span>
        </label>
      {/each}
    </fieldset>
    {#if primeStrictPermission}<p class="rule-warning">Prime Agent rejects this strict permission mode. Choose a supported mode to launch.</p>{/if}
  </section>

  <section aria-labelledby="instructions-heading">
    <h2 id="instructions-heading">Instructions</h2>
    <label for="profile-instructions">Profile instructions</label>
    <textarea id="profile-instructions" value={draft.instructions} oninput={(event) => updateDraft({ instructions: event.currentTarget.value })} disabled={disabled} spellcheck="true"></textarea>
    <p class="field-note">These instructions apply when the profile is launched.</p>
  </section>

  <section aria-labelledby="policy-heading">
    <h2 id="policy-heading">Declared tool rules</h2>
    <p class="section-note">Requested enforcement is a declaration, not verified actual enforcement. Requested coordinator enforcement applies only to the Workspace coordinator route. Advisory rules are not enforcement boundaries or sandboxes.</p>
    {#if draft.toolRules.length === 0}<p class="empty">No tool rules are declared.</p>{/if}
    {#each draft.toolRules as rule, index (`${index}`)}
      <div class="tool-rule">
        <div><label for={`tool-name-${index}`}>Tool</label><input id={`tool-name-${index}`} value={rule.tool} oninput={(event) => updateRule(index, { tool: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
        <div><label for={`tool-decision-${index}`}>Decision</label><select id={`tool-decision-${index}`} value={rule.decision} onchange={(event) => updateRule(index, { decision: event.currentTarget.value as ToolRule['decision'] })} disabled={disabled}><option value="allow">Allow</option><option value="deny">Deny</option></select></div>
        <div><label for={`tool-enforcement-${index}`}>Requested enforcement</label><select id={`tool-enforcement-${index}`} value={rule.enforcement} onchange={(event) => updateRule(index, { enforcement: event.currentTarget.value as ToolRule['enforcement'] })} disabled={disabled}><option value="native">Requested native enforcement</option><option value="coordinator">Requested coordinator enforcement</option><option value="advisory">Requested advisory policy</option><option value="unsupported">Requested unsupported policy</option></select></div>
        <label class="mandatory"><input type="checkbox" checked={rule.mandatory} onchange={(event) => updateRule(index, { mandatory: event.currentTarget.checked })} disabled={disabled} /> Mandatory</label>
        <button class="button button--quiet" type="button" onclick={() => removeRule(index)} disabled={disabled} aria-label={`Remove ${rule.tool === '' ? 'unnamed' : rule.tool} tool rule`}>Remove</button>
        {#if draft.harness === 'prime-agent' && rule.mandatory && rule.decision === 'deny' && isNativeRlmRule(rule)}<p class="rule-warning">● Unsupported mandatory rule. Prime Agent cannot disable native RLM while retaining normal IPython; the requirement is rejected.</p>
        {:else if rule.enforcement === 'unsupported' && rule.mandatory}<p class="rule-warning">● Unsupported mandatory rule. It cannot satisfy a required launch policy.</p>
        {:else if rule.enforcement === 'unsupported'}<p class="rule-warning">● Unsupported rule. This editor cannot claim it is enforced.</p>
        {:else if rule.enforcement === 'advisory'}<p class="rule-warning">● Advisory rule. {rule.mandatory ? 'Marking it mandatory does not make it enforced.' : 'It is not an enforcement boundary.'}</p>
        {:else if rule.enforcement === 'coordinator'}<p class="rule-status">● Requested coordinator enforcement · {toolDecisionLabel(rule.decision)} · Workspace coordinator route only; actual enforcement is unverified</p>
        {:else}<p class="rule-status">● Requested {enforcementLabel(rule.enforcement).toLowerCase()} · {toolDecisionLabel(rule.decision)} · Native adapter scope only; actual enforcement is unverified</p>{/if}
      </div>
    {/each}
    <button class="button button--quiet" type="button" onclick={addRule} disabled={disabled}>Add tool rule</button>
  </section>

  <section aria-labelledby="spawn-heading">
    <h2 id="spawn-heading">Allowed workspace child templates</h2>
    <p class="section-note">This restricts only Workspace coordinator template launches to these exact saved profiles. It does not restrict native children, Python, RLM, processes, or other harness capabilities. Selecting one does not grant execution permission.</p>
    {#if spawnOptions.length === 0}<p class="empty">No workspace template launches are declared because there are no saved profile templates to select.</p>{/if}
    <div class="spawn-options">
      {#each spawnOptions as candidate (candidate.id)}
        <label><input type="checkbox" checked={draft.allowedSpawnProfileIds.includes(candidate.id)} onchange={() => toggleSpawnProfile(candidate.id)} disabled={disabled} /> <span>{candidate.name || 'Unnamed profile'}{candidate.id === draft.id ? ' (current profile)' : ''} <small>{harnessLabel(candidate.harness)} · {candidate.model}</small></span></label>
      {/each}
    </div>
    {#if draft.allowedSpawnProfileIds.length === 0}<p class="empty">No workspace template launches are declared.</p>{/if}
  </section>

  {#if confirmDiscard}
    <section class="discard-choice" aria-labelledby="discard-heading">
      <h2 id="discard-heading">Discard unsaved changes?</h2>
      <p>Your profile changes have not been saved.</p>
      <div class="actions"><button class="button button--quiet" type="button" onclick={() => confirmDiscard = false} disabled={busy}>Keep editing</button><button class="button button--danger" type="button" onclick={onCancel} disabled={busy}>Discard changes</button></div>
    </section>
  {/if}

  <footer>
    <span class="save-state" aria-live="polite">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
    <div class="actions"><button class="button button--quiet" type="button" onclick={requestCancel} disabled={busy}>Cancel</button>{#if !readOnly}<button class="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>{/if}</div>
  </footer>
</form>

<style>
  .static-field { display: grid; gap: 5px; margin: 0; font-size: 13px; }.static-field strong { font-weight: 650; }.static-field span { min-height: 38px; padding: 8px 10px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text-muted); }
  .editor { max-width: 840px; padding: var(--piui-space-7); color: var(--piui-text); }
  header, section { margin: 0 0 var(--piui-space-7); } .eyebrow { margin: 0 0 var(--piui-space-2); color: var(--piui-accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; } h1, h2 { margin: 0; letter-spacing: -.025em; } h1 { font-size: 28px; } h2 { font-size: 16px; } .intro, .section-note, .field-note, .empty { color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; } .intro { max-width: 68ch; margin: var(--piui-space-3) 0 0; } .notice, .error-summary, .discard-choice { margin: 0 0 var(--piui-space-5); padding: var(--piui-space-3); border: 1px solid var(--piui-warning-border); border-radius: var(--piui-radius-sm); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 13px; line-height: 1.5; } .error-summary { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error-summary p, .error-summary ul { margin: var(--piui-space-2) 0 0; }
  section { display: grid; gap: var(--piui-space-2); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border-subtle); } label { display: grid; gap: 5px; color: var(--piui-text); font-size: 13px; font-weight: 650; } label span { color: var(--piui-text-muted); font-weight: 500; } input, select, textarea { box-sizing: border-box; width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--piui-border-strong); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; } textarea { min-height: 160px; max-height: 360px; resize: vertical; line-height: 1.5; } input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; } .field-grid, .tool-rule { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--piui-space-3); }.permission-mode { display: grid; gap: var(--piui-space-2); margin: var(--piui-space-2) 0 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); }.permission-mode legend { padding: 0 4px; font-size: 13px; font-weight: 700; }.permission-mode label, .spawn-options label { grid-template-columns: auto 1fr; align-items: start; padding: var(--piui-space-2); border-radius: var(--piui-radius-sm); }.permission-mode label.chosen { background: var(--piui-surface-2); }.permission-mode input, .mandatory input, .spawn-options input { width: 16px; min-height: 16px; margin-top: 2px; }.permission-mode small, .spawn-options small { display: block; margin-top: 3px; color: var(--piui-text-muted); font-size: 12px; font-weight: 400; }.tool-rule { margin: var(--piui-space-2) 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); }.tool-rule > :nth-child(1) { grid-column: span 2; }.mandatory { grid-template-columns: auto 1fr; align-items: center; }.rule-warning, .rule-status { grid-column: span 2; margin: 0; font-size: 12px; }.rule-warning { color: var(--piui-warning-text); }.rule-status { color: var(--piui-text-muted); }.spawn-options { display: grid; gap: var(--piui-space-1); }.spawn-options label:hover { background: var(--piui-surface-1); }.button { min-height: 36px; padding: 0 var(--piui-space-3); border: 1px solid transparent; border-radius: var(--piui-radius-sm); color: var(--piui-text); font: inherit; font-size: 13px; font-weight: 650; }.button--quiet { background: transparent; border-color: var(--piui-border); }.button--quiet:hover:not(:disabled) { background: var(--piui-surface-2); }.button--primary { background: var(--piui-accent); color: var(--piui-accent-ink); }.button--danger { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.button:disabled, input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; opacity: .6; } footer { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border); }.save-state { color: var(--piui-text-muted); font-size: 13px; }.actions { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); }.discard-choice { margin-top: calc(var(--piui-space-7) * -1); }.discard-choice h2, .discard-choice p { margin: 0; }.discard-choice p { margin-top: var(--piui-space-2); }.discard-choice .actions { margin-top: var(--piui-space-3); }
  @media (max-width: 620px) { .editor { padding: var(--piui-space-4); }.field-grid, .tool-rule { grid-template-columns: 1fr; }.tool-rule > :nth-child(1), .rule-warning, .rule-status { grid-column: auto; } footer { align-items: flex-start; flex-direction: column; } }
</style>
