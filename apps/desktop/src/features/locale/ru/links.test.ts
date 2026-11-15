import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINK_ERROR_COPY } from '../../../app/links/sessionLinks.svelte';
import { translate } from '../language';
import { linksRu } from './links';

/** Every `$t('…')` literal in the linked-chat components. */
function sourceKeys(): string[] {
  const base = new URL('../../../app/links/', import.meta.url);
  const keys = new Set<string>();
  for (const name of readdirSync(base).filter((file) => file.endsWith('.svelte'))) {
    for (const match of readFileSync(new URL(name, base), 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add((match[1] ?? '').replace(/\\'/g, "'"));
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || linksRu[key] === key;

describe('Russian copy for linked chats', () => {
  it('translates every visible string of the linked-chat components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(15);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the strings the chat menu, details, sidebar and settings add for it', () => {
    const keys = [
      'Link chat…',
      'Send to chat…',
      'Show linked chats',
      'Hide linked chats',
      'Linked chats',
      'Queued for {0}. It is delivered when that chat can take it.',
      'Agents can start other chats and exchange messages with them.',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the fixed text of every error code', () => {
    const texts = Object.values(LINK_ERROR_COPY);
    expect(texts).toHaveLength(11);
    expect(texts.filter((text) => !translated(text))).toEqual([]);
  });

  it('keeps placeholders intact', () => {
    for (const [key, value] of Object.entries(linksRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
