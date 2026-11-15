import { describe, expect, it } from 'vitest';
import { createReasoningClock, reasoningDuration } from './reasoningClock';

describe('createReasoningClock', () => {
  it('has no duration for a block that was never seen running', () => {
    expect(createReasoningClock().observe('a', false, 5_000)).toBeUndefined();
  });

  it('times a block from the first moment it was seen running', () => {
    const clock = createReasoningClock();
    expect(clock.observe('a', true, 1_000)).toBeUndefined();
    expect(clock.observe('a', false, 13_400)).toBe(12);
    expect(clock.observe('a', false, 99_000)).toBe(12);
  });

  it('does not move the start when the block is seen running again', () => {
    const clock = createReasoningClock();
    clock.observe('a', true, 1_000);
    clock.observe('a', true, 4_000);
    expect(clock.observe('a', false, 13_000)).toBe(12);
  });

  it('reports no label for a block that finished within a second', () => {
    const clock = createReasoningClock();
    clock.observe('a', true, 1_000);
    const seconds = clock.observe('a', false, 1_400);
    expect(seconds).toBe(0);
    expect(reasoningDuration(seconds ?? -1)).toBeUndefined();
  });

  it('forgets the oldest block once it holds too many', () => {
    const clock = createReasoningClock();
    for (let index = 0; index < 401; index += 1) clock.observe(`block-${index}`, true, 1_000);
    expect(clock.observe('block-0', false, 5_000)).toBeUndefined();
    expect(clock.observe('block-400', false, 5_000)).toBe(4);
  });
});

describe('reasoningDuration', () => {
  it('splits seconds into minutes and seconds', () => {
    expect(reasoningDuration(12)).toEqual({ minutes: 0, seconds: 12 });
    expect(reasoningDuration(75)).toEqual({ minutes: 1, seconds: 15 });
  });

  it('has nothing to say under one second', () => {
    expect(reasoningDuration(0)).toBeUndefined();
  });
});
