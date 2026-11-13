import { describe, expect, it } from 'vitest';
import { litFrontier, reasoningSteps, stepForKey, stepTone, sweepSlot, type StepTone } from './reasoningSteps';

const CODEX = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

describe('reasoningSteps', () => {
  it('lists Auto first, then the levels in the given order', () => {
    const steps = reasoningSteps(CODEX, true);
    expect(steps.map((step) => step.value)).toEqual(['', ...CODEX]);
    expect(steps.map((step) => step.kind)).toEqual(['auto', 'zero', 'level', 'level', 'level', 'level', 'level']);
    expect(reasoningSteps(CODEX, false).map((step) => step.value)).toEqual(CODEX);
  });

  it('ranks only the rising levels and spreads their rise from 0 to 1', () => {
    const steps = reasoningSteps(CODEX, true);
    expect(steps.map((step) => step.rank)).toEqual([-1, -1, 0, 1, 2, 3, 4]);
    expect(steps.map((step) => step.rise)).toEqual([0, 0, 0, 0.25, 0.5, 0.75, 1]);
  });

  it('treats off and none as zero levels wherever the catalog lists them', () => {
    expect(reasoningSteps(['off', 'low', 'high'], false).map((step) => step.kind)).toEqual(['zero', 'level', 'level']);
    expect(reasoningSteps(['low', 'None', 'high'], false).map((step) => [step.kind, step.rank])).toEqual([
      ['level', 0],
      ['zero', -1],
      ['level', 1],
    ]);
  });

  it('gives a single level the full rise', () => {
    expect(reasoningSteps(['high'], false)).toEqual([{ value: 'high', kind: 'level', rank: 0, rise: 1 }]);
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

describe('stepTone', () => {
  // 0 Auto, 1 none, 2 minimal, 3 low, 4 medium, 5 high, 6 xhigh
  const steps = reasoningSteps(CODEX, true);
  const tones = (active: number, peek = -1): StepTone[] => steps.map((_, index) => stepTone(steps, index, active, peek));

  it('lights every bar up to the selected level and never the zero level below it', () => {
    expect(tones(4)).toEqual(['off', 'off', 'lit', 'lit', 'lit', 'off', 'off']);
    expect(tones(6)).toEqual(['off', 'off', 'lit', 'lit', 'lit', 'lit', 'lit']);
  });

  it('lights only its own step for Auto and for a zero level', () => {
    expect(tones(0)).toEqual(['lit', 'off', 'off', 'off', 'off', 'off', 'off']);
    expect(tones(1)).toEqual(['off', 'lit', 'off', 'off', 'off', 'off', 'off']);
  });

  it('lights nothing without a selection', () => {
    expect(tones(-1)).toEqual(['off', 'off', 'off', 'off', 'off', 'off', 'off']);
  });

  it('previews a higher level as ghost bars above the selection', () => {
    expect(tones(3, 5)).toEqual(['off', 'off', 'lit', 'lit', 'ghost', 'ghost', 'off']);
    expect(tones(-1, 3)).toEqual(['off', 'off', 'ghost', 'ghost', 'off', 'off', 'off']);
  });

  it('previews a lower level by fading the bars that would go out', () => {
    expect(tones(5, 3)).toEqual(['off', 'off', 'lit', 'lit', 'fade', 'fade', 'off']);
    // Auto or a zero level would put every bar out.
    expect(tones(5, 1)).toEqual(['off', 'ghost', 'fade', 'fade', 'fade', 'fade', 'off']);
    expect(tones(5, 0)).toEqual(['ghost', 'off', 'fade', 'fade', 'fade', 'fade', 'off']);
  });

  it('keeps the selected Auto or zero step lit while a level is previewed', () => {
    expect(tones(0, 3)).toEqual(['lit', 'off', 'ghost', 'ghost', 'off', 'off', 'off']);
    expect(tones(1, 2)).toEqual(['off', 'lit', 'ghost', 'off', 'off', 'off', 'off']);
  });

  it('ignores a preview of the selected step and one outside the steps', () => {
    expect(tones(4, 4)).toEqual(tones(4));
    expect(tones(4, 99)).toEqual(tones(4));
    expect(stepTone(steps, 99, 4, -1)).toBe('off');
  });
});

describe('the lighting sweep', () => {
  const steps = reasoningSteps(CODEX, true);

  it('finds the lit frontier of a selection', () => {
    expect(litFrontier(steps, 5)).toBe(3);
    expect(litFrontier(steps, 2)).toBe(0);
    expect(litFrontier(steps, 0)).toBe(-1);
    expect(litFrontier(steps, 1)).toBe(-1);
    expect(litFrontier(steps, -1)).toBe(-1);
  });

  it('staggers only the bars above the previous frontier', () => {
    expect([0, 1, 2, 3, 4].map((rank) => sweepSlot(rank, 1))).toEqual([0, 0, 0, 1, 2]);
    // One step up never waits.
    expect(sweepSlot(3, 2)).toBe(0);
  });

  it('caps a long sweep at three slots', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((rank) => sweepSlot(rank, -1))).toEqual([0, 1, 2, 3, 3, 3, 3]);
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
