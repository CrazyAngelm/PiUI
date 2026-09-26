import type {
  EventTrigger,
  FinishedOutcome,
  ScheduleOccurrenceOutcome,
  ScheduleTrigger,
} from '../../host-api/orchestrationClient';
import { EVENT_COOLDOWN_SECONDS } from '../../../../../contracts/orchestration-host-v7';
import { MAX_TRIGGER_CHAIN_DEPTH } from '../../../../../contracts/orchestration-v6';
import { daySet, sortDays, weekdayNames } from '../../host-api/scheduleCalendar';

/** `$t` from the locale catalog: English source text plus `{0}` parameters. */
export type Translate = (value: string, parameters?: readonly unknown[]) => string;

export const FINISHED_OUTCOMES: readonly FinishedOutcome[] = ['succeeded', 'failed', 'cancelled'];

/** The zone a timed rule shows its times in; event rules use the viewer's. */
export function triggerTimeZone(trigger: ScheduleTrigger, fallback: string): string {
  return trigger.type === 'event' ? fallback : trigger.timeZone;
}

/** Canonical order, without repeats. */
export function sortedOutcomes(outcomes: readonly FinishedOutcome[]): FinishedOutcome[] {
  return FINISHED_OUTCOMES.filter((outcome) => outcomes.includes(outcome));
}

/** "When Build succeeds or fails" as one translatable sentence per combination. */
function finishedText(source: string, outcomes: readonly FinishedOutcome[], t: Translate): string {
  const key = sortedOutcomes(outcomes).join('+');
  switch (key) {
    case 'succeeded':
      return t('When {0} succeeds', [source]);
    case 'failed':
      return t('When {0} fails', [source]);
    case 'cancelled':
      return t('When {0} is stopped', [source]);
    case 'succeeded+failed':
      return t('When {0} succeeds or fails', [source]);
    case 'succeeded+cancelled':
      return t('When {0} succeeds or is stopped', [source]);
    case 'failed+cancelled':
      return t('When {0} fails or is stopped', [source]);
    default:
      return t('When {0} finishes', [source]);
  }
}

function filesText(event: Extract<EventTrigger, { kind: 'files-changed' }>, t: Translate): string {
  const [first] = event.include;
  const more = event.include.length - 1;
  if (first === undefined) return t('When files change');
  return more > 0 ? t('When {0} and {1} more change', [first, more]) : t('When {0} changes', [first]);
}

/** Readable cadence for the automation list. */
export function cadenceText(
  trigger: ScheduleTrigger,
  t: Translate,
  locale: string,
  pipelineName: (launchCommandId: string) => string,
): string {
  switch (trigger.type) {
    case 'once':
      return t('Once');
    case 'interval':
      return trigger.unit === 'hours' ? t('Every {0} h', [trigger.every]) : t('Every {0} min', [trigger.every]);
    case 'calendar': {
      const preset = daySet(trigger.days);
      if (preset === 'every') return t('Every day at {0}', [trigger.time]);
      if (preset === 'workdays') return t('Weekdays at {0}', [trigger.time]);
      const names = weekdayNames(locale);
      return t('{0} at {1}', [sortDays(trigger.days).map((day) => names[day - 1]).join(', '), trigger.time]);
    }
    case 'event':
      return trigger.event.kind === 'run-finished'
        ? finishedText(pipelineName(trigger.event.launchCommandId) || t('Missing pipeline'), trigger.event.outcomes, t)
        : filesText(trigger.event, t);
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
}

/** What the dialog promises for an event rule, shown before saving. */
export function eventPreview(event: EventTrigger, target: string, t: Translate, pipelineName: (id: string) => string): string[] {
  const lines: string[] = [];
  if (event.kind === 'run-finished') {
    const source = pipelineName(event.launchCommandId) || t('Missing pipeline');
    lines.push(t('{0}, PiUI starts {1}.', [finishedText(source, event.outcomes, t), target]));
  } else {
    lines.push(t('PiUI starts {0} {1} s after matching files stop changing.', [target, event.debounceSeconds]));
    if (event.exclude?.length) lines.push(t('Ignored: {0}', [event.exclude.join(', ')]));
    lines.push(t('Changes made while its own run works are ignored. .git, node_modules, target and dist are never watched.'));
  }
  lines.push(t('At most one run every {0} s. A chain of automations stops after {1} automatic runs.', [EVENT_COOLDOWN_SECONDS, MAX_TRIGGER_CHAIN_DEPTH]));
  return lines;
}

export type OutcomeTone = 'success' | 'neutral' | 'warning' | 'danger';

/** Last-occurrence badges; every skip names its reason. */
export const OUTCOME: Readonly<Record<ScheduleOccurrenceOutcome, { readonly label: string; readonly tone: OutcomeTone }>> = {
  started: { label: 'Started', tone: 'success' },
  skippedMissed: { label: 'Skipped: PiUI was closed or paused', tone: 'neutral' },
  skippedOverlap: { label: 'Skipped: previous run still working', tone: 'neutral' },
  skippedChainLimit: { label: 'Skipped: too many chained automations', tone: 'warning' },
  skippedCooldown: { label: 'Skipped: ran moments ago', tone: 'neutral' },
  skippedPaused: { label: 'Skipped: automations paused', tone: 'neutral' },
  failed: { label: 'Could not start', tone: 'danger' },
};
