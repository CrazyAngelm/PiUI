import { describe, expect, it } from 'vitest';
import {
  MACRO_LIMITS, findMacroTokens, macroErrors, macroFromDraft, macroShortcutIndex, macroSummary,
  macroTokenAt, normalizeMacroKey, normalizeMacroName, parseMacros, parseSkillNames, type Macro, type MacroDraft,
} from './macro';

const review: Macro = { id: 'review', name: 'review', description: '', prompt: 'Review carefully.', skills: ['test-runner'] };
const other: Macro = { id: 'other', name: 'other', description: '', prompt: 'Fix it.', skills: [] };
const draft: MacroDraft = { name: 'review', description: '', prompt: 'Review carefully.', skills: [] };

describe('macro authoring', () => {
  it('normalizes names and skill input without duplicating skills', () => {
    expect(normalizeMacroName(' //ReView ')).toBe('review');
    expect(normalizeMacroName('//ПРОВЕРКА')).toBe('проверка');
    expect(parseSkillNames(' $review, /test-runner  review,, ns:skill\nunit.test ')).toEqual(['review', 'test-runner', 'ns:skill', 'unit.test']);
    expect(parseSkillNames(' , // $ ')).toEqual([]);
  });

  it.each([
    [{ name: '' }, 'name', 'Enter a name.'],
    [{ name: 'x'.repeat(MACRO_LIMITS.name + 1) }, 'name', 'The name is too long.'],
    [{ name: 'bad.name' }, 'name', 'Use letters, digits, hyphens and underscores.'],
    [{ name: '_bad' }, 'name', 'Use letters, digits, hyphens and underscores.'],
    [{ description: 'x'.repeat(MACRO_LIMITS.description + 1) }, 'description', 'The description is too long.'],
    [{ skills: Array.from({ length: MACRO_LIMITS.skills + 1 }, (_, i) => `s${i}`) }, 'skills', 'Too many skills.'],
    [{ skills: ['bad/skill'] }, 'skills', 'Skill names use letters, digits, dots, colons, hyphens and underscores.'],
    [{ skills: ['s'.repeat(MACRO_LIMITS.skill + 1)] }, 'skills', 'Skill names use letters, digits, dots, colons, hyphens and underscores.'],
    [{ prompt: ' ' }, 'content', 'Add a prompt or at least one skill.'],
    [{ prompt: 'x'.repeat(MACRO_LIMITS.prompt + 1) }, 'content', 'The prompt is too long.'],
  ] as const)('validates %j', (change, field, message) => {
    expect(macroErrors({ ...draft, ...change }, [])[field]).toBe(message);
  });

  it('rejects duplicate names and a full list, but permits editing an existing entry', () => {
    expect(macroErrors({ ...draft, name: '//REVIEW' }, [review]).name).toBe('Another macro already has this name.');
    const full = Array.from({ length: MACRO_LIMITS.macros }, (_, i) => ({ ...review, id: `id${i}`, name: `n${i}` }));
    expect(macroErrors(draft, full).name).toBe('Too many macros. Delete one first.');
    expect(macroErrors({ ...draft, id: 'id0' }, full)).toEqual({});
    expect(macroErrors(review, [review])).toEqual({});
  });

  it('accepts boundary values, skills only, and trims the stored draft', () => {
    expect(macroErrors({ ...draft, name: 'x'.repeat(MACRO_LIMITS.name), description: 'd'.repeat(MACRO_LIMITS.description), prompt: 'p'.repeat(MACRO_LIMITS.prompt), skills: Array(MACRO_LIMITS.skills).fill('s'.repeat(MACRO_LIMITS.skill)) }, [])).toEqual({});
    expect(macroErrors({ ...draft, prompt: '', skills: ['ns:skill', 'unit.test', 'x_y'] }, [])).toEqual({});
    expect(macroFromDraft({ name: ' //REVIEW ', description: ' description ', prompt: ' prompt ', skills: ['test'] }, 'id')).toEqual({ id: 'id', name: 'review', description: 'description', prompt: 'prompt', skills: ['test'] });
  });
});

describe('stored macros', () => {
  it.each([undefined, null, '', '{bad', '{}', 'null', '42'])('ignores invalid storage %s', (raw) => {
    expect(parseMacros(raw)).toEqual([]);
  });
  it('drops invalid entries and duplicate ids or names', () => {
    expect(parseMacros(JSON.stringify([
      null, [], 1, {}, { ...review, id: '' }, { ...review, id: 'x'.repeat(MACRO_LIMITS.id + 1) },
      { ...review, name: '?' }, review, { ...other, id: review.id }, { ...other, name: 'REVIEW' }, other,
    ]))).toEqual([review, other]);
  });
  it('applies the stored macro limit', () => {
    const entries = Array.from({ length: MACRO_LIMITS.macros + 1 }, (_, i) => ({ ...review, id: `id${i}`, name: `n${i}` }));
    expect(parseMacros(JSON.stringify(entries))).toEqual(entries.slice(0, MACRO_LIMITS.macros));
  });
});

