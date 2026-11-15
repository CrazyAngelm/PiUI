import { describe, expect, it } from 'vitest';
import { nearestStop, railPosition, railStops, RailGesture, reasoningSteps, stepForKey } from './reasoningSteps';

const CODEX = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

describe('reasoningSteps', () => {
  it('lists Auto first, then the levels in the given order', () => {
    const steps = reasoningSteps(CODEX, true);
    expect(steps.map((step) => step.value)).toEqual(['', ...CODEX]);
    expect(steps.map((step) => step.kind)).toEqual(['auto', 'zero', 'level', 'level', 'level', 'level', 'level']);
    expect(reasoningSteps(CODEX, false).map((step) => step.value)).toEqual(CODEX);
  });

  it('gives every level a slot on the rail and keeps Auto beside it', () => {
    expect(reasoningSteps(CODEX, true).map((step) => step.slot)).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(reasoningSteps(CODEX, false).map((step) => step.slot)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('treats off and none as zero levels wherever the catalog lists them', () => {
    expect(reasoningSteps(['off', 'low', 'high'], false).map((step) => step.kind)).toEqual(['zero', 'level', 'level']);
    expect(reasoningSteps(['low', 'None', 'high'], false).map((step) => [step.kind, step.slot])).toEqual([
      ['level', 0],
      ['zero', 1],
      ['level', 2],
    ]);
  });

  it('puts a single level on the first slot', () => {
    expect(reasoningSteps(['high'], false)).toEqual([{ value: 'high', kind: 'level', slot: 0 }]);
  });

  it('offers no steps without levels, so Auto never stands alone', () => {
    expect(reasoningSteps([], true)).toEqual([]);
    expect(reasoningSteps([], false)).toEqual([]);
    expect(reasoningSteps([''], true)).toEqual([]);
  });

  it('drops an empty or repeated level instead of repeating a radio', () => {
    expect(reasoningSteps(['low', '', 'low', 'high'], true).map((step) => step.value)).toEqual(['', 'low', 'high']);
  });
});

describe('the rail', () => {
  it('counts every step except Auto as a stop', () => {
    expect(railStops(reasoningSteps(CODEX, true))).toBe(6);
    expect(railStops(reasoningSteps(CODEX, false))).toBe(6);
    expect(railStops(reasoningSteps([], true))).toBe(0);
  });

  it('spreads the slots from 0 at the first stop to 1 at the last', () => {
    expect([0, 1, 2, 3, 4, 5].map((slot) => railPosition(slot, 6))).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(railPosition(2, 3)).toBe(1);
  });

  it('fills nothing for Auto, for the first stop and for a rail of one stop', () => {
    expect(railPosition(-1, 6)).toBe(0);
    expect(railPosition(0, 6)).toBe(0);
    expect(railPosition(0, 1)).toBe(0);
    expect(railPosition(3, 0)).toBe(0);
  });

  it('never runs past the last stop', () => {
    expect(railPosition(9, 6)).toBe(1);
  });
});

describe('nearestStop', () => {
  const centers = [10, 50, 90];

  it('finds the centre closest to the pointer', () => {
    expect(nearestStop(0, centers)).toBe(0);
    expect(nearestStop(29, centers)).toBe(0);
    expect(nearestStop(31, centers)).toBe(1);
    expect(nearestStop(500, centers)).toBe(2);
  });

  it('keeps the earlier stop on a tie', () => {
    expect(nearestStop(30, centers)).toBe(0);
  });

  it('finds nothing without stops', () => {
    expect(nearestStop(30, [])).toBe(-1);
  });
});

describe('stepForKey', () => {
  it('moves one step with the arrows and stops at the ends', () => {
    expect(stepForKey('ArrowRight', 2, 7)).toBe(3);
    expect(stepForKey('ArrowUp', 2, 7)).toBe(3);
    expect(stepForKey('ArrowLeft', 2, 7)).toBe(1);
    expect(stepForKey('ArrowDown', 2, 7)).toBe(1);
    expect(stepForKey('ArrowRight', 6, 7)).toBe(6);
    expect(stepForKey('ArrowLeft', 0, 7)).toBe(0);
  });

  it('jumps to the ends with Home and End', () => {
    expect(stepForKey('Home', 4, 7)).toBe(0);
    expect(stepForKey('End', 4, 7)).toBe(6);
    expect(stepForKey('End', 0, 1)).toBe(0);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageDown']) expect(stepForKey(key, 2, 7)).toBe(-1);
    expect(stepForKey('End', 0, 0)).toBe(-1);
  });
});

describe('RailGesture', () => {
  it('belongs to the pointer that pressed, so a second finger neither steers nor ends it', () => {
    const gesture = new RailGesture();
    expect(gesture.active).toBe(false);
    expect(gesture.owns(7)).toBe(false);
    gesture.begin(7, 2);
    expect(gesture.active).toBe(true);
    expect([gesture.owns(7), gesture.owns(8)]).toEqual([true, false]);
    // The other pointer's release picks nothing and leaves the press running.
    expect(gesture.release(8, 5)).toBe(-1);
    expect(gesture.active).toBe(true);
    expect(gesture.owns(7)).toBe(true);
    expect(gesture.release(7, 5)).toBe(5);
    expect(gesture.active).toBe(false);
    expect(gesture.owns(7)).toBe(false);
  });

  it('picks nothing for a release on the stop the press began on, or over no stop', () => {
    const gesture = new RailGesture();
    gesture.begin(1, 3);
    expect(gesture.release(1, 3)).toBe(-1);
    expect(gesture.active).toBe(false);
    gesture.begin(1, 3);
    expect(gesture.release(1, -1)).toBe(-1);
    // Neither was a slide, so the plain click that follows is not swallowed.
    expect(gesture.swallowsClick(1)).toBe(false);
  });

  it('swallows the pointer click that trails a handled slide, once', () => {
    const gesture = new RailGesture();
    gesture.begin(1, 1);
    expect(gesture.release(1, 4)).toBe(4);
    expect(gesture.swallowsClick(1)).toBe(true);
    expect(gesture.swallowsClick(1)).toBe(false);
  });

  it('never swallows a keyboard click, and a stale slide does not outlive it', () => {
    const gesture = new RailGesture();
    gesture.begin(1, 1);
    expect(gesture.release(1, 4)).toBe(4);
    // Enter and Space click with detail 0.
    expect(gesture.swallowsClick(0)).toBe(false);
    expect(gesture.swallowsClick(1)).toBe(false);
  });

  it('forgets a slide when the next press begins', () => {
    const gesture = new RailGesture();
    gesture.begin(1, 1);
    gesture.release(1, 4);
    gesture.begin(1, 2);
    expect(gesture.swallowsClick(1)).toBe(false);
  });

  it('ends a press without picking and lets a later pointer press', () => {
    const gesture = new RailGesture();
    gesture.begin(5, 0);
    gesture.end();
    expect(gesture.active).toBe(false);
    expect(gesture.owns(5)).toBe(false);
    expect(gesture.release(5, 2)).toBe(-1);
    gesture.begin(6, 1);
    expect([gesture.owns(5), gesture.owns(6)]).toEqual([false, true]);
  });
});
