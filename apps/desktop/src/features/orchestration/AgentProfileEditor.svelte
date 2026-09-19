<script lang="ts">
  import { harnessConfigurations } from '../../harness-adapters';
  import { t } from '../locale/language';
  import { tick, onMount } from 'svelte';
  import { harnessModels } from '../../host-api/harnessModels';
  import ResourcePicker from './ResourcePicker.svelte';
  import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
  import type { AgentProfile, Harness, PermissionMode } from '../../../../../contracts/orchestration-v6';
  import {
    createProfileDraft,
    profileFromDraft,
    spawnProfileOptions,
    validateProfileDraft,
    type ProfileDraft,
  } from './profileForm';

  export let profile: AgentProfile | undefined;
  export let workspaceId = '';
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
  let nativeCatalog: HarnessModelsResult | undefined;
  let catalogLoading = false;
  let catalogError = '';
  let catalogHarness: Harness | undefined;
  let modelOptionsOpen = profile?.serviceTier === 'fast';
  let mounted = false;
  let catalogRequest = 0;
  onMount(() => { mounted = true; return () => mounted = false; });
  $: if (mounted && workspaceId && !readOnly && draft.harness !== catalogHarness) void loadCatalog();
  $: nativeModel = nativeCatalog?.models.find(model => model.id === draft.model && model.provider === (draft.modelProvider || undefined));
  async function loadCatalog(refresh = false): Promise<void> {
    const request = ++catalogRequest;
    catalogHarness = draft.harness; catalogLoading = true; catalogError = ''; nativeCatalog = undefined;
    try { const result = await harnessModels({ workspaceId, harness: draft.harness }, refresh); if (mounted && request === catalogRequest) nativeCatalog = result; }
    catch (error) { if (mounted && request === catalogRequest) catalogError = error instanceof Error ? error.message : 'Could not load models.'; }
    finally { if (mounted && request === catalogRequest) catalogLoading = false; }
  }

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
    modelOptionsOpen = profile?.serviceTier === 'fast';
    lastReportedDirty = undefined;
  }
  $: if (error !== undefined && error !== lastError) {
    lastError = error;
    void tick().then(() => errorSummary?.focus());
  }
  $: if (error === undefined) lastError = undefined;
  $: if (catalogError) modelOptionsOpen = true;

  function fingerprint(value: ProfileDraft): string {
    return JSON.stringify(value);
  }

  function updateDraft(change: Partial<ProfileDraft>): void {
    draft = { ...draft, ...change };
    validationErrors = [];
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
      case 'codex': return 'Codex'; case 'hermes': return 'Hermes';
    }
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
    <h1 id="profile-editor-title">{$t(profile === undefined ? 'Create profile' : 'Edit profile')}</h1>
    {#if readOnly}<p class="notice" role="status">{$t('Read-only mode. Profile data is shown, but changes cannot be saved.')}</p>{/if}
  </header>

  {#if error || validationErrors.length > 0}
    <div class="error-summary" role="alert" tabindex="-1" bind:this={errorSummary}>
      <strong>{$t('Profile was not saved.')}</strong>
      {#if error}<p>{$t(error)}</p>{/if}
      {#if validationErrors.length > 0}<ul>{#each validationErrors as validationError}<li>{$t(validationError)}</li>{/each}</ul>{/if}
    </div>
  {/if}

  <section aria-label={$t('Agent identity')}>
    <label for="profile-name">{$t('Name')}</label>
    <input id="profile-name" value={draft.name} oninput={(event) => updateDraft({ name: event.currentTarget.value })} disabled={disabled} autocomplete="off" />
  </section>

  <section aria-label={$t('Runtime')}>
    {#if profile === undefined}
      <label for="profile-harness">{$t('Harness')}</label>
      <select id="profile-harness" value={draft.harness} onchange={(event) => updateDraft({ harness: event.currentTarget.value as Harness, model: '', modelProvider: '', reasoning: '', networkAccess: false })} disabled={disabled}>
        <option value="pi">{$t('Pi')}</option>
        <option value="prime-agent">{$t('Prime Agent')}</option>
        <option value="codex">{$t('Codex')}</option>
        <option value="hermes">Hermes</option>
      </select>
    {:else}
      <p class="static-field"><strong>{$t('Harness')}</strong><span>{harnessLabel(draft.harness)}</span></p>
    {/if}

    <label for="profile-model">{$t('Model')}</label>
    <select id="profile-model" value={JSON.stringify([draft.modelProvider || undefined, draft.model])} onchange={(event) => { const model = nativeCatalog?.models.find(item => JSON.stringify([item.provider,item.id]) === event.currentTarget.value); if (model) updateDraft({ model: model.id, modelProvider: model.provider ?? '', reasoning: '', serviceTier: model.supportsFast && draft.serviceTier === 'fast' ? 'fast' : 'standard' }); }} disabled={disabled || catalogLoading}>
      {#if !nativeModel}<option disabled={!draft.model} hidden={!draft.model} value={JSON.stringify([draft.modelProvider || undefined,draft.model])}>{draft.model || $t(catalogLoading ? 'Loading models…' : 'Select model')}</option>{/if}
      {#each nativeCatalog?.models ?? [] as model}<option value={JSON.stringify([model.provider, model.id])}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}
    </select>
    {#if catalogError}<p role="alert">{$t(catalogError)}</p><button class="button button--quiet catalog-refresh" type="button" onclick={() => loadCatalog(true)}>{$t('Try again')}</button>{:else}<button class="button button--quiet catalog-refresh" type="button" onclick={() => loadCatalog(true)} disabled={catalogLoading || disabled}>{$t(catalogLoading ? 'Loading models…' : 'Refresh models')}</button>{/if}


  </section>

  <details class="advanced" bind:open={modelOptionsOpen}>
    <summary>{$t('Model options')}</summary>
  <section aria-label={$t('Inference settings')}>
    <div class="field-grid">
      <label>{$t("Reasoning")}
        <select aria-label={$t('Reasoning')} value={draft.reasoning} onchange={(event) => updateDraft({ reasoning: event.currentTarget.value })} disabled={disabled || !nativeModel?.thinkingLevels?.length}>
          <option value="">{$t('Model default')}</option>
          {#if draft.reasoning && !nativeModel?.thinkingLevels?.includes(draft.reasoning)}<option value={draft.reasoning}>{draft.reasoning}</option>{/if}
          {#each nativeModel?.thinkingLevels ?? [] as level}<option value={level}>{$t(level)}</option>{/each}
        </select>
      </label>
      {#if configuration.speed}<label>{$t("Speed")}
        <select aria-label={$t('Speed')} value={draft.serviceTier} onchange={(event) => updateDraft({ serviceTier: event.currentTarget.value as 'standard' | 'fast' })} disabled={disabled}><option value="standard">{$t('Standard')}</option><option value="fast" disabled={!nativeModel?.supportsFast}>{$t('Fast')}</option></select>
      </label>{/if}
    </div>

  </section>
  </details>

  <section aria-labelledby="instructions-heading">
    <h2 id="instructions-heading">{$t('Instructions')}</h2>
    {#if configuration.basePrompt}
      <label class="mandatory"><input type="checkbox" checked={!draft.replaceBasePrompt} onchange={(event) => updateDraft({ replaceBasePrompt: !event.currentTarget.checked, baseInstructions: '' })} disabled={disabled} /> {$t('Use base prompt')}</label>
    {/if}
    <label for="profile-instructions">{$t('Additional instructions')}</label>
    <textarea id="profile-instructions" value={draft.instructions} oninput={(event) => updateDraft({ instructions: event.currentTarget.value })} disabled={disabled} spellcheck="true"></textarea>
    <details class="advanced"><summary>{$t('Role and result')}</summary>    <label for="profile-when">{$t('When to call')}</label><textarea id="profile-when" rows="3" value={draft.whenToCall} oninput={(event) => updateDraft({ whenToCall: event.currentTarget.value })} disabled={disabled}></textarea>
    <label for="profile-input">{$t('Input')}</label><textarea id="profile-input" rows="4" value={draft.inputInstructions} oninput={(event) => updateDraft({ inputInstructions: event.currentTarget.value })} disabled={disabled}></textarea>
    <label for="profile-result">{$t('Expected result')}</label><textarea id="profile-result" rows="4" value={draft.expectedResult} oninput={(event) => updateDraft({ expectedResult: event.currentTarget.value })} disabled={disabled}></textarea>
</details>
  </section>

  <details class="advanced" open={primeStrictPermission || draft.toolRules.length > 0}>
    <summary>{$t('Permissions and tools ')}<span>{draft.permissionMode === 'native' ? $t('Native defaults') : $t(draft.permissionMode)}</span></summary>
    <section aria-label={$t('Permissions and resources')}>
      <label for="profile-permission">{$t('File access')}</label>
      <select id="profile-permission" value={draft.permissionMode} onchange={(event) => { const permissionMode = event.currentTarget.value as PermissionMode; updateDraft({ permissionMode, ...(!['read-only', 'workspace-write'].includes(permissionMode) ? { networkAccess: false } : {}) }); }} disabled={disabled}>
        <option value="native">{$t('Native permissions')}</option><option value="read-only">{$t('Read-only')}</option><option value="workspace-write">{$t('Workspace write')}</option><option value="full-access">{$t('Full access')}</option>
      </select>
      <p class="field-note">{$t(permissionDescription(draft.permissionMode))}</p>
      {#if primeStrictPermission}<p class="rule-warning">{$t('Prime Agent rejects this strict permission mode. Choose a supported mode to launch.')}</p>{/if}
      {#if configuration.networkAccess}
        <label class="mandatory"><input type="checkbox" checked={draft.networkAccess} onchange={(event) => updateDraft({ networkAccess: event.currentTarget.checked })} disabled={disabled || !['read-only', 'workspace-write'].includes(draft.permissionMode)} /> {$t('Allow network access')}</label>
        <p class="field-note">{$t('Grants this Codex profile native outbound network access. It is disabled by default.')}</p>
      {/if}

    <ResourcePicker profile={{ id: draft.id, name: draft.name, harness: draft.harness, model: draft.model, permissionMode: draft.permissionMode, instructions: draft.instructions, allowedSpawnProfileIds: draft.allowedSpawnProfileIds, toolPolicy: { rules: draft.toolRules }, resourceRules: draft.resourceRules }} items={nativeCatalog?.resources.items ?? []} loading={catalogLoading} {disabled} onchange={(patch) => updateDraft({ ...(patch.toolPolicy ? { toolRules: [...patch.toolPolicy.rules] } : {}), ...(patch.resourceRules ? { resourceRules: [...patch.resourceRules] } : {}) })} />
    {#each nativeCatalog?.resources.warnings ?? [] as warning}<p class="field-note">{$t(warning)}</p>{/each}
  </section>
  </details>  <details class="advanced" open={draft.allowedSpawnProfileIds.length > 0}>
    <summary>{$t('Subagents ')}<span>{draft.allowedSpawnProfileIds.length ? $t("{0} allowed profiles", [draft.allowedSpawnProfileIds.length]) : $t('Disabled')}</span></summary>
    <section aria-labelledby="spawn-heading">
    <h2 id="spawn-heading">{$t('Allowed profiles')}</h2>
    <p class="section-note">{$t('Choose which agents this profile may create. This controls workspace delegation, not native processes or OS access.')}</p>
    {#if spawnOptions.length === 0}<p class="empty">{$t('Save another profile to allow delegation.')}</p>{/if}
    <div class="spawn-options">
      {#each spawnOptions as candidate (candidate.id)}
        <label><input type="checkbox" checked={draft.allowedSpawnProfileIds.includes(candidate.id)} onchange={() => toggleSpawnProfile(candidate.id)} disabled={disabled} /> <span>{candidate.name || $t('Unnamed profile')}{candidate.id === draft.id ? $t(' (current profile)') : ''} <small>{harnessLabel(candidate.harness)} · {candidate.model}</small></span></label>
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
    <span class="save-state" aria-live="polite">{busy ? $t('Saving…') : dirty ? $t('Unsaved changes') : $t('Saved')}</span>
    <div class="actions"><button class="button button--quiet" type="button" onclick={requestCancel} disabled={busy}>{$t('Cancel')}</button>{#if !readOnly}<button class="button button--primary" type="submit" disabled={busy}>{busy ? $t('Saving…') : $t('Save profile')}</button>{/if}</div>
  </footer>
</form>

<style>
  .catalog-refresh { justify-self: start; margin-top: var(--piui-space-1); }
  .advanced { border-top:1px solid var(--piui-border-subtle); margin-bottom:var(--piui-space-4); }
  .advanced summary { cursor:pointer; padding:var(--piui-space-3) 0; font-size:14px; font-weight:600; }
  .advanced summary span { margin-left:.6rem; color:var(--piui-text-muted); font-size:12px; font-weight:400; }
  .advanced summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .advanced section { border:0; margin-bottom:var(--piui-space-4); padding-top:0; }

  .static-field { display: grid; gap: 5px; margin: 0; font-size: 13px; }.static-field strong { font-weight: 650; }.static-field span { min-height: 32px; padding: 6px 9px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text-muted); }
  .editor { max-width: 840px; padding: 0; color: var(--piui-text); }
  header, section { margin: 0 0 var(--piui-space-5); } h1, h2 { margin: 0; letter-spacing: -.025em; } h1 { font-size: 21px; } h2 { font-size: 16px; } .section-note, .field-note, .empty { color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; } .notice, .error-summary, .discard-choice { margin: 0 0 var(--piui-space-5); padding: var(--piui-space-3); border: 1px solid var(--piui-warning-border); border-radius: var(--piui-radius-sm); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 13px; line-height: 1.5; } .error-summary { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error-summary p, .error-summary ul { margin: var(--piui-space-2) 0 0; }
  section { display: grid; gap: var(--piui-space-2); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border-subtle); } label { display: grid; gap: 5px; color: var(--piui-text); font-size: 13px; font-weight: 650; } label span { color: var(--piui-text-muted); font-weight: 500; } input, select, textarea { box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 9px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; } textarea { min-height: 160px; max-height: 360px; resize: vertical; line-height: 1.5; } input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; } .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--piui-space-3); }.spawn-options label { grid-template-columns: auto 1fr; align-items: start; padding: var(--piui-space-2); border-radius: var(--piui-radius-sm); }.mandatory input, .spawn-options input { width: 16px; min-height: 16px; margin-top: 2px; }.spawn-options small { display: block; margin-top: 3px; color: var(--piui-text-muted); font-size: 12px; font-weight: 400; }.mandatory { grid-template-columns: auto 1fr; align-items: center; }.rule-warning { grid-column: span 2; margin: 0; font-size: 12px; }.rule-warning { color: var(--piui-warning-text); }.spawn-options { display: grid; gap: var(--piui-space-1); }.spawn-options label:hover { background: var(--piui-surface-1); }.button { min-height: 32px; padding: 0 var(--piui-space-3); border: 1px solid transparent; border-radius: var(--piui-radius-sm); color: var(--piui-text); font: inherit; font-size: 13px; font-weight: 650; }.button--quiet { background: transparent; border-color: var(--piui-border); }.button--quiet:hover:not(:disabled) { background: var(--piui-surface-2); }.button--primary { background: var(--piui-action); color: var(--piui-action-ink); }.button--danger { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.button:disabled, input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; opacity: .6; } footer { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border); }.save-state { color: var(--piui-text-muted); font-size: 13px; }.actions { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); }.discard-choice { margin-top: calc(var(--piui-space-7) * -1); }.discard-choice h2, .discard-choice p { margin: 0; }.discard-choice p { margin-top: var(--piui-space-2); }.discard-choice .actions { margin-top: var(--piui-space-3); }
  @media (max-width: 620px) { .editor { padding: var(--piui-space-4); }.field-grid { grid-template-columns: 1fr; }.rule-warning { grid-column: auto; } footer { align-items: flex-start; flex-direction: column; } }
</style>
