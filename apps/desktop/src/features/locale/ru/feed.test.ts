import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../language';
import { feedRu } from './feed';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const sources = ['../../../components/MarkdownContent.svelte', '../../../shared/conversation/CompactionNote.svelte', '../../../shared/conversation/FullAnswerNotice.svelte'].map(read);

/** Every literal the feed components pass to the translator. */
function keys(): string[] {
  const found = new Set<string>();
  for (const source of sources) for (const match of source.matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) found.add((match[1] ?? '').replace(/\\'/g, "'"));
  return [...found];
}

describe('Russian copy for the chat feed', () => {
  it('translates every phrase the feed components show', () => {
    const phrases = keys();
    expect(phrases).toContain('Link copied. Open it in your browser.');
    expect(phrases).toContain('Context compaction failed');
    expect(phrases).toContain('This answer was shortened to keep the chat responsive.');
    expect(phrases.filter((phrase) => translate(phrase, 'ru') === phrase)).toEqual([]);
  });

  it('keeps the placeholder of the copy label', () => {
    expect(feedRu['Copy {0}']).toContain('{0}');
  });
});
