<script lang="ts">
  import { t } from '../locale/language';
  import type { DefinitionSummary, StoredDefinition } from '../../../../../contracts/orchestration-host-v6';
  import type { LaunchCommandReference } from '../../../../../contracts/orchestration-v6';
  import { initialRunLaunchSelection, validateRunLaunchSelection, type RunLaunchSelection } from './runLaunch';

  export let teams: readonly DefinitionSummary[] = [];
  export let pipelines: readonly DefinitionSummary[] = [];
  export let command: StoredDefinition<LaunchCommandReference> | undefined;
  export let busy = false;
  export let error: string | undefined;
  export let readOnly = false;
  export let locked = false;
  export let onStart: (selection: RunLaunchSelection) => void;
  export let onCancel: () => void;

  let selection = initialRunLaunchSelection(command);
  let sourceCommandId = command?.value.id;
  let validationErrors: readonly string[] = [];

  $: selectorLocked = locked || command !== undefined;
  $: disabled = busy || readOnly || selectorLocked;
  $: if (command?.value.id !== sourceCommandId && !locked) {
    sourceCommandId = command?.value.id;
    selection = initialRunLaunchSelection(command);
    validationErrors = [];
  }

  function selectTeam(event: Event): void {
    selection = { ...selection, teamId: (event.currentTarget as HTMLSelectElement).value };
    validationErrors = [];
  }

  function selectPipeline(event: Event): void {
    selection = { ...selection, pipelineId: (event.currentTarget as HTMLSelectElement).value };
    validationErrors = [];
  }

  function start(): void {
    if (busy || readOnly) return;
    const errors = validateRunLaunchSelection(selection, teams, pipelines, command);
    validationErrors = errors;
    if (errors.length === 0) onStart(selection);
  }
</script>

<form class="launcher" aria-labelledby="run-launcher-title" onsubmit={(event) => { event.preventDefault(); start(); }}>
  <header>
    <p class="eyebrow">{$t('Run')}</p>
    <h1 id="run-launcher-title">{command === undefined ? 'Start run' : command.value.name}</h1>
    {#if command !== undefined}<p class="command-note">{$t('Named launch command. Its saved team and pipeline references are locked.')}</p>{/if}
  </header>

  {#if error || validationErrors.length > 0}
    <div class="error-summary" role="alert">
      <strong>{$t('Launch request needs attention.')}</strong>
      {#if error}<p>{error}</p>{/if}
      {#if validationErrors.length > 0}<ul>{#each validationErrors as issue}<li>{issue}</li>{/each}</ul>{/if}
    </div>
  {/if}

  {#if readOnly}<p class="notice" role="status">{$t('Read-only mode. Starting a run is disabled.')}</p>{/if}
  {#if locked}<p class="notice" role="status">{$t('This launch request is locked to the selected definitions. Retrying reuses the same run ID; it does not replay a task.')}</p>{/if}

  <section aria-label={$t('Run definition selection')}>
    <label for="run-team">{$t('Team')}</label>
    <select id="run-team" value={selection.teamId} onchange={selectTeam} disabled={disabled}>
      <option value="">{$t('Select a team')}</option>
      {#if selection.teamId && !teams.some((team) => team.id === selection.teamId)}<option value={selection.teamId}>Unavailable team ({selection.teamId})</option>{/if}
      {#each teams as team (team.id)}<option value={team.id}>{team.name}</option>{/each}
    </select>

    <label for="run-pipeline">{$t('Pipeline')}</label>
    <select id="run-pipeline" value={selection.pipelineId} onchange={selectPipeline} disabled={disabled}>
      <option value="">{$t('Select a pipeline')}</option>
      {#if selection.pipelineId && !pipelines.some((pipeline) => pipeline.id === selection.pipelineId)}<option value={selection.pipelineId}>Unavailable pipeline ({selection.pipelineId})</option>{/if}
      {#each pipelines as pipeline (pipeline.id)}<option value={pipeline.id}>{pipeline.name}</option>{/each}
    </select>
  </section>

  <section class="explanation" aria-label={$t('Launch information')}>
    <p>{$t('The host uses the latest saved definitions and checks native readiness and policy. The returned run snapshot is authoritative.')}</p>
    <p>{$t('Leaving this view does not cancel requested native work.')}</p>
  </section>

  <footer>
    <button class="button button--quiet" type="button" onclick={onCancel} disabled={busy}>{$t('Back')}</button>
    {#if !readOnly}<button class="button button--primary" type="submit" disabled={busy}>{busy ? 'Requesting launch…' : locked ? 'Retry same launch request' : 'Start run'}</button>{/if}
  </footer>
</form>

<style>
  .launcher { max-width: 680px; padding: var(--piui-space-7); color: var(--piui-text); }.eyebrow { margin: 0 0 var(--piui-space-2); color: var(--piui-accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }h1 { margin: 0; font-size: 21px; letter-spacing: -.025em; }.command-note, .explanation p { color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; }.command-note { margin: var(--piui-space-3) 0 0; }.error-summary, .notice { margin: var(--piui-space-5) 0 0; padding: var(--piui-space-3); border: 1px solid var(--piui-danger-border); border-radius: var(--piui-radius-sm); background: var(--piui-danger-surface); color: var(--piui-danger-text); font-size: 13px; line-height: 1.5; }.notice { border-color: var(--piui-warning-border); background: var(--piui-warning-surface); color: var(--piui-warning-text); }.error-summary p, .error-summary ul { margin: var(--piui-space-2) 0 0; }section { display: grid; gap: var(--piui-space-2); margin-top: var(--piui-space-6); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border-subtle); }label { color: var(--piui-text); font-size: 13px; font-weight: 650; }select { box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 9px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; }select:focus-visible, button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }.explanation { gap: var(--piui-space-1); }.explanation p { margin: 0; }footer { display: flex; justify-content: flex-end; gap: var(--piui-space-2); margin-top: var(--piui-space-6); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border); }.button { min-height: 32px; padding: 0 var(--piui-space-3); border: 1px solid transparent; border-radius: var(--piui-radius-sm); font: inherit; font-size: 13px; font-weight: 650; }.button--quiet { border-color: var(--piui-border); background: transparent; color: var(--piui-text); }.button--primary { background: var(--piui-action); color: var(--piui-action-ink); }.button:disabled, select:disabled { cursor: not-allowed; opacity: .6; }@media (max-width: 620px) { .launcher { padding: var(--piui-space-4); }footer { justify-content: space-between; } }
</style>
