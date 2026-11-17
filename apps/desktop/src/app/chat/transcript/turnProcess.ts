import type { Language } from '../../../features/locale/language';
import type { TimelineActivityGroup, TimelineTurnProcess } from '../../../features/sessions/timelineView';
import { activityDiffTotals, activityLive, activitySummary } from './toolKinds';

type Translate = (value: string, parameters?: readonly unknown[]) => string;

/** Whole seconds the turn took, when both instants are known and the end is later. */
export function turnSeconds(item: Pick<TimelineTurnProcess, 'startedAt' | 'endedAt'>): number | undefined {
  if (item.startedAt === undefined || item.endedAt === undefined) return undefined;
  const seconds = Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000);
  return Number.isFinite(seconds) && seconds >= 1 ? seconds : undefined;
}

function workedFor(seconds: number, translate: Translate): string {
  if (seconds >= 3600) return translate('Worked for {0}h {1}m', [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60)]);
  if (seconds >= 60) return translate('Worked for {0}m {1}s', [Math.floor(seconds / 60), seconds % 60]);
  return translate('Worked for {0}s', [seconds]);
}

/** The control's line: how long the turn took, then what it did. Without a duration, only what it did. */
export function turnProcessLabel(item: TimelineTurnProcess, language: Language, translate: Translate): string {
  const summary = activitySummary(item.blocks, language);
  const seconds = turnSeconds(item);
  if (seconds === undefined) return summary;
  return `${workedFor(seconds, translate)} · ${summary.charAt(0).toLocaleLowerCase(language) + summary.slice(1)}`;
}

/** What the process is doing now, while the turn is still at work: the running call, else the reasoning. */
export function processLive(item: TimelineTurnProcess, language: Language): { label: string; detail?: string } | undefined {
  if (item.live !== true) return undefined;
  const last = item.parts[item.parts.length - 1];
  return last?.type === 'activity-group' ? activityLive(last.blocks, language) : { label: activityLive([], language).label };
}

// A streamed token replaces only the live group; every earlier group keeps its object, so its diff is parsed once.
const groupDiffs = new WeakMap<TimelineActivityGroup, { added: number; removed: number } | undefined>();

/** Lines added and removed by the edits of the whole process, when there are any. */
export function processDiffTotals(item: TimelineTurnProcess): { added: number; removed: number } | undefined {
  let added = 0;
  let removed = 0;
  for (const part of item.parts) {
    if (part.type !== 'activity-group') continue;
    if (!groupDiffs.has(part)) groupDiffs.set(part, activityDiffTotals(part.blocks));
    const totals = groupDiffs.get(part);
    if (totals === undefined) continue;
    added += totals.added;
    removed += totals.removed;
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}
