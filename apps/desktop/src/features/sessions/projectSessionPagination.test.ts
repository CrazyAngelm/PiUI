import { describe, expect, it } from 'vitest';
import {
  PROJECT_SESSION_PAGE_SIZE,
  nextProjectSessionCount,
  visibleProjectSessionCount,
} from './projectSessionPagination';

describe('project session pagination', () => {
  it('starts with at most the five newest catalog sessions', () => {
    expect(PROJECT_SESSION_PAGE_SIZE).toBe(5);
    expect(visibleProjectSessionCount(PROJECT_SESSION_PAGE_SIZE, 12)).toBe(5);
    expect(visibleProjectSessionCount(PROJECT_SESSION_PAGE_SIZE, 3)).toBe(3);
    expect(visibleProjectSessionCount(8, 12)).toBe(8);
  });

  it('reveals sessions in five-session pages without exceeding the catalog', () => {
    expect(nextProjectSessionCount(5, 12)).toBe(10);
    expect(nextProjectSessionCount(10, 12)).toBe(12);
  });

  it('keeps an empty catalog empty', () => {
    expect(visibleProjectSessionCount(PROJECT_SESSION_PAGE_SIZE, 0)).toBe(0);
    expect(nextProjectSessionCount(0, 0)).toBe(0);
  });
});
