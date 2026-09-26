import { describe, expect, it } from 'vitest';
import { activeMention, fileMention, rankFiles, rankNamed, replaceMention, splitImageMarkers } from './mentions';

const ALL = { slash: true, at: true, dollar: true } as const;

describe('composer mentions', () => {
  it('finds `/` only as the whole first token of the message', () => {
    expect(activeMention('/rev', 4, ALL)).toEqual({ trigger: '/', query: 'rev', start: 0, end: 4 });
    expect(activeMention('/review now', 11, ALL)).toBeUndefined();
    expect(activeMention('see /review', 11, ALL)).toBeUndefined();
    expect(activeMention('/rev', 4, { ...ALL, slash: false })).toBeUndefined();
  });

  it('finds `@` and `$` tokens at the caret after whitespace or at the start', () => {
    expect(activeMention('look at @src/ma', 15, ALL)).toEqual({ trigger: '@', query: 'src/ma', start: 8, end: 15 });
    expect(activeMention('@', 1, ALL)).toEqual({ trigger: '@', query: '', start: 0, end: 1 });
    expect(activeMention('run $test and', 9, ALL)).toEqual({ trigger: '$', query: 'test', start: 4, end: 9 });
    // The caret inside a token still edits that token.
    expect(activeMention('open @src/main.rs now', 9, ALL)).toEqual({ trigger: '@', query: 'src', start: 5, end: 17 });
    expect(activeMention('mail me@example.com', 19, ALL)).toBeUndefined();
    expect(activeMention('cost $5', 7, { ...ALL, dollar: false })).toBeUndefined();
    expect(activeMention('look @x', 7, { ...ALL, at: false })).toBeUndefined();
  });

  it('replaces the token with the harness syntax and one space', () => {
    const mention = activeMention('look at @src/ma please', 15, ALL);
    if (!mention) throw new Error('no mention');
    expect(replaceMention('look at @src/ma please', mention, '@src/main.rs')).toEqual({ text: 'look at @src/main.rs please', caret: 21 });
    const last = activeMention('run $te', 7, ALL);
    if (!last) throw new Error('no mention');
    expect(replaceMention('run $te', last, '$test-runner')).toEqual({ text: 'run $test-runner ', caret: 17 });
    expect(fileMention('docs/spec sheet.pdf')).toBe('@"docs/spec sheet.pdf"');
    expect(fileMention('src/main.rs')).toBe('@src/main.rs');
  });

  it('ranks file-name matches before path and fuzzy matches', () => {
    const files = ['src/app/ChatComposer.svelte', 'src/composer/mentions.ts', 'docs/composer-notes.md', 'src/main.ts', 'README.md'];
    expect(rankFiles(files, 'compo')).toEqual(['docs/composer-notes.md', 'src/app/ChatComposer.svelte', 'src/composer/mentions.ts']);
    expect(rankFiles(files, 'srcmn')).toEqual(['src/main.ts', 'src/composer/mentions.ts']);
    expect(rankFiles(files, '')).toEqual(files);
    expect(rankFiles(files, 'zzz')).toEqual([]);
    expect(rankFiles(files, '', 2)).toHaveLength(2);
  });

  it('ranks named entries by name prefix, name, then description', () => {
    const entries = [
      { name: 'skill:review', description: 'Review a diff' },
      { name: 'review', description: 'Review the current changes' },
      { name: 'fix-tests', description: 'Fix failing tests' },
    ];
    expect(rankNamed(entries, 'rev').map((entry) => entry.name)).toEqual(['review', 'skill:review']);
    expect(rankNamed(entries, 'failing').map((entry) => entry.name)).toEqual(['fix-tests']);
  });

  it('splits the image markers the bridges append to a user block', () => {
    expect(splitImageMarkers('What is this?\n\n[image]\n[image]')).toEqual({ text: 'What is this?', images: 2 });
    expect(splitImageMarkers('[image]')).toEqual({ text: '', images: 1 });
    expect(splitImageMarkers('Plain text')).toEqual({ text: 'Plain text', images: 0 });
    expect(splitImageMarkers('[image] is a word here')).toEqual({ text: '[image] is a word here', images: 0 });
  });
});
