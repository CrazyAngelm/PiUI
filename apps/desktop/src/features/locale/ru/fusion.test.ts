import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../language';
import { fusionRu } from './fusion';

/** Names that read the same in both languages. */
const SAME_IN_RUSSIAN = new Set(['Fusion']);

/** Every `$t('…')` literal of the Fusion components, including the ones split over lines. */
function sourceKeys(): string[] {
  const base = new URL('../../../app/fusion/', import.meta.url);
  const keys = new Set<string>();
  for (const name of readdirSync(base).filter((file) => file.endsWith('.svelte'))) {
    for (const match of readFileSync(new URL(name, base), 'utf8').matchAll(/\$t\(\s*'((?:[^'\\]|\\.)+)'/g)) {
      keys.add((match[1] ?? '').replace(/\\'/g, "'"));
    }
  }
  return [...keys];
}

const placeholders = (value: string): string[] => (value.match(/\{\d+\}/g) ?? []).sort();

describe('Russian copy for Fusion', () => {
  it('translates every visible string of the Fusion components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((key) => !SAME_IN_RUSSIAN.has(key) && translate(key, 'ru') === key)).toEqual([]);
  });

  it('keeps every placeholder of the English text', () => {
    for (const [key, value] of Object.entries(fusionRu)) {
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
