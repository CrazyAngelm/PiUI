<script lang="ts">
  import { language, t } from '../../features/locale/language';
  import { localDateTimeToInstant, localDateTimeValue, positiveInteger } from '../../features/orchestration/scheduleForm';
  import type { DefinitionSummary, FinishedOutcome, MissedRunPolicy, OverlapPolicy, PipelineInput, ScheduleDefinition, ScheduleSnapshot, ScheduleTrigger } from '../../host-api/orchestrationClient';
  import { calendarFirstAfter, daySet, sortDays, validTime, weekdayNames, WEEKDAYS, WORKDAYS, type CalendarTrigger } from '../../host-api/scheduleCalendar';
  import { Button, Checkbox, Dialog, Field, Input, Segmented, Spinner, Textarea } from '../../lib/ui';
  import InputFields, { formState, formValues, type InputFormState } from '../pipelines/inputs/InputFields.svelte';
  import { checkValues, initialValues } from '../pipelines/inputs/runInputs';
  import { eventPreview, FINISHED_OUTCOMES } from './cadence';
  import { eventDraftFrom, eventDraftProblem, eventTriggerOf, startsItself, type EventDraft } from './eventDraft';

  interface Props {
    open: boolean;
    schedule: ScheduleSnapshot | undefined;
    launchCommands: readonly DefinitionSummary[];
    busy: boolean;
    error: string;
    loadInputs: (launchCommandId: string) => Promise<PipelineInput[]>;
    onSave: (value: ScheduleDefinition, enable: boolean) => Promise<boolean>;
  }
  let { open = $bindable(false), schedule, launchCommands, busy, error, loadInputs, onSave }: Props = $props();

  let inputs = $state.raw<PipelineInput[]>([]);
  let inputsLoading = $state(false);
  let form = $state<InputFormState>({ values: {}, numbers: {} });
  let inputErrors = $state<Record<string, string>>({});
  let loadedFor = '';

  type Mode = 'schedule' | 'event';
  type TimedKind = Exclude<ScheduleTrigger['type'], 'event'>;

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let id = $state('');
  let name = $state('');
  let nameTouched = $state(false);
  let launchCommandId = $state('');
  let mode = $state<Mode>('schedule');
  let kind = $state<TimedKind>('calendar');
  let time = $state('09:00');
  let days = $state<number[]>([...WEEKDAYS]);
  let localAt = $state('');
  let every = $state('1');
  let unit = $state<'minutes' | 'hours'>('hours');
  let missed = $state<MissedRunPolicy>('skip');
  let overlap = $state<OverlapPolicy>('skip');
  let problem = $state('');
  let timeZone = $state(zone);
  let draft = $state<EventDraft>(eventDraftFrom(undefined, ''));

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
    const target = value?.launchCommandId ?? launchCommands[0]?.id ?? '';
    launchCommandId = target;
    const trigger = value?.trigger;
    const timed = trigger?.type === 'event' ? undefined : trigger;
    mode = trigger?.type === 'event' ? 'event' : 'schedule';
    timeZone = timed?.timeZone ?? zone;
    kind = timed?.type ?? 'calendar';
    localAt = timed && timed.type !== 'calendar' ? localDateTimeValue(timed.type === 'once' ? timed.at : timed.anchorAt, timeZone) : soon();
    every = timed?.type === 'interval' ? String(timed.every) : '1';
    unit = timed?.type === 'interval' ? timed.unit : 'hours';
    time = timed?.type === 'calendar' ? timed.time : '09:00';
    days = timed?.type === 'calendar' ? sortDays(timed.days) : [...WEEKDAYS];
    missed = value?.missedRunPolicy ?? 'skip';
    overlap = value?.overlapPolicy ?? 'skip';
    // A new rule waits for another pipeline than the one it starts. Reading
    // `launchCommandId` here would re-run this reset on every pipeline change.
    const other = launchCommands.find((command) => command.id !== target) ?? launchCommands[0];
    draft = eventDraftFrom(trigger, other?.id ?? '');
    problem = '';
  });

  // Each pipeline declares its own inputs; a schedule stores values for them.
  $effect(() => {
    if (!open || !launchCommandId || loadedFor === launchCommandId) return;
    const target = launchCommandId;
    loadedFor = target;
    inputsLoading = true;
    void loadInputs(target)
      .then((declared) => {
        if (loadedFor !== target) return;
        inputs = declared;
        const saved = schedule?.value.launchCommandId === target ? (schedule.value.inputs ?? {}) : {};
        form = formState(declared, { ...initialValues(declared), ...saved });
        inputErrors = {};
      })
      .catch(() => {
        if (loadedFor === target) inputs = [];
      })
      .finally(() => {
        if (loadedFor === target) inputsLoading = false;
      });
  });
  $effect(() => {
    if (!open) loadedFor = '';
  });

  // Until the person names it, the schedule is named after its pipeline.
  $effect(() => {
    if (!nameTouched) name = launchCommands.find((command) => command.id === launchCommandId)?.name ?? '';
  });

  const instant = $derived(localDateTimeToInstant(localAt, timeZone));
  const interval = $derived(positiveInteger(every));

  const locale = $derived($language === 'ru' ? 'ru-RU' : 'en-US');
  const shortDays = $derived(weekdayNames(locale));
  const longDays = $derived(weekdayNames(locale, 'long'));
  const preset = $derived(daySet(days));
  const pipelineIds = $derived(launchCommands.map((command) => command.id));

  function pipelineName(commandId: string): string {
    const command = launchCommands.find((item) => item.id === commandId);
    return command ? command.name || $t('Untitled pipeline') : '';
  }

  const OUTCOME_LABELS: Record<FinishedOutcome, string> = {
    succeeded: 'Succeeds',
    failed: 'Fails',
    cancelled: 'Is stopped',
  };

  function toggleOutcome(outcome: FinishedOutcome, checked: boolean): void {
    const rest = draft.outcomes.filter((item) => item !== outcome);
    draft.outcomes = checked ? [...rest, outcome] : rest;
  }

  function toggleDay(day: number): void {
    days = days.includes(day) ? days.filter((item) => item !== day) : sortDays([...days, day]);
  }

  /** A changed rule applies from the moment it is saved; an unchanged one keeps its start. */
  function calendarTrigger(): CalendarTrigger {
    const previous = schedule?.value.trigger;
    const sorted = sortDays(days);
    const unchanged = previous?.type === 'calendar' && previous.time === time && previous.timeZone === timeZone
      && sortDays(previous.days).join() === sorted.join();
    const startsAt = unchanged ? previous.startsAt : new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    return { type: 'calendar', time, days: sorted, startsAt, timeZone };
  }

  const nextRun = $derived.by(() => {
    if (mode !== 'schedule' || kind !== 'calendar' || !validTime(time) || days.length === 0) return '';
    const now = Date.now();
    const at = calendarFirstAfter({ type: 'calendar', time, days, startsAt: new Date(now).toISOString(), timeZone }, now);
    return at === undefined
      ? ''
      : new Date(at).toLocaleString(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  });

  /** What a valid event rule will do, in plain words. */
  const eventNotes = $derived.by(() => {
    if (mode !== 'event') return [];
    const trigger = eventTriggerOf(draft, pipelineIds);
    return trigger ? eventPreview(trigger.event, pipelineName(launchCommandId) || $t('the pipeline'), $t, pipelineName) : [];
  });
  const selfLoop = $derived(mode === 'event' && startsItself(draft, launchCommandId));

  function timingProblem(): string {
    if (mode === 'event') return eventDraftProblem(draft, pipelineIds, $t);
    if (kind === 'calendar') return !validTime(time) ? 'Choose a time.' : days.length === 0 ? 'Choose at least one day.' : '';
    if (!instant.ok) {
      return instant.reason === 'nonexistent'
        ? 'This local time does not exist because the clock changes. Choose another time.'
        : instant.reason === 'ambiguous'
          ? 'This local time occurs twice because the clock changes. Choose another time.'
          : 'Choose a valid date and time.';
    }
    return kind === 'interval' && interval === undefined ? 'Enter a positive whole-number interval.' : '';
  }

  function trigger(): ScheduleTrigger | undefined {
    if (mode === 'event') return eventTriggerOf(draft, pipelineIds);
    if (kind === 'calendar') return calendarTrigger();
    if (!instant.ok) return undefined;
    return kind === 'once'
      ? { type: 'once', at: instant.instant, timeZone }
      : { type: 'interval', every: interval ?? 1, unit, anchorAt: instant.instant, timeZone };
  }

  function build(): ScheduleDefinition | undefined {
    problem = !name.trim()
      ? 'Enter a schedule name.'
      : !launchCommands.some((command) => command.id === launchCommandId)
        ? 'Choose a pipeline.'
        : timingProblem();
    const timing = problem ? undefined : trigger();
    if (!timing) return undefined;
    const checked = checkValues(inputs, formValues(inputs, form));
    inputErrors = checked.errors;
    if (Object.keys(checked.errors).length) {
      problem = 'Fill in the pipeline inputs below.';
      return undefined;
    }
    const { inputs: _previousInputs, ...previous } = schedule?.value ?? ({} as Partial<ScheduleDefinition>);
    return {
      ...previous,
      id,
      name: name.trim(),
      launchCommandId,
      trigger: timing,
      // Events are never replayed after a restart; the host requires "skip".
      missedRunPolicy: mode === 'event' ? 'skip' : missed,
      overlapPolicy: overlap,
      ...(Object.keys(checked.values).length ? { inputs: checked.values } : {}),
    };
  }

  async function submit(enable: boolean): Promise<void> {
    const value = build();
    if (!value) return;
    if (await onSave(value, enable)) open = false;
  }
</script>

<Dialog bind:open title={schedule ? $t('Edit automation') : $t('New automation')} description={$t('Runs a saved pipeline on a schedule or after an event while PiUI is open or in the tray.')} size="md">
  <form class="form" id="schedule-form" onsubmit={(event) => { event.preventDefault(); void submit(true); }} novalidate>
    <Field label={$t('Pipeline to run')} for="schedule-pipeline">
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
    <Field label={$t('Start')}>
      <Segmented
        label={$t('Start')}
        bind:value={mode}
        options={[
          { value: 'schedule', label: $t('On a schedule') },
          { value: 'event', label: $t('After an event') },
        ]}
      />
    </Field>
    {#if mode === 'schedule'}
      <Field label={$t('When')}>
        <Segmented
          label={$t('When')}
          bind:value={kind}
          options={[
            { value: 'calendar', label: $t('On days') },
            { value: 'interval', label: $t('Interval') },
            { value: 'once', label: $t('Once') },
          ]}
        />
      </Field>
      {#if kind === 'calendar'}
        <fieldset class="days" disabled={busy}>
          <legend>{$t('Days')}</legend>
          <div class="days__line">
            <div class="days__toggles">
              {#each WEEKDAYS as day, index (day)}
                <button type="button" class="day" aria-pressed={days.includes(day)} aria-label={longDays[index]} title={longDays[index]} onclick={() => toggleDay(day)}>
                  {shortDays[index]}
                </button>
              {/each}
            </div>
            <div class="days__presets">
              <button type="button" class="preset" aria-pressed={preset === 'every'} onclick={() => (days = [...WEEKDAYS])}>{$t('Every day')}</button>
              <button type="button" class="preset" aria-pressed={preset === 'workdays'} onclick={() => (days = [...WORKDAYS])}>{$t('Weekdays')}</button>
            </div>
          </div>
        </fieldset>
        <div class="row">
          <Field label={$t('Time')} for="schedule-time" description={$t('Time zone: {0}', [timeZone])}>
            <input id="schedule-time" class="select" type="time" bind:value={time} disabled={busy} />
          </Field>
        </div>
        {#if nextRun}<p class="note">{$t('Next run: {0}', [nextRun])}</p>{/if}
      {:else}
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
      {/if}
    {:else}
      <Field label={$t('Event')}>
        <Segmented
          label={$t('Event')}
          bind:value={draft.kind}
          options={[
            { value: 'run-finished', label: $t('When a pipeline finishes') },
            { value: 'files-changed', label: $t('When files change') },
          ]}
        />
      </Field>
      {#if draft.kind === 'run-finished'}
        <Field label={$t('Pipeline to wait for')} for="schedule-source">
          <select id="schedule-source" class="select" bind:value={draft.sourceId} disabled={busy}>
            {#if launchCommands.length === 0}<option value="">{$t('No saved pipelines')}</option>{/if}
            {#each launchCommands as command (command.id)}
              <option value={command.id}>{command.name || $t('Untitled pipeline')}</option>
            {/each}
          </select>
        </Field>
        <fieldset class="outcomes" disabled={busy}>
          <legend>{$t('Start when that pipeline')}</legend>
          <div class="outcomes__line">
            {#each FINISHED_OUTCOMES as outcome (outcome)}
              <Checkbox
                label={$t(OUTCOME_LABELS[outcome])}
                checked={draft.outcomes.includes(outcome)}
                disabled={busy}
                onCheckedChange={(checked) => toggleOutcome(outcome, checked)}
              />
            {/each}
          </div>
        </fieldset>
        {#if selfLoop}
          <p class="note note--warn" role="status">{$t('This automation starts the pipeline it waits for, so each run can start the next one. The chain stops after 3 automatic runs.')}</p>
        {/if}
      {:else}
        <Field
          label={$t('Files to watch')}
          for="schedule-include"
          description={$t('One pattern per line, relative to the project folder. src/**/*.ts matches TypeScript files under src; *.md matches Markdown files in any folder.')}
        >
          <Textarea id="schedule-include" bind:value={draft.include} minRows={2} maxRows={6} placeholder="src/**/*.ts" spellcheck="false" disabled={busy} />
        </Field>
        <Field label={$t('Ignore')} for="schedule-exclude" optionalLabel={$t('optional')}>
          <Textarea id="schedule-exclude" bind:value={draft.exclude} minRows={1} maxRows={4} placeholder="src/generated/**" spellcheck="false" disabled={busy} />
        </Field>
        <Field label={$t('Wait until files are quiet for')} for="schedule-debounce" description={$t('2 to 3600 seconds. Changes during the wait start one run together.')}>
          <div class="every">
            <Input id="schedule-debounce" inputmode="numeric" value={draft.debounce} disabled={busy} oninput={(event) => (draft.debounce = event.currentTarget.value)} />
            <span class="unit">{$t('seconds')}</span>
          </div>
        </Field>
      {/if}
      {#each eventNotes as line (line)}
        <p class="note">{line}</p>
      {/each}
    {/if}
    {#if mode === 'schedule'}
      <Field label={$t('If PiUI was closed or paused at that time')}>
        <Segmented
          label={$t('If PiUI was closed or paused at that time')}
          bind:value={missed}
          options={[
            { value: 'skip', label: $t('Skip it') },
            { value: 'coalesce', label: $t('Run once when PiUI opens') },
          ]}
        />
      </Field>
    {/if}
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
    {#if inputsLoading}
      <p class="note"><Spinner size={12} /> {$t('Loading pipeline inputs…')}</p>
    {:else if inputs.length}
      <fieldset class="inputs">
        <legend>{$t('Inputs for every run')}</legend>
        <InputFields {inputs} bind:form errors={inputErrors} idPrefix="schedule-input" disabled={busy} />
      </fieldset>
    {/if}
    <p class="note">{$t('Automations run only while PiUI is open or in the tray; they do not wake the computer. Each run uses your harness subscriptions like a manual run.')}</p>
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
    align-items: center;
    gap: var(--piui-space-2);
  }
  .unit {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .days,
  .outcomes {
    display: grid;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .days legend,
  .outcomes legend {
    margin-bottom: 6px;
    padding: 0;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-medium);
  }
  .outcomes__line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-4);
  }
  .days__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-3);
  }
  .days__toggles,
  .days__presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .day,
  .preset {
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font: inherit;
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .day {
    min-width: 44px;
  }
  .preset {
    border-color: var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: transparent;
  }
  .day:hover:not(:disabled),
  .preset:hover:not(:disabled) {
    color: var(--piui-text);
  }
  .day[aria-pressed='true'] {
    border-color: var(--piui-accent);
    background: var(--piui-accent-soft);
    color: var(--piui-text);
  }
  .preset[aria-pressed='true'] {
    border-color: var(--piui-border);
    background: var(--piui-surface-2);
    color: var(--piui-text);
  }
  .day:focus-visible,
  .preset:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .day:disabled,
  .preset:disabled {
    cursor: default;
    opacity: 0.6;
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
  .inputs {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
  }
  .inputs legend {
    padding: 0 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .note--warn {
    color: var(--piui-warning-text);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
