import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../language';
import { activityRu } from './activity';

/** Every `$t('…')` literal in the activity components. */
function sourceKeys(): string[] {
  const base = new URL('../../../app/chat/activity/', import.meta.url);
  const keys = new Set<string>();
  for (const name of readdirSync(base).filter((file) => file.endsWith('.svelte'))) {
    for (const match of readFileSync(new URL(name, base), 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add((match[1] ?? '').replace(/\\'/g, "'"));
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || activityRu[key] === key;

describe('Russian copy for the chat activity', () => {
  it('translates every visible string of the activity components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the strings the details panel and the toolbar add for it', () => {
    const keys = ['Activity', '{0} running in this chat', 'Details', 'Mode'];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('keeps placeholders intact and fills them', () => {
    for (const [key, value] of Object.entries(activityRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
    expect(translate('{0} running in this chat', 'ru')).toBe('Запущено в этом чате: {0}');
  });
});
