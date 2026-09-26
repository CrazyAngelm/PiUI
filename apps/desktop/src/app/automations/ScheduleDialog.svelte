<script lang="ts">
  import { t } from '../../features/locale/language';
  import { localDateTimeToInstant, localDateTimeValue, positiveInteger } from '../../features/orchestration/scheduleForm';
  import type { DefinitionSummary, MissedRunPolicy, OverlapPolicy, ScheduleDefinition, ScheduleSnapshot } from '../../host-api/orchestrationClient';
  import { Button, Dialog, Field, Input, Segmented } from '../../lib/ui';

  interface Props {
    open: boolean;
    schedule: ScheduleSnapshot | undefined;
    launchCommands: readonly DefinitionSummary[];
    busy: boolean;
    error: string;
    onSave: (value: ScheduleDefinition, enable: boolean) => Promise<boolean>;
  }
  let { open = $bindable(false), schedule, launchCommands, busy, error, onSave }: Props = $props();

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let id = $state('');
  let name = $state('');
  let nameTouched = $state(false);
  let launchCommandId = $state('');
  let kind = $state<'once' | 'interval'>('interval');
  let localAt = $state('');
  let every = $state('1');
  let unit = $state<'minutes' | 'hours'>('hours');
  let missed = $state<MissedRunPolicy>('skip');
  let overlap = $state<OverlapPolicy>('skip');
  let problem = $state('');
  let timeZone = $state(zone);

  /** Next whole quarter hour in the local zone, as a datetime-local value. */
  function soon(): string {
    const date = new Date(Date.now() + 15 * 60_000);
    date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
    return localDateTimeValue(date.toISOString(), zone);
  }

  $effect(() => {
    if (!open) return;
    const value = schedule?.value;
    id = value?.id ?? crypto.randomUUID();
    name = value?.name ?? '';
    nameTouched = !!value;
    launchCommandId = value?.launchCommandId ?? launchCommands[0]?.id ?? '';
    timeZone = value?.trigger.timeZone ?? zone;
    kind = value?.trigger.type ?? 'interval';
    localAt = value ? localDateTimeValue(value.trigger.type === 'once' ? value.trigger.at : value.trigger.anchorAt, timeZone) : soon();
    every = value?.trigger.type === 'interval' ? String(value.trigger.every) : '1';
    unit = value?.trigger.type === 'interval' ? value.trigger.unit : 'hours';
    missed = value?.missedRunPolicy ?? 'skip';
    overlap = value?.overlapPolicy ?? 'skip';
    problem = '';
  });

  // Until the person names it, the schedule is named after its pipeline.
  $effect(() => {
    if (!nameTouched) name = launchCommands.find((command) => command.id === launchCommandId)?.name ?? '';
  });

  const instant = $derived(localDateTimeToInstant(localAt, timeZone));
  const interval = $derived(positiveInteger(every));

  function build(): ScheduleDefinition | undefined {
    problem = !name.trim()
      ? 'Enter a schedule name.'
      : !launchCommands.some((command) => command.id === launchCommandId)
        ? 'Choose a pipeline.'
        : !instant.ok && instant.reason === 'nonexistent'
          ? 'This local time does not exist because the clock changes. Choose another time.'
          : !instant.ok && instant.reason === 'ambiguous'
            ? 'This local time occurs twice because the clock changes. Choose another time.'
            : !instant.ok
              ? 'Choose a valid date and time.'
              : kind === 'interval' && interval === undefined
                ? 'Enter a positive whole-number interval.'
                : '';
    if (problem || !instant.ok) return undefined;
    const trigger =
      kind === 'once'
        ? { type: 'once' as const, at: instant.instant, timeZone }
        : { type: 'interval' as const, every: interval ?? 1, unit, anchorAt: instant.instant, timeZone };
    const previous = schedule?.value;
    return { ...(previous ?? {}), id, name: name.trim(), launchCommandId, trigger, missedRunPolicy: missed, overlapPolicy: overlap };
  }

  async function submit(enable: boolean): Promise<void> {
    const value = build();
    if (!value) return;
    if (await onSave(value, enable)) open = false;
  }
</script>

<Dialog bind:open title={schedule ? $t('Edit automation') : $t('New automation')} description={$t('Runs a saved pipeline on a schedule while PiUI is open.')} size="md">
  <form class="form" id="schedule-form" onsubmit={(event) => { event.preventDefault(); void submit(true); }} novalidate>
    <Field label={$t('Pipeline')} for="schedule-pipeline">
      <select id="schedule-pipeline" class="select" bind:value={launchCommandId} disabled={busy}>
        {#if launchCommands.length === 0}<option value="">{$t('No saved pipelines')}</option>{/if}
        {#each launchCommands as command (command.id)}
          <option value={command.id}>{command.name || $t('Untitled pipeline')}</option>
        {/each}
      </select>
    </Field>
    <Field label={$t('Name')} for="schedule-name">
      <Input id="schedule-name" value={name} disabled={busy} oninput={(event) => { name = event.currentTarget.value; nameTouched = true; }} />
    </Field>
    <Field label={$t('When')}>
      <Segmented
        label={$t('When')}
        bind:value={kind}
        options={[
          { value: 'interval', label: $t('Repeat') },
          { value: 'once', label: $t('Once') },
        ]}
      />
    </Field>
    <div class="row">
      <Field label={kind === 'once' ? $t('Run at') : $t('First run at')} for="schedule-at" description={$t('Time zone: {0}', [timeZone])}>
        <input id="schedule-at" class="select" type="datetime-local" bind:value={localAt} disabled={busy} />
      </Field>
      {#if kind === 'interval'}
        <Field label={$t('Repeat every')} for="schedule-every">
          <div class="every">
            <Input id="schedule-every" inputmode="numeric" value={every} disabled={busy} oninput={(event) => (every = event.currentTarget.value)} />
            <select class="select" aria-label={$t('Interval unit')} bind:value={unit} disabled={busy}>
              <option value="minutes">{$t('minutes')}</option>
              <option value="hours">{$t('hours')}</option>
            </select>
          </div>
        </Field>
      {/if}
    </div>
    <Field label={$t('If PiUI was closed at that time')}>
      <Segmented
        label={$t('If PiUI was closed at that time')}
        bind:value={missed}
        options={[
          { value: 'skip', label: $t('Skip it') },
          { value: 'coalesce', label: $t('Run once when PiUI opens') },
        ]}
      />
    </Field>
    <Field label={$t('If the previous run is still working')}>
      <Segmented
        label={$t('If the previous run is still working')}
        bind:value={overlap}
        options={[
          { value: 'skip', label: $t('Skip this time') },
          { value: 'allow', label: $t('Start another run') },
        ]}
      />
    </Field>
    <p class="note">{$t('Automations run only while PiUI is open; they do not wake the computer. Each run uses your harness subscriptions like a manual run.')}</p>
    {#if problem || error}<p class="error" role="alert">{$t(problem || error)}</p>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button disabled={busy || launchCommands.length === 0} onclick={() => void submit(false)}>{$t('Save, keep paused')}</Button>
    <Button variant="primary" type="submit" form="schedule-form" loading={busy} disabled={launchCommands.length === 0}>{$t('Save and turn on')}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: var(--piui-space-4);
  }
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--piui-space-3);
  }
  .every {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: var(--piui-space-2);
  }
  .select {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .note {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
