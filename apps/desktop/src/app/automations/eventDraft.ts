import type { EventTrigger, FinishedOutcome, ScheduleTrigger } from '../../host-api/orchestrationClient';
import {
  MAX_DEBOUNCE_SECONDS,
  MAX_TRIGGER_PATTERNS,
  MIN_DEBOUNCE_SECONDS,
} from '../../../../../contracts/orchestration-host-v7';
import { PATTERN_ISSUE_COPY, patternLines, patternListIssue, type PatternListIssue } from '../../host-api/triggerPatterns';
import { sortedOutcomes, type Translate } from './cadence';

/** The editable form of an event rule (v7.2); text fields hold what the person typed. */
export interface EventDraft {
  kind: EventTrigger['kind'];
  /** The launch command a "pipeline finished" rule watches. */
  sourceId: string;
  outcomes: FinishedOutcome[];
  /** One pattern per line. */
  include: string;
  exclude: string;
  /** Quiet period in seconds, as typed. */
  debounce: string;
}

export const DEFAULT_DEBOUNCE_SECONDS = 10;

/** A saved event rule as a draft, or a new draft watching `fallbackSource`. */
export function eventDraftFrom(trigger: ScheduleTrigger | undefined, fallbackSource: string): EventDraft {
  const event = trigger?.type === 'event' ? trigger.event : undefined;
  return {
    kind: event?.kind ?? 'run-finished',
    sourceId: event?.kind === 'run-finished' ? event.launchCommandId : fallbackSource,
    outcomes: event?.kind === 'run-finished' ? sortedOutcomes(event.outcomes) : ['succeeded'],
    include: event?.kind === 'files-changed' ? event.include.join('\n') : '',
    exclude: event?.kind === 'files-changed' ? (event.exclude ?? []).join('\n') : '',
    debounce: String(event?.kind === 'files-changed' ? event.debounceSeconds : DEFAULT_DEBOUNCE_SECONDS),
  };
}

function debounceSeconds(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return seconds >= MIN_DEBOUNCE_SECONDS && seconds <= MAX_DEBOUNCE_SECONDS ? seconds : undefined;
}

function listProblem(issue: PatternListIssue, t: Translate): string {
  switch (issue.kind) {
    case 'none-included':
      return t('Add at least one file pattern.');
    case 'too-many':
      return t('Use at most {0} patterns in each list.', [MAX_TRIGGER_PATTERNS]);
    case 'pattern':
      return t('Pattern “{0}”: {1}', [issue.pattern, t(PATTERN_ISSUE_COPY[issue.issue])]);
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

/** Why the draft cannot be saved (translated), or '' when it can. */
export function eventDraftProblem(draft: EventDraft, pipelineIds: readonly string[], t: Translate): string {
  if (draft.kind === 'run-finished') {
    if (!pipelineIds.includes(draft.sourceId)) return t('Choose the pipeline to wait for.');
    return draft.outcomes.length === 0 ? t('Choose at least one result.') : '';
  }
  const issue = patternListIssue(patternLines(draft.include), true) ?? patternListIssue(patternLines(draft.exclude), false);
  if (issue !== undefined) return listProblem(issue, t);
  return debounceSeconds(draft.debounce) === undefined
    ? t('Wait between {0} and {1} seconds.', [MIN_DEBOUNCE_SECONDS, MAX_DEBOUNCE_SECONDS])
    : '';
}

/** The trigger the host stores, or `undefined` while the draft has a problem. */
export function eventTriggerOf(draft: EventDraft, pipelineIds: readonly string[]): (ScheduleTrigger & { type: 'event' }) | undefined {
  if (eventDraftProblem(draft, pipelineIds, (value) => value) !== '') return undefined;
  if (draft.kind === 'run-finished') {
    return { type: 'event', event: { kind: 'run-finished', launchCommandId: draft.sourceId, outcomes: sortedOutcomes(draft.outcomes) } };
  }
  const exclude = patternLines(draft.exclude);
  return {
    type: 'event',
    event: {
      kind: 'files-changed',
      include: patternLines(draft.include),
      ...(exclude.length ? { exclude } : {}),
      debounceSeconds: debounceSeconds(draft.debounce) ?? DEFAULT_DEBOUNCE_SECONDS,
    },
  };
}

/** The rule starts the very pipeline it waits for. */
export function startsItself(draft: EventDraft, targetId: string): boolean {
  return draft.kind === 'run-finished' && draft.sourceId !== '' && draft.sourceId === targetId;
}