describe('macro tokens', () => {
  it.each(['//review', 'do //review', 'do\n//review', '//Review', '//review.', '//review,', '//review)'])('finds %s', (text) => {
    const start = text.indexOf('//');
    expect(findMacroTokens(text, [review])).toEqual([{ start, end: start + 8, macro: review }]);
  });
  it.each(['//unknown', 'https://host', 'a//review', '//review.md', '//a/b', '///review'])('does not mark %s', (text) => {
    expect(findMacroTokens(text, [review])).toEqual([]);
  });
  it('finds several known tokens, including Cyrillic names', () => {
    const russian = { ...other, name: 'проверка' };
    expect(findMacroTokens('//review //other\n//Проверка //unknown', [review, other, russian]).map((token) => token.macro)).toEqual([review, other, russian]);
  });
  it('includes both token edges for caret editing', () => {
    const tokens = findMacroTokens('do //review now', [review]);
    for (const caret of [3, 4, 10, 11]) expect(macroTokenAt(tokens, caret)).toBe(tokens[0]);
    for (const caret of [0, 2, 12, 15]) expect(macroTokenAt(tokens, caret)).toBeUndefined();
  });
});

describe('macro summary', () => {
  it('summarizes the description, first prompt line, or skills', () => {
    expect(macroSummary({ ...review, description: 'Summary' })).toBe('Summary');
    expect(macroSummary({ ...review, prompt: ' first\nsecond ' })).toBe('first');
    expect(macroSummary({ ...review, prompt: '' })).toBe('test-runner');
    expect(macroSummary({ ...other, prompt: '' })).toBe('');
  });
});

describe('macro keys', () => {
  it('stores one lower-case letter, or none', () => {
    expect(normalizeMacroKey(' A ')).toBe('a');
    expect(normalizeMacroKey(undefined)).toBe('');
    expect(macroFromDraft({ ...draft, key: 'Ф' }, 'x').key).toBe('ф');
    expect('key' in macroFromDraft({ ...draft, key: '  ' }, 'x')).toBe(false);
  });
  it.each(['1', 'ab', '+', ' a b '])('rejects the key %j', (key) => {
    expect(macroErrors({ ...draft, name: 'fresh', key }, [])).toEqual({ key: 'Use one letter.' });
  });
  it('rejects a key another macro holds, but not the macro own key', () => {
    const held: Macro = { ...review, key: 'r' };
    expect(macroErrors({ ...draft, name: 'fresh', key: 'R' }, [held])).toEqual({ key: 'Another macro already uses this key.' });
    expect(macroErrors({ ...draft, id: 'review', key: 'r' }, [held])).toEqual({});
  });
  it('drops only the key of a stored macro whose key is bad or taken', () => {
    const stored = JSON.stringify([
      { ...review, key: 'r' },
      { ...other, key: 'R' },
      { ...other, id: 'third', name: 'third', key: '7' },
      { ...other, id: 'fourth', name: 'fourth', key: 5 },
    ]);
    expect(parseMacros(stored).map((macro) => [macro.name, macro.key])).toEqual([['review', 'r'], ['other', undefined], ['third', undefined], ['fourth', undefined]]);
  });
});

describe('macro list shortcuts', () => {
  const shown: Macro[] = [{ ...review, key: 'a' }, other, { ...other, id: 'ru', name: 'ru', key: 'ы' }];
  const press = (key: string, extra: { code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => macroShortcutIndex({ key, ...extra }, shown);
  it('picks the row a digit names, and nothing past the list', () => {
    expect([press('1'), press('2'), press('3'), press('4'), press('9')]).toEqual([0, 1, 2, -1, -1]);
    expect(press('0')).toBe(-1);
  });
  it('picks the macro that holds the letter, in any case', () => {
    expect([press('a'), press('A'), press('ы'), press('b')]).toEqual([0, 0, 2, -1]);
  });
  it('reads a letter typed on another layout as the Latin key on the same place', () => {
    expect(press('ф', { code: 'KeyA' })).toBe(0);
    // A key that names a macro by what it types wins over where it sits.
    expect(press('ы', { code: 'KeyS' })).toBe(2);
    expect(press('ф', { code: 'KeyB' })).toBe(-1);
  });
  it('does not turn a symbol or a Latin letter of another layout into a key', () => {
    // Dvorak types an apostrophe on the physical Q; a macro keyed q is not meant.
    expect(macroShortcutIndex({ key: "'", code: 'KeyQ' }, [{ ...review, key: 'q' }])).toBe(-1);
    // QWERTZ types z on the physical Y: z is z.
    expect(macroShortcutIndex({ key: 'z', code: 'KeyY' }, [{ ...review, key: 'y' }])).toBe(-1);
  });
  it('ignores shortcuts with a modifier, long key names and a space', () => {
    expect([press('a', { ctrlKey: true }), press('1', { metaKey: true }), press('a', { altKey: true })]).toEqual([-1, -1, -1]);
    expect([press('Enter'), press('Dead'), press(' ')]).toEqual([-1, -1, -1]);
  });
});
