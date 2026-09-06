<script lang="ts">
  import { harnessConfigurations } from '../../harness-adapters';
  import { t } from '../locale/language';
  import { tick } from 'svelte';
  import type { AgentProfile, Harness, PermissionMode, ToolRule } from '../../../../../contracts/orchestration-v3';
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

  $: configuration = harnessConfigurations[draft.harness];
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
    <p class="eyebrow">{$t('Agent profile')}</p>
    <h1 id="profile-editor-title">{$t(profile === undefined ? 'Create profile' : 'Edit profile')}</h1>
    {#if readOnly}<p class="notice" role="status">{$t('Read-only mode. Profile data is shown, but changes cannot be saved.')}</p>{/if}
  </header>

  {#if error || validationErrors.length > 0}
    <div class="error-summary" role="alert" tabindex="-1" bind:this={errorSummary}>
      <strong>{$t('Profile was not saved.')}</strong>
      {#if error}<p>{error}</p>{/if}
      {#if validationErrors.length > 0}<ul>{#each validationErrors as validationError}<li>{validationError}</li>{/each}</ul>{/if}
    </div>
  {/if}

  <section aria-label={$t('Agent identity')}>
    <label for="profile-name">{$t('Name')}</label>
    <input id="profile-name" value={draft.name} oninput={(event) => updateDraft({ name: event.currentTarget.value })} disabled={disabled} autocomplete="off" />
  </section>

  <section aria-label={$t('Runtime')}>
    {#if profile === undefined}
      <label for="profile-harness">{$t('Harness')}</label>
      <select id="profile-harness" value={draft.harness} onchange={(event) => updateDraft({ harness: event.currentTarget.value as Harness })} disabled={disabled}>
        <option value="pi">{$t('Pi')}</option>
        <option value="prime-agent">{$t('Prime Agent')}</option>
        <option value="codex">{$t('Codex')}</option>
      </select>
    {:else}
      <p class="static-field"><strong>{$t('Harness')}</strong><span>{harnessLabel(draft.harness)}</span></p>
    {/if}

    <div class="field-grid">
      <div><label for="profile-model-provider">{$t('Model provider ')}<span>(optional)</span></label><input id="profile-model-provider" value={draft.modelProvider} oninput={(event) => updateDraft({ modelProvider: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
      <div><label for="profile-model">{$t('Model')}</label><input id="profile-model" value={draft.model} oninput={(event) => updateDraft({ model: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
    </div>


  </section>

  <section aria-label={$t('Inference settings')}>
    <div class="field-grid">
      <label>Reasoning
        <select aria-label={$t('Reasoning')} value={draft.reasoning} onchange={(event) => updateDraft({ reasoning: event.currentTarget.value })} disabled={disabled}>
          <option value="">{$t('Model default')}</option>
          {#each configuration.reasoningExamples as level}<option value={level}>{level}</option>{/each}
        </select>
      </label>
      {#if configuration.speed}<label>Speed
        <select aria-label={$t('Speed')} value={draft.serviceTier} onchange={(event) => updateDraft({ serviceTier: event.currentTarget.value as 'standard' | 'fast' })} disabled={disabled}><option value="standard">{$t('Standard')}</option><option value="fast">{$t('Fast')}</option></select>
      </label>{/if}
    </div>
    <p class="field-note">The selected model must support this reasoning level.{draft.harness === 'codex' ? ' Fast uses the native service tier and may cost more.' : ''}</p>
  </section>

  <section aria-labelledby="instructions-heading">
    <h2 id="instructions-heading">{$t('Instructions')}</h2>
    {#if configuration.basePrompt}
      <label class="mandatory"><input type="checkbox" checked={draft.replaceBasePrompt} onchange={(event) => updateDraft({ replaceBasePrompt: event.currentTarget.checked })} disabled={disabled} /> Replace Codex base prompt</label>
      {#if draft.replaceBasePrompt}
        <label for="profile-base-instructions">{$t('Your base prompt')}</label>
        <textarea id="profile-base-instructions" value={draft.baseInstructions} oninput={(event) => updateDraft({ baseInstructions: event.currentTarget.value })} disabled={disabled} spellcheck="true"></textarea>
        <p class="field-note">{$t('Replaces the built-in coding prompt. Leave empty for no base text. Tool descriptions, project instructions and native permission context still apply.')}</p>
      {/if}
    {/if}
    <label for="profile-instructions">{$t('Additional instructions')}</label>
    <textarea id="profile-instructions" value={draft.instructions} oninput={(event) => updateDraft({ instructions: event.currentTarget.value })} disabled={disabled} spellcheck="true"></textarea>
  </section>

  <details class="advanced" open={primeStrictPermission || draft.toolRules.length > 0}>
    <summary>{$t('Permissions and tools ')}<span>{draft.permissionMode === 'native' ? 'Native defaults' : draft.permissionMode}</span></summary>
    <section aria-labelledby="policy-heading">
      <label for="profile-permission">{$t('File access')}</label>
      <select id="profile-permission" value={draft.permissionMode} onchange={(event) => updateDraft({ permissionMode: event.currentTarget.value as PermissionMode })} disabled={disabled}>
        <option value="native">{$t('Native permissions')}</option><option value="read-only">{$t('Read-only')}</option><option value="workspace-write">{$t('Workspace write')}</option><option value="full-access">{$t('Full access')}</option>
      </select>
      <p class="field-note">{permissionDescription(draft.permissionMode)}</p>
      {#if primeStrictPermission}<p class="rule-warning">{$t('Prime Agent rejects this strict permission mode. Choose a supported mode to launch.')}</p>{/if}

    <h2 id="policy-heading">{$t('Tool rules')}</h2>
    <p class="section-note">{$t('Unsupported mandatory rules block launch. Advisory rules are instructions only.')}</p>
    {#each draft.toolRules as rule, index (`${index}`)}
      <div class="tool-rule">
        <div><label for={`tool-name-${index}`}>{$t('Tool')}</label><input id={`tool-name-${index}`} value={rule.tool} oninput={(event) => updateRule(index, { tool: event.currentTarget.value })} disabled={disabled} autocomplete="off" /></div>
        <div><label for={`tool-decision-${index}`}>{$t('Decision')}</label><select id={`tool-decision-${index}`} value={rule.decision} onchange={(event) => updateRule(index, { decision: event.currentTarget.value as ToolRule['decision'] })} disabled={disabled}><option value="allow">{$t('Allow')}</option><option value="deny">{$t('Deny')}</option></select></div>
        <div><label for={`tool-enforcement-${index}`}>{$t('Requested enforcement')}</label><select id={`tool-enforcement-${index}`} value={rule.enforcement} onchange={(event) => updateRule(index, { enforcement: event.currentTarget.value as ToolRule['enforcement'] })} disabled={disabled}><option value="native">{$t('Requested native enforcement')}</option><option value="coordinator">{$t('Requested coordinator enforcement')}</option><option value="advisory">{$t('Requested advisory policy')}</option><option value="unsupported">{$t('Requested unsupported policy')}</option></select></div>
        <label class="mandatory"><input type="checkbox" checked={rule.mandatory} onchange={(event) => updateRule(index, { mandatory: event.currentTarget.checked })} disabled={disabled} /> Mandatory</label>
        <button class="button button--quiet" type="button" onclick={() => removeRule(index)} disabled={disabled} aria-label={`Remove ${rule.tool === '' ? 'unnamed' : rule.tool} tool rule`}>{$t('Remove')}</button>
        {#if draft.harness === 'prime-agent' && rule.mandatory && rule.decision === 'deny' && isNativeRlmRule(rule)}<p class="rule-warning">● Unsupported mandatory rule. Prime Agent cannot disable native RLM while retaining normal IPython; the requirement is rejected.</p>
        {:else if rule.enforcement === 'unsupported' && rule.mandatory}<p class="rule-warning">● Unsupported mandatory rule. It cannot satisfy a required launch policy.</p>
        {:else if rule.enforcement === 'unsupported'}<p class="rule-warning">● Unsupported rule. This editor cannot claim it is enforced.</p>
        {:else if rule.enforcement === 'advisory'}<p class="rule-warning">● Advisory rule. {rule.mandatory ? 'Marking it mandatory does not make it enforced.' : 'It is not an enforcement boundary.'}</p>
        {:else if rule.enforcement === 'coordinator'}<p class="rule-status">● Requested coordinator enforcement · {toolDecisionLabel(rule.decision)} · Workspace coordinator route only; actual enforcement is unverified</p>
        {:else}<p class="rule-status">● Requested {enforcementLabel(rule.enforcement).toLowerCase()} · {toolDecisionLabel(rule.decision)} · Native adapter scope only; actual enforcement is unverified</p>{/if}
      </div>
    {/each}
    <button class="button button--quiet" type="button" onclick={addRule} disabled={disabled}>{$t('Add tool rule')}</button>
  </section>

  </details>
  <details class="advanced" open={draft.resourceRules.length > 0}>
    <summary>{$t('Skills &amp; MCP ')}<span>{draft.resourceRules.length || 'Native defaults'}</span></summary>
    <section>
      <p class="section-note">{$t('Override resources already configured in this harness. Codex skills use an absolute SKILL.md path; Prime skills use their name. Disabling a skill removes its harness registration, not OS file access.')}</p>
      {#each draft.resourceRules as rule, index}
        <div class="field-grid">
          <label>{$t('Resource')}<select aria-label={`Resource type ${index + 1}`} value={rule.kind} disabled={disabled} onchange={(event) => updateDraft({ resourceRules: draft.resourceRules.map((item, i) => i === index ? { ...item, kind: event.currentTarget.value as 'skill' | 'mcp' } : item) })}><option value="skill">{$t('Skill')}</option><option value="mcp" disabled={!configuration.resourceKinds.includes('mcp')}>{$t('MCP')}</option></select></label>
          <label>{$t('Name or path')}<input aria-label={`Resource identifier ${index + 1}`} value={rule.id} disabled={disabled} oninput={(event) => updateDraft({ resourceRules: draft.resourceRules.map((item, i) => i === index ? { ...item, id: event.currentTarget.value } : item) })} /></label>
          <label class="mandatory"><input type="checkbox" checked={rule.enabled} disabled={disabled} onchange={(event) => updateDraft({ resourceRules: draft.resourceRules.map((item, i) => i === index ? { ...item, enabled: event.currentTarget.checked } : item) })} />{$t('Enabled')}</label>
          <button type="button" class="button button--quiet" disabled={disabled} onclick={() => updateDraft({ resourceRules: draft.resourceRules.filter((_, i) => i !== index) })}>{$t('Remove')}</button>
        </div>
      {/each}
      <button type="button" class="button button--quiet" disabled={disabled || !configuration.resourceKinds.length} onclick={() => updateDraft({ resourceRules: [...draft.resourceRules, { kind: 'skill', id: '', enabled: false }] })}>{$t('Add resource rule')}</button>
      {#if !configuration.resourceKinds.includes('mcp')}<p class="field-note">{$t('Per-agent MCP overrides are not supported by this adapter. Mandatory overrides block launch.')}</p>{/if}
    </section>
  </details>
  <details class="advanced" open={draft.allowedSpawnProfileIds.length > 0}>
    <summary>{$t('Subagents ')}<span>{draft.allowedSpawnProfileIds.length ? `${draft.allowedSpawnProfileIds.length} allowed profiles` : 'Disabled'}</span></summary>
    <section aria-labelledby="spawn-heading">
    <h2 id="spawn-heading">{$t('Allowed profiles')}</h2>
    <p class="section-note">{$t('Choose which agents this profile may create. This controls workspace delegation, not native processes or OS access.')}</p>
    {#if spawnOptions.length === 0}<p class="empty">{$t('Save another profile to allow delegation.')}</p>{/if}
    <div class="spawn-options">
      {#each spawnOptions as candidate (candidate.id)}
        <label><input type="checkbox" checked={draft.allowedSpawnProfileIds.includes(candidate.id)} onchange={() => toggleSpawnProfile(candidate.id)} disabled={disabled} /> <span>{candidate.name || 'Unnamed profile'}{candidate.id === draft.id ? ' (current profile)' : ''} <small>{harnessLabel(candidate.harness)} · {candidate.model}</small></span></label>
      {/each}
    </div>
  </section>

  </details>

  {#if confirmDiscard}
    <section class="discard-choice" aria-labelledby="discard-heading">
      <h2 id="discard-heading">{$t('Discard unsaved changes?')}</h2>
      <p>{$t('Your profile changes have not been saved.')}</p>
      <div class="actions"><button class="button button--quiet" type="button" onclick={() => confirmDiscard = false} disabled={busy}>{$t('Keep editing')}</button><button class="button button--danger" type="button" onclick={onCancel} disabled={busy}>{$t('Discard changes')}</button></div>
    </section>
  {/if}

  <footer>
    <span class="save-state" aria-live="polite">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
    <div class="actions"><button class="button button--quiet" type="button" onclick={requestCancel} disabled={busy}>{$t('Cancel')}</button>{#if !readOnly}<button class="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>{/if}</div>
  </footer>
</form>

<style>
  label[for="profile-model-provider"] { display:block; }
  .advanced { border-top:1px solid var(--piui-border-subtle); margin-bottom:var(--piui-space-4); }
  .advanced summary { cursor:pointer; padding:var(--piui-space-3) 0; font-size:14px; font-weight:600; }
  .advanced summary span { margin-left:.6rem; color:var(--piui-text-muted); font-size:12px; font-weight:400; }
  .advanced summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .advanced section { border:0; margin-bottom:var(--piui-space-4); padding-top:0; }

  .static-field { display: grid; gap: 5px; margin: 0; font-size: 13px; }.static-field strong { font-weight: 650; }.static-field span { min-height: 38px; padding: 8px 10px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text-muted); }
  .editor { max-width: 840px; padding: var(--piui-space-7); color: var(--piui-text); }
  header, section { margin: 0 0 var(--piui-space-7); } .eyebrow { margin: 0 0 var(--piui-space-2); color: var(--piui-accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; } h1, h2 { margin: 0; letter-spacing: -.025em; } h1 { font-size: 28px; } h2 { font-size: 16px; } .section-note, .field-note, .empty { color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; } .notice, .error-summary, .discard-choice { margin: 0 0 var(--piui-space-5); padding: var(--piui-space-3); border: 1px solid var(--piui-warning-border); border-radius: var(--piui-radius-sm); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 13px; line-height: 1.5; } .error-summary { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error-summary p, .error-summary ul { margin: var(--piui-space-2) 0 0; }
  section { display: grid; gap: var(--piui-space-2); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border-subtle); } label { display: grid; gap: 5px; color: var(--piui-text); font-size: 13px; font-weight: 650; } label span { color: var(--piui-text-muted); font-weight: 500; } input, select, textarea { box-sizing: border-box; width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--piui-border-strong); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; } textarea { min-height: 160px; max-height: 360px; resize: vertical; line-height: 1.5; } input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; } .field-grid, .tool-rule { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--piui-space-3); }.spawn-options label { grid-template-columns: auto 1fr; align-items: start; padding: var(--piui-space-2); border-radius: var(--piui-radius-sm); }.mandatory input, .spawn-options input { width: 16px; min-height: 16px; margin-top: 2px; }.spawn-options small { display: block; margin-top: 3px; color: var(--piui-text-muted); font-size: 12px; font-weight: 400; }.tool-rule { margin: var(--piui-space-2) 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); }.tool-rule > :nth-child(1) { grid-column: span 2; }.mandatory { grid-template-columns: auto 1fr; align-items: center; }.rule-warning, .rule-status { grid-column: span 2; margin: 0; font-size: 12px; }.rule-warning { color: var(--piui-warning-text); }.rule-status { color: var(--piui-text-muted); }.spawn-options { display: grid; gap: var(--piui-space-1); }.spawn-options label:hover { background: var(--piui-surface-1); }.button { min-height: 36px; padding: 0 var(--piui-space-3); border: 1px solid transparent; border-radius: var(--piui-radius-sm); color: var(--piui-text); font: inherit; font-size: 13px; font-weight: 650; }.button--quiet { background: transparent; border-color: var(--piui-border); }.button--quiet:hover:not(:disabled) { background: var(--piui-surface-2); }.button--primary { background: var(--piui-accent); color: var(--piui-accent-ink); }.button--danger { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.button:disabled, input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; opacity: .6; } footer { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border); }.save-state { color: var(--piui-text-muted); font-size: 13px; }.actions { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); }.discard-choice { margin-top: calc(var(--piui-space-7) * -1); }.discard-choice h2, .discard-choice p { margin: 0; }.discard-choice p { margin-top: var(--piui-space-2); }.discard-choice .actions { margin-top: var(--piui-space-3); }
  @media (max-width: 620px) { .editor { padding: var(--piui-space-4); }.field-grid, .tool-rule { grid-template-columns: 1fr; }.tool-rule > :nth-child(1), .rule-warning, .rule-status { grid-column: auto; } footer { align-items: flex-start; flex-direction: column; } }
</style>
