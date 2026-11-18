import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../language';
import { interactiveRu } from './interactive';

const renderer = readFileSync(new URL('../../../app/interactive/renderer.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../../../app/shell/SettingsView.svelte', import.meta.url), 'utf8');
const settingsKeys = ['Interactive answers', 'Forms, tables and charts in agent answers. Applies to chats started after the change.'];

function rendererKeys(): string[] {
  const keys = new Set<string>();
  for (const match of renderer.matchAll(/label\([^,]+,\s*(?:"([^"]+)"|[a-zA-Z]+\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)")/g)) {
    for (const key of match.slice(1)) if (key !== undefined) keys.add(key);
  }
  return [...keys];
}

describe('Russian copy for interactive answers', () => {
  it('translates every renderer label through the app catalog', () => {
    const keys = rendererKeys();
    expect(keys).toContain('The interface is too large. Showing its source.');
    expect(keys).toContain('Copied');
    expect(keys).toContain('Not sent. Try again.');
    expect(keys).toContain('Waiting for the file: {0}');
    expect(keys).toContain('{0}: arrow keys move, Shift and arrow keys resize');
    expect(keys.filter(key => translate(key, 'ru') === key)).toEqual([]);
    expect(keys.filter(key => interactiveRu[key] === undefined)).toEqual([]);
  });

  it('translates the reasons a reply is off and the block name used outside the transcript', () => {
    const decorate = readFileSync(new URL('../../../app/interactive/decorate.ts', import.meta.url), 'utf8');
    const keys = [...decorate.matchAll(/^ {2}(?:'[a-z-]+'|[a-z]+): '([^']+)',$/gm)].map(match => match[1]!);
    expect(keys).toHaveLength(5);
    for (const key of [...keys, 'Interactive block']) {
      expect(interactiveRu[key], key).toBeDefined();
      expect(translate(key, 'ru'), key).not.toBe(key);
    }
  });

  it('translates the added Settings rows', () => {
    for (const key of settingsKeys) {
      expect(settings).toContain(`$t('${key}')`);
      expect(translate(key, 'ru'), key).not.toBe(key);
    }
  });

  it('preserves placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const [key, value] of Object.entries(interactiveRu)) expect(placeholders(value), key).toEqual(placeholders(key));
  });
});
