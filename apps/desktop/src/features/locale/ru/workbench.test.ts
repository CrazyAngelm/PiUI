import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../language';
import { workbenchRu } from './workbench';

/** Every `$t('…')` literal in the pane components. */
function sourceKeys(): string[] {
  const base = new URL('../../../app/shell/panes/', import.meta.url);
  const keys = new Set<string>();
  for (const name of readdirSync(base).filter((file) => file.endsWith('.svelte'))) {
    for (const match of readFileSync(new URL(name, base), 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add((match[1] ?? '').replace(/\\'/g, "'"));
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || workbenchRu[key] === key;

describe('Russian copy for tabs and split panes', () => {
  it('translates every visible string of the pane components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the strings the shell, sidebar, chat and settings add for it', () => {
    const keys = [
      'Hide sidebar',
      'Show sidebar',
      'Open to the side',
      'Close pane',
      'Four chats are on screen. Close one first.',
      'New result',
      // The Shortcuts list in Settings.
      'Hide or show the sidebar',
      'Close tab',
      'Next tab',
      'Next pane',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('keeps placeholders intact', () => {
    for (const [key, value] of Object.entries(workbenchRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
