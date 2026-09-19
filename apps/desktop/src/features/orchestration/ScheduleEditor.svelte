<script lang="ts">
  import { t } from '../locale/language';
  import type {
    DefinitionSummary,
    MissedRunPolicy,
    OverlapPolicy,
    ScheduleDefinition,
    ScheduleSnapshot,
  } from '../../host-api/orchestrationClient';
  import { localDateTimeToInstant, localDateTimeValue, positiveInteger } from './scheduleForm';

  export let schedule: ScheduleSnapshot | undefined;
  export let launchCommands: readonly DefinitionSummary[] = [];
  export let busy = false;
  export let error: string | undefined = undefined;
  export let readOnly = false;
  export let onSave: (value: ScheduleDefinition) => void;
  export let onCancel: () => void;
  export let onDirtyChange: (dirty: boolean) => void = () => {};

  const source = schedule?.value;
  const sourceTrigger = source?.trigger;
  const timeZone = sourceTrigger?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  let id = source?.id ?? crypto.randomUUID();
  let name = source?.name ?? '';
  let launchCommandId = source?.launchCommandId ?? '';
  let triggerType: 'once' | 'interval' = sourceTrigger?.type ?? 'once';
  let localAt = sourceTrigger === undefined ? '' : localDateTimeValue(sourceTrigger.type === 'once' ? sourceTrigger.at : sourceTrigger.anchorAt, timeZone);
  let every = sourceTrigger?.type === 'interval' ? String(sourceTrigger.every) : '1';
  let unit: 'minutes' | 'hours' = sourceTrigger?.type === 'interval' ? sourceTrigger.unit : 'minutes';
  let missedRunPolicy: MissedRunPolicy | '' = source?.missedRunPolicy ?? '';
  let overlapPolicy: OverlapPolicy | '' = source?.overlapPolicy ?? '';
  let validation: string | undefined;
  let discardPrompt = false;
  const baseline = JSON.stringify({ id, name, launchCommandId, triggerType, localAt, every, unit, missedRunPolicy, overlapPolicy });
  $: dirty = JSON.stringify({ id, name, launchCommandId, triggerType, localAt, every, unit, missedRunPolicy, overlapPolicy }) !== baseline;
  $: onDirtyChange(dirty);

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const instant = localDateTimeToInstant(localAt, timeZone);
    const interval = triggerType === 'interval' ? positiveInteger(every) : 1;
    validation = !name.trim() ? 'Enter a schedule name.'
      : !launchCommands.some((command) => command.id === launchCommandId) ? 'Choose an available launch command.'
      : !localAt ? 'Choose a date and time.'
      : !instant.ok && instant.reason === 'nonexistent' ? 'This local time does not exist because the clock changes. Choose another time.'
      : !instant.ok && instant.reason === 'ambiguous' ? 'This local time occurs twice because the clock changes. Choose another time.'
      : !instant.ok ? 'Choose a valid date and time.'
      : interval === undefined ? 'Enter a positive whole-number interval.'
      : !missedRunPolicy ? 'Choose what happens after PiUI was closed.'
      : !overlapPolicy ? 'Choose what happens while the previous run is active.'
      : undefined;
    if (validation || !instant.ok || interval === undefined || !missedRunPolicy || !overlapPolicy || busy || readOnly) return;
    const trigger = triggerType === 'once'
      ? { type: 'once' as const, at: instant.instant, timeZone }
      : { type: 'interval' as const, every: interval, unit, anchorAt: instant.instant, timeZone };
    onSave({ id, name: name.trim(), launchCommandId, trigger, missedRunPolicy, overlapPolicy });
  }
</script>

