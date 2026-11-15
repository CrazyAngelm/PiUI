/**
 * The reasoning control without its markup: the radios in display order, where
 * each one sits on the rail, and where a key or the pointer moves the choice.
 */

/** Levels that switch reasoning off: a hollow stop instead of a tick. */
const ZERO_LEVELS: ReadonlySet<string> = new Set(['off', 'none']);

export type ReasoningStepKind = 'auto' | 'zero' | 'level';

export interface ReasoningStep {
  /** The level as the harness names it; '' is the native default ("Auto"). */
  value: string;
  kind: ReasoningStepKind;
  /** Stop on the rail, the first one 0; -1 for Auto, which sits beside the rail. */
  slot: number;
}

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
  const steps: ReasoningStep[] = levelDefault ? [{ value: '', kind: 'auto', slot: -1 }] : [];
  values.forEach((value, slot) => {
    steps.push({ value, kind: isZeroLevel(value) ? 'zero' : 'level', slot });
  });
  return steps;
}

/** Number of stops on the rail: every step except Auto. */
export function railStops(steps: readonly ReasoningStep[]): number {
  return steps.filter((step) => step.slot >= 0).length;
}

/**
 * How far along the rail a slot sits: 0 at the first stop, 1 at the last.
 * Auto (-1) and a rail of one stop are 0, so nothing is filled.
 */
export function railPosition(slot: number, stops: number): number {
  if (slot <= 0 || stops <= 1) return 0;
  return Math.min(1, slot / (stops - 1));
}

/** Index of the centre closest to `x`, the earlier one on a tie; -1 without centres. */
export function nearestStop(x: number, centers: readonly number[]): number {
  let nearest = -1;
  let gap = Number.POSITIVE_INFINITY;
  centers.forEach((center, index) => {
    const distance = Math.abs(center - x);
    if (distance < gap) {
      gap = distance;
      nearest = index;
    }
  });
  return nearest;
}

/**
 * One pointer gesture on the rail: a press that may slide, ending in a pick.
 * It belongs to the pointer that pressed, so a second finger can neither steer
 * nor end it, and it remembers a handled slide so the click the browser sends
 * after it (a touch pointer is captured by the stop it landed on) can be ignored.
 */
export class RailGesture {
  private pointer = -1;
  private origin = -1;
  private slid = false;

  /** A press is in progress. */
  get active(): boolean {
    return this.origin >= 0;
  }

  /** Whether `pointerId` is the pointer that pressed. */
  owns(pointerId: number): boolean {
    return this.origin >= 0 && this.pointer === pointerId;
  }

  /** A pointer pressed the step at `index`. A new press forgets the slide before it. */
  begin(pointerId: number, index: number): void {
    this.pointer = pointerId;
    this.origin = index;
    this.slid = false;
  }

  /** The press is over without a pick (cancelled, or the control went away). */
  end(): void {
    this.pointer = -1;
    this.origin = -1;
  }

  /**
   * The owning pointer was released over step `next`. Returns the step to pick,
   * or -1 for a release on the step the press began on (a plain click) and for
   * any other pointer, which leaves the press as it was.
   */
  release(pointerId: number, next: number): number {
    if (!this.owns(pointerId)) return -1;
    const from = this.origin;
    this.end();
    if (next < 0 || next === from) return -1;
    this.slid = true;
    return next;
  }

  /**
   * Whether a click must be ignored: a pointer click (detail above 0) that
   * trails a handled slide. It is spent either way, so Enter and Space, which
   * click with detail 0, are never swallowed.
   */
  swallowsClick(detail: number): boolean {
    const swallow = this.slid && detail > 0;
    this.slid = false;
    return swallow;
  }
}

/** The step a key moves to from `index`, or -1 for any other key. The rail does not wrap. */
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
