import { describe, expect, it } from 'vitest';
import { expandMacros, macroText, skillInvocation } from './expand';
import type { Macro } from './macro';

const review: Macro = { id: 'review', name: 'review', description: '', prompt: 'Review carefully.', skills: ['test-runner'] };
const other: Macro = { id: 'other', name: 'other', description: '', prompt: 'Fix it.', skills: [] };
const dollar = { dollar: true };

describe('macro text', () => {
  it('uses listed mentions, native commands, or the harness skill syntax', () => {
    expect(skillInvocation('review', { skills: [{ name: 'review', mention: '$exact-review' }], commands: [{ name: 'skill:review' }], dollar: true })).toBe('$exact-review');
    expect(skillInvocation('review', { commands: [{ name: 'skill:review' }], dollar: true })).toBe('/skill:review');
    expect(skillInvocation('review', { commands: [{ name: 'review' }], dollar: false })).toBe('/review');
    expect(skillInvocation('review', dollar)).toBe('$review');
    expect(skillInvocation('review', { dollar: false })).toBe('/review');
  });
  it('joins skills then prompt with one space', () => {
    expect(macroText(review, dollar)).toBe('$test-runner Review carefully.');
    expect(macroText(other, dollar)).toBe('Fix it.');
    expect(macroText({ ...review, prompt: '' }, { dollar: false })).toBe('/test-runner');
  });
  it('expands every known token, preserves unknown text, and never scans inserted content', () => {
    expect(expandMacros('//review and //other, //unknown', [review, other], dollar)).toBe('$test-runner Review carefully. and Fix it., //unknown');
    expect(expandMacros('//review //other', [{ ...review, skills: [], prompt: '//other' }, other], dollar)).toBe('//other Fix it.');
    expect(expandMacros('plain\ntext', [review], dollar)).toBe('plain\ntext');
    expect(expandMacros('//review', [], dollar)).toBe('//review');
  });
  it('moves native skill commands to the start of the message, each once and in order', () => {
    const slash = { dollar: false };
    const ship: Macro = { id: 'ship', name: 'ship', description: '', prompt: '', skills: ['changelog', 'test-runner'] };
    expect(expandMacros('please //review', [review], slash)).toBe('/test-runner please Review carefully.');
    expect(expandMacros('//review then //ship now', [review, ship], slash)).toBe('/test-runner /changelog Review carefully. then now');
    expect(expandMacros('do it //ship', [ship], slash)).toBe('/changelog /test-runner do it');
    expect(expandMacros('first\n//other', [other], slash)).toBe('first\nFix it.');
    // A message that already starts with a command keeps the skills where the macro stood.
    expect(expandMacros('/compact //review', [review], slash)).toBe('/compact /test-runner Review carefully.');
    // An agent resolves a `$name` mention anywhere: it stays in place.
    expect(expandMacros('please //review', [review], dollar)).toBe('please $test-runner Review carefully.');
  });
  it('writes a skill with the prefix of native commands', () => {
    expect(skillInvocation('review', { dollar: false, prefix: 'skill:' })).toBe('/skill:review');
    expect(skillInvocation('review', { dollar: true, prefix: 'skill:' })).toBe('$review');
  });
});
