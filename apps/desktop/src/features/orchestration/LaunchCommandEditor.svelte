<script lang="ts">
  import type { LaunchCommandReference } from '../../../../../contracts/orchestration-v2';
  import type { DefinitionSummary } from '../../../../../contracts/orchestration-host-v2';
  export let command: LaunchCommandReference | undefined;
  export let teams: readonly DefinitionSummary[] = [];
  export let pipelines: readonly DefinitionSummary[] = [];
  export let busy = false;
  export let error: string | undefined = undefined;
  export let readOnly = false;
  export let onSave: (command: LaunchCommandReference) => void;
  export let onCancel: () => void;
  export let onDirtyChange: (dirty: boolean) => void = () => {};
  let draft: LaunchCommandReference = command ? { ...command } : { id: crypto.randomUUID(), name: '', teamId: '', pipelineId: '' };
  const baseline = JSON.stringify(draft);
  let validation: string | undefined;
  let discardPrompt = false;
  $: dirty = JSON.stringify(draft) !== baseline;
  $: onDirtyChange(dirty);
  function save(event: SubmitEvent): void {
    event.preventDefault();
    validation = !draft.name.trim() ? 'Enter a launch name.'
      : !teams.some((team) => team.id === draft.teamId) ? 'Choose an available team.'
      : !pipelines.some((pipeline) => pipeline.id === draft.pipelineId) ? 'Choose an available pipeline.' : undefined;
    if (!validation && !busy && !readOnly) onSave({ ...draft, name: draft.name.trim() });
  }
</script>

<form class="editor" onsubmit={save} aria-labelledby="launch-editor-title">
  <header><h2 id="launch-editor-title">{command ? 'Edit launch command' : 'Create launch command'}</h2><span>{readOnly ? 'Read-only' : dirty ? 'Unsaved changes' : 'No unsaved changes'}</span></header>
  <p class="hint">Save a name for a team and pipeline. This is a reusable definition reference, not a shell command. Saving does not start a run.</p>
  <fieldset disabled={busy || readOnly}>
    <label for="launch-name">Launch name</label><input id="launch-name" value={draft.name} oninput={(event) => draft = { ...draft, name: event.currentTarget.value }} autocomplete="off" />
    <label for="launch-team">Team</label><select id="launch-team" value={draft.teamId} onchange={(event) => draft = { ...draft, teamId: event.currentTarget.value }}><option value="">Choose team</option>{#if draft.teamId && !teams.some((team) => team.id === draft.teamId)}<option value={draft.teamId}>Unavailable team</option>{/if}{#each teams as team (team.id)}<option value={team.id}>{team.name}</option>{/each}</select>
    <label for="launch-pipeline">Pipeline</label><select id="launch-pipeline" value={draft.pipelineId} onchange={(event) => draft = { ...draft, pipelineId: event.currentTarget.value }}><option value="">Choose pipeline</option>{#if draft.pipelineId && !pipelines.some((pipeline) => pipeline.id === draft.pipelineId)}<option value={draft.pipelineId}>Unavailable pipeline</option>{/if}{#each pipelines as pipeline (pipeline.id)}<option value={pipeline.id}>{pipeline.name}</option>{/each}</select>
  </fieldset>
  {#if teams.length === 0 || pipelines.length === 0}<p class="notice">Create a team and a pipeline before saving a launch command.</p>{/if}
  <p class="hint">Launch execution and parameter inputs are not available in this editor contract. No native work starts here.</p>
  {#if validation || error}<p class="error" role="alert">{error ?? validation}</p>{/if}
  {#if discardPrompt}<div class="discard" role="group" aria-label="Unsaved launch command changes"><p>Discard unsaved changes?</p><button type="button" onclick={() => discardPrompt = false}>Keep editing</button><button type="button" onclick={onCancel}>Discard changes</button></div>{/if}
  <footer><button type="button" disabled={busy} onclick={() => { if (dirty && !readOnly) discardPrompt = true; else onCancel(); }}>{readOnly ? 'Back' : 'Cancel'}</button>{#if !readOnly}<button type="submit" class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save launch command'}</button>{/if}</footer>
</form>

<style>
  .editor { display: grid; gap: var(--piui-space-4); color: var(--piui-text); }header, footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--piui-space-3); }h2, p { margin: 0; }h2 { font-size: 22px; letter-spacing: -.02em; }header span, .hint { color: var(--piui-text-muted); font-size: 12px; line-height: 1.5; }fieldset { display: grid; gap: var(--piui-space-2); margin: 0; padding: 0; border: 0; min-width: 0; }label { font-size: 13px; font-weight: 600; }label:not(:first-child) { margin-top: var(--piui-space-3); }input, select { min-width: 0; width: 100%; padding: var(--piui-space-3); border: 1px solid var(--piui-border-strong); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font-size: 13px; }button { min-height: 36px; padding: var(--piui-space-2) var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font-size: 13px; }button:hover:not(:disabled) { background: var(--piui-surface-2); }button:disabled { opacity: .6; }button.primary { border: 0; background: var(--piui-accent); color: var(--piui-accent-ink); font-weight: 600; }footer { justify-content: flex-end; padding-top: var(--piui-space-4); border-top: 1px solid var(--piui-border); }.notice, .error, .discard { margin: 0; padding: var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 13px; line-height: 1.5; }.notice, .discard { background: var(--piui-warning-surface); color: var(--piui-warning-text); }.error { border: 1px solid var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.discard { display: flex; flex-wrap: wrap; align-items: center; gap: var(--piui-space-2); }
</style>
