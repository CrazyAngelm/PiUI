import { describe, expect, it } from 'vitest';
import { nextIndex } from './roving';

describe('nextIndex', () => {
  it('wraps left and right in a row', () => {
    expect(nextIndex('ArrowRight', 8, 9, 9)).toBe(0);
    expect(nextIndex('ArrowRight', 2, 9, 9)).toBe(3);
    expect(nextIndex('ArrowLeft', 0, 9, 9)).toBe(8);
    expect(nextIndex('ArrowDown', 2, 9, 9)).toBeUndefined();
    expect(nextIndex('Home', 4, 9, 9)).toBe(0);
    expect(nextIndex('End', 4, 9, 9)).toBe(8);
  });

  it('moves by a row in a grid and stays at the edge', () => {
    expect(nextIndex('ArrowDown', 3, 48, 8)).toBe(11);
    expect(nextIndex('ArrowUp', 11, 48, 8)).toBe(3);
    expect(nextIndex('ArrowUp', 3, 48, 8)).toBe(3);
    expect(nextIndex('ArrowDown', 45, 48, 8)).toBe(45);
  });

  it('ignores other keys and empty groups', () => {
    expect(nextIndex('a', 0, 5, 5)).toBeUndefined();
    expect(nextIndex('ArrowRight', 0, 0, 1)).toBeUndefined();
  });
});
