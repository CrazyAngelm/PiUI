/**
 * The reasoning control without its markup: the radios in display order, how
 * far each bar rises, how each one is drawn, and where a key moves the choice.
 */

/** Levels that switch reasoning off: a flat dash that a higher choice never lights. */
const ZERO_LEVELS: ReadonlySet<string> = new Set(['off', 'none']);

/** A long sweep staggers at most this many bars, so it ends within `--piui-duration`. */
const SWEEP_SLOTS = 3;

export type ReasoningStepKind = 'auto' | 'zero' | 'level';

export interface ReasoningStep {
  /** The level as the harness names it; '' is the native default ("Auto"). */
  value: string;
  kind: ReasoningStepKind;
  /** Position among the rising levels, lowest first; -1 for Auto and zero levels. */
  rank: number;
  /** How far the bar rises: 0 for the lowest level, 1 for the highest; 0 for Auto and zero levels. */
  rise: number;
}

/** How a step is drawn. Picking the previewed step would turn a `ghost` on and a `fade` off. */
export type StepTone = 'off' | 'ghost' | 'fade' | 'lit';

function isZeroLevel(level: string): boolean {
  return ZERO_LEVELS.has(level.toLowerCase());
}

/**
 * Radios in display order: Auto first when the native default can be picked,
 * then the model's levels as the catalog lists them. A model without levels has
 * no steps, so Auto never stands alone.
 */
export function reasoningSteps(levels: readonly string[], levelDefault: boolean): ReasoningStep[] {
  const values = [...new Set(levels)].filter((level) => level !== '');
  if (values.length === 0) return [];
  const top = values.filter((level) => !isZeroLevel(level)).length - 1;
  const steps: ReasoningStep[] = levelDefault ? [{ value: '', kind: 'auto', rank: -1, rise: 0 }] : [];
  let rank = 0;
  for (const value of values) {
    if (isZeroLevel(value)) {
      steps.push({ value, kind: 'zero', rank: -1, rise: 0 });
    } else {
      steps.push({ value, kind: 'level', rank, rise: top > 0 ? rank / top : 1 });
      rank += 1;
    }
  }
  return steps;
}

/** Rank of the highest lit bar; -1 when the selection lights none (Auto, a zero level, nothing). */
export function litFrontier(steps: readonly ReasoningStep[], active: number): number {
  const chosen: ReasoningStep | undefined = steps[active];
  return chosen?.kind === 'level' ? chosen.rank : -1;
}

/**
 * How the step at `index` is drawn while `active` is selected and `peek` is
 * hovered or focused (-1 for none). Every bar up to the selection is lit; the
 * selected Auto or zero step lights only itself.
 */
export function stepTone(steps: readonly ReasoningStep[], index: number, active: number, peek: number): StepTone {
  const step: ReasoningStep | undefined = steps[index];
  if (step === undefined) return 'off';
  const target: ReasoningStep | undefined = peek === active ? undefined : steps[peek];
  if (step.kind !== 'level') {
    if (index === active) return 'lit';
    return target === step ? 'ghost' : 'off';
  }
  const lit = step.rank <= litFrontier(steps, active);
  if (target === undefined) return lit ? 'lit' : 'off';
  const wanted = target.kind === 'level' && step.rank <= target.rank;
  if (lit) return wanted ? 'lit' : 'fade';
  return wanted ? 'ghost' : 'off';
}

/**
 * Stagger slot of a bar that lights up after the frontier moved up from `from`:
 * 0 for the first new bar, so a single step never waits.
 */
export function sweepSlot(rank: number, from: number): number {
  return Math.min(SWEEP_SLOTS, Math.max(0, rank - from - 1));
}

/** The step a key moves to from `index`, or -1 for any other key. The ramp does not wrap. */
export function stepForKey(key: string, index: number, count: number): number {
  if (count <= 0) return -1;
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(last, index + 1);
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return -1;
  }
}
