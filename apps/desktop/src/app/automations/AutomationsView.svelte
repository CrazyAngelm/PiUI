<script lang="ts">
  import AlarmClock from '@lucide/svelte/icons/alarm-clock';
  import Plus from '@lucide/svelte/icons/plus';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import { onMount, untrack } from 'svelte';
  import { language, t } from '../../features/locale/language';
  import type { OrchestrationClient, ScheduleSnapshot } from '../../host-api/orchestrationClient';
  import { Badge, Button, Dialog, EmptyState, IconButton, Skeleton, Switch } from '../../lib/ui';
  import { AutomationsStore } from './automationsStore.svelte';
  import { cadenceText, OUTCOME, triggerTimeZone } from './cadence';
  import ScheduleDialog from './ScheduleDialog.svelte';

  interface Props {
    workspaceId: string;
    safeMode: boolean;
    client: OrchestrationClient;
    onOpenRun: (runId: string) => void;
    onEditPipelines: () => void;
  }
  let { workspaceId, safeMode, client, onOpenRun, onEditPipelines }: Props = $props();
  // The parent keys this view per project, so the store binds its first props.
  const automations = untrack(() => new AutomationsStore(workspaceId, safeMode, client));

  let editing = $state<ScheduleSnapshot | undefined>();
  let dialogOpen = $state(false);
  let removing = $state<ScheduleSnapshot | undefined>();

  onMount(() => automations.start());

  const locale = $derived($language === 'ru' ? 'ru-RU' : 'en-US');
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function when(iso: string | null | undefined, schedule: ScheduleSnapshot): string {
    if (!iso) return '';
    const timeZone = triggerTimeZone(schedule.value.trigger, localZone);
    return new Date(iso).toLocaleString(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function cadence(schedule: ScheduleSnapshot): string {
    return cadenceText(schedule.value.trigger, $t, locale, (id) => automations.pipelineName(id));
  }

  /** What an enabled event rule is waiting for; timed rules show their next time. */
  function waiting(schedule: ScheduleSnapshot): string {
    const trigger = schedule.value.trigger;
    if (trigger.type !== 'event') return '';
    if (trigger.event.kind === 'files-changed') return $t('Watching project files');
    return $t('Waiting for {0} to finish', [automations.pipelineName(trigger.event.launchCommandId) || $t('Missing pipeline')]);
  }

  function edit(schedule: ScheduleSnapshot | undefined): void {
    editing = schedule;
    dialogOpen = true;
  }
</script>

<section class="automations" aria-labelledby="automations-title">
  <header class="head">
    <div>
      <h2 id="automations-title">{$t('Automations')}</h2>
      <p>{$t('Start saved pipelines on a schedule or after an event. They run while PiUI is open or in the tray.')}</p>
    </div>
    <div class="head__actions">
      <IconButton label={$t('Refresh')} onclick={() => void automations.refresh()} disabled={automations.loading}><RefreshCw /></IconButton>
      {#if !automations.paused}
        <Button variant="ghost" onclick={() => void automations.setPaused(true)} disabled={safeMode || automations.busy !== ''}>
          {#snippet leading()}<Pause />{/snippet}
          {$t('Pause all')}
        </Button>
      {/if}
      <Button variant="primary" onclick={() => edit(undefined)} disabled={safeMode}>
        {#snippet leading()}<Plus />{/snippet}
        {$t('New automation')}
      </Button>
    </div>
  </header>

  {#if automations.paused}
    <div class="paused" role="status">
      <span>{$t('All automations are paused. Nothing starts until you resume them.')}</span>
      <Button size="sm" onclick={() => void automations.setPaused(false)} disabled={safeMode || automations.busy !== ''}>
        {#snippet leading()}<Play />{/snippet}
        {$t('Resume automations')}
      </Button>
    </div>
  {/if}

  {#if automations.error}<p class="error" role="alert">{$t(automations.error)}</p>{/if}
  {#if automations.actionError}<p class="error" role="alert">{$t(automations.actionError)}</p>{/if}

  {#if automations.loading && automations.schedules.length === 0}
    <div class="loading"><Skeleton lines={4} /></div>
  {:else if automations.schedules.length === 0}
    <EmptyState icon={AlarmClock} title={$t('No automations yet')} description={automations.launchCommands.length ? $t('Run a pipeline every morning, when another pipeline finishes or when project files change.') : $t('Save a pipeline first, then schedule it here.')}>
      {#snippet actions()}
        {#if automations.launchCommands.length}
          <Button variant="primary" onclick={() => edit(undefined)} disabled={safeMode}>{$t('New automation')}</Button>
        {:else}
          <Button onclick={onEditPipelines}>{$t('Open editor')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="list">
      {#each automations.schedules as schedule (schedule.value.id)}
        {@const last = schedule.lastOccurrence}
        {@const outcome = last ? OUTCOME[last.outcome] : undefined}
        <li class="card" class:card--off={!schedule.enabled}>
          <div class="card__main">
            <div class="card__title">
              <strong>{schedule.value.name}</strong>
              <Badge tone={schedule.enabled ? 'success' : 'neutral'}>{schedule.enabled ? $t('On') : $t('Off')}</Badge>
            </div>
            <p class="muted">
              {automations.pipelineName(schedule.value.launchCommandId) || $t('Missing pipeline')} · {cadence(schedule)}
            </p>
            <div class="meta">
              {#if schedule.enabled && schedule.value.trigger.type === 'event'}
                <span>{waiting(schedule)}</span>
              {:else if schedule.enabled && schedule.nextDueAt}
                <span>{$t('Next')}: <b>{when(schedule.nextDueAt, schedule)}</b></span>
              {:else if !schedule.enabled}
                <span>{schedule.value.trigger.type === 'event' ? $t('Turn it on to react to events.') : $t('Turn it on to schedule the next run.')}</span>
              {/if}
              {#if last && outcome}
                <span>
                  {$t('Last')}: {when(last.nominalAt, schedule)} ·
                  <Badge tone={outcome.tone}>{$t(outcome.label)}</Badge>
                  {#if last.runId}
                    <button type="button" class="link" onclick={() => last.runId && onOpenRun(last.runId)}>{$t('Open run')}</button>
                  {/if}
                </span>
              {/if}
            </div>
          </div>
          <div class="card__actions">
            <Switch
              label={schedule.enabled ? $t('Turn off {0}', [schedule.value.name]) : $t('Turn on {0}', [schedule.value.name])}
              hideLabel
              checked={schedule.enabled}
              disabled={safeMode || automations.busy !== ''}
              onCheckedChange={(checked) => void automations.setEnabled(schedule, checked)}
            />
            <IconButton size="sm" label={$t('Edit {0}', [schedule.value.name])} disabled={safeMode} onclick={() => edit(schedule)}><Pencil /></IconButton>
            <IconButton size="sm" label={$t('Delete {0}', [schedule.value.name])} disabled={safeMode} onclick={() => (removing = schedule)}><Trash2 /></IconButton>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<ScheduleDialog
  bind:open={dialogOpen}
  schedule={editing}
  launchCommands={automations.launchCommands}
  busy={automations.busy.startsWith('save') || automations.busy.startsWith('enable')}
  error={automations.actionError}
  loadInputs={(id) => automations.pipelineInputs(id)}
  onSave={(value, enable) => automations.save(value, enable)}
/>

<Dialog open={removing !== undefined} title={$t('Delete this automation?')} description={$t('Past runs stay in Runs. The pipeline itself is not changed.')} size="sm" onOpenChange={(open) => { if (!open) removing = undefined; }}>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removing = undefined)}>{$t('Keep it')}</Button>
    <Button
      variant="danger"
      loading={automations.busy.startsWith('delete')}
      onclick={async () => {
        if (removing && (await automations.remove(removing))) removing = undefined;
      }}>{$t('Delete')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .automations {
    display: grid;
    align-content: start;
    gap: var(--piui-space-4);
    width: min(860px, calc(100% - 48px));
    margin: 0 auto;
    padding: var(--piui-space-8) 0;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--piui-space-4);
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-2xl);
    font-weight: var(--piui-weight-semibold);
  }
  .head p {
    margin: 4px 0 0;
    color: var(--piui-text-muted);
  }
  .head__actions {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .list {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    align-items: center;
    gap: var(--piui-space-4);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .card--off {
    background: transparent;
  }
  .card__main {
    display: grid;
    flex: 1;
    gap: 4px;
    min-width: 0;
  }
  .card__title {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .card__title strong {
    overflow: hidden;
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-4);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .meta span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .meta b {
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .card__actions {
    display: flex;
    align-items: center;
    gap: var(--piui-space-1);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
  }
  .paused {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .loading {
    padding: var(--piui-space-4) 0;
  }
</style>
