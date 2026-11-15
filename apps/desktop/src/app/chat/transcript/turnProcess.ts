import type { Language } from '../../../features/locale/language';
import type { TimelineTurnProcess } from '../../../features/sessions/timelineView';
import { activitySummary } from './toolKinds';

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
