import { describe, expect, it } from 'vitest';
import fixtures from '../../../../contracts/fixtures/trigger-patterns-v7.json';
import { PATTERN_ISSUE_COPY, patternIssue, patternLines, patternListIssue, type PatternIssue } from './triggerPatterns';

describe('file-change automation patterns (host v7.2)', () => {
  it('agrees with the host on every shared fixture', () => {
    for (const pattern of fixtures.valid) expect(patternIssue(pattern), pattern).toBeUndefined();
    for (const [pattern, issue] of fixtures.invalid) expect(patternIssue(pattern ?? ''), pattern).toBe(issue);
    expect(patternIssue('a'.repeat(257))).toBe('too-long');
    // Byte length, like the host: 129 two-byte letters exceed 256 bytes.
    expect(patternIssue('ё'.repeat(129))).toBe('too-long');
  });

  it('turns editor lines into the stored list', () => {
    expect(patternLines('  src/**/*.ts \n\n./docs/\r\nsrc\\app\\*.svelte\n')).toEqual(['src/**/*.ts', 'docs/', 'src/app/*.svelte']);
    expect(patternLines('   \n')).toEqual([]);
  });

  it('reports the first problem of a list', () => {
    expect(patternListIssue([], true)).toEqual({ kind: 'none-included' });
    expect(patternListIssue([], false)).toBeUndefined();
    expect(patternListIssue(Array.from({ length: 33 }, (_, index) => `a${index}/*`), true)).toEqual({ kind: 'too-many' });
    expect(patternListIssue(['src/**', '../x'], true)).toEqual({ kind: 'pattern', pattern: '../x', issue: 'dot-segment' });
  });

  it('explains every refusal', () => {
    const issues: PatternIssue[] = ['empty', 'too-long', 'control', 'backslash', 'absolute', 'dot-segment', 'empty-segment', 'double-star', 'bracket', 'brace'];
    for (const issue of issues) expect(PATTERN_ISSUE_COPY[issue].length).toBeGreaterThan(5);
  });
});