<form class="editor" onsubmit={save} aria-labelledby="schedule-editor-title">
  <header>
    <div><p class="eyebrow">{$t('Automation')}</p><h2 id="schedule-editor-title">{schedule ? $t('Edit schedule') : $t('Create schedule')}</h2></div>
    <span>{readOnly ? $t('Read-only') : dirty ? $t('Unsaved changes') : $t('No unsaved changes')}</span>
  </header>
  <p class="notice">{$t('Schedules run only while the PiUI host is open. They do not wake the computer or start PiUI.')}</p>
  <p class="hint">{$t('Saving does not enable execution. New schedules and execution-affecting edits must be enabled separately.')}</p>
  <fieldset disabled={busy || readOnly}>
    <label for="schedule-name">{$t('Schedule name')}</label>
    <input id="schedule-name" bind:value={name} autocomplete="off" />

    <label for="schedule-launch">{$t('Saved launch')}</label>
    <select id="schedule-launch" bind:value={launchCommandId}>
      <option value="">{$t('Choose launch command')}</option>
      {#each launchCommands as command (command.id)}<option value={command.id}>{command.name}</option>{/each}
    </select>

    <label for="schedule-trigger">{$t('Timing')}</label>
    <select id="schedule-trigger" bind:value={triggerType}>
      <option value="once">{$t('Once at a date and time')}</option>
      <option value="interval">{$t('Every interval')}</option>
    </select>

    <label for="schedule-at">{triggerType === 'once' ? $t('Run at') : $t('First run at')}</label>
    <input id="schedule-at" type="datetime-local" bind:value={localAt} />
    <p class="field-note">{$t('Local time zone')}: {timeZone}</p>

    {#if triggerType === 'interval'}
      <div class="interval-row">
        <label for="schedule-every">{$t('Repeat every')}</label>
        <input id="schedule-every" inputmode="numeric" bind:value={every} />
        <select aria-label={$t('Interval unit')} bind:value={unit}><option value="minutes">{$t('Minutes')}</option><option value="hours">{$t('Hours')}</option></select>
      </div>
    {/if}

    <label for="schedule-missed">{$t('After PiUI was closed')}</label>
    <select id="schedule-missed" bind:value={missedRunPolicy}>
      <option value="">{$t('Choose a policy')}</option>
      <option value="skip">{$t('Skip missed occurrences')}</option>
      <option value="coalesce">{$t('Run once when PiUI returns')}</option>
    </select>

    <label for="schedule-overlap">{$t('While a previous run is active')}</label>
    <select id="schedule-overlap" bind:value={overlapPolicy}>
      <option value="">{$t('Choose a policy')}</option>
      <option value="skip">{$t('Skip the new occurrence')}</option>
      <option value="allow">{$t('Allow another run')}</option>
    </select>
  </fieldset>

  {#if validation || error}<p class="error" role="alert">{$t(error ?? validation ?? '')}</p>{/if}
  {#if launchCommands.length === 0}<p class="notice" role="status">{$t('Create a saved launch command before adding a schedule.')}</p>{/if}
  {#if discardPrompt}<div class="discard" role="group" aria-label={$t('Unsaved schedule changes')}><p>{$t('Discard unsaved changes?')}</p><button type="button" onclick={() => discardPrompt = false}>{$t('Keep editing')}</button><button type="button" onclick={onCancel}>{$t('Discard changes')}</button></div>{/if}
  <footer><button type="button" disabled={busy} onclick={() => { if (dirty && !readOnly) discardPrompt = true; else onCancel(); }}>{readOnly ? $t('Back') : $t('Cancel')}</button>{#if !readOnly}<button class="primary" type="submit" disabled={busy || launchCommands.length === 0}>{busy ? $t('Saving…') : $t('Save schedule')}</button>{/if}</footer>
</form>

<style>
  .editor { display:grid; gap:var(--piui-space-4); max-width:720px; color:var(--piui-text); }
  header, footer { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:var(--piui-space-3); }
  h2, p { margin:0; } h2 { font-size:22px; letter-spacing:-.02em; }
  .eyebrow { color:var(--piui-accent); font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  header span, .hint, .field-note { color:var(--piui-text-muted); font-size:12px; line-height:1.5; }
  fieldset { display:grid; gap:var(--piui-space-2); margin:0; padding:0; border:0; min-width:0; }
  label { margin-top:var(--piui-space-3); font-size:13px; font-weight:650; }
  input, select { box-sizing:border-box; width:100%; min-height:36px; padding:7px 9px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); background:var(--piui-surface-1); color:var(--piui-text); font:inherit; }
  .interval-row { display:grid; grid-template-columns:1fr 1fr; gap:var(--piui-space-2); align-items:end; }.interval-row label { grid-column:1 / -1; }
  .notice, .error, .discard { padding:var(--piui-space-3); border-radius:var(--piui-radius-sm); font-size:13px; line-height:1.5; }
  .notice, .discard { background:var(--piui-warning-surface); color:var(--piui-warning-text); }.error { border:1px solid var(--piui-danger-border); background:var(--piui-danger-surface); color:var(--piui-danger-text); }
  .discard { display:flex; flex-wrap:wrap; align-items:center; gap:var(--piui-space-2); }
  footer { justify-content:flex-end; padding-top:var(--piui-space-4); border-top:1px solid var(--piui-border); }
  button { min-height:32px; padding:var(--piui-space-2) var(--piui-space-3); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); background:var(--piui-surface-1); color:var(--piui-text); font-size:13px; }
  button.primary { border:0; background:var(--piui-action); color:var(--piui-action-ink); font-weight:650; } button:disabled { opacity:.6; }
</style>
