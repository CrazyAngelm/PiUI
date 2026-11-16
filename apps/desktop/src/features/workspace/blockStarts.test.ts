import { beforeEach, describe, expect, it } from 'vitest';
import { blockStartedAt, forgetBlockStarts, noteBlockStart } from './blockStarts';

beforeEach(forgetBlockStarts);
describe('block starts', () => {
  it('keeps the first note', () => {
    noteBlockStart('s', 'b', 1);
    noteBlockStart('s', 'b', 2);
    expect(blockStartedAt('s', 'b')).toBe(1);
  });
  it('has no instant for an unknown block', () => {
    expect(blockStartedAt('s', 'unknown')).toBeUndefined();
  });
  it('keeps sessions separate', () => {
    noteBlockStart('a', 'b', 1);
    noteBlockStart('b', 'b', 2);
    expect(blockStartedAt('a', 'b')).toBe(1);
    expect(blockStartedAt('b', 'b')).toBe(2);
  });
  it('forgets the oldest entry past 256', () => {
    for (let i = 0; i <= 256; i++) noteBlockStart('s', String(i), i);
    expect(blockStartedAt('s', '0')).toBeUndefined();
    expect(blockStartedAt('s', '1')).toBe(1);
    expect(blockStartedAt('s', '256')).toBe(256);
  });
});
