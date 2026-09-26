import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HISTORY_NOTICES } from '../../../app/history/historyStore.svelte';
import { parseStateLabel, treeIssueLabel } from '../../../app/history/piHistory';
import { EXTENSIONS_MESSAGES } from '../../../host-api/extensionsClient';
import { FALLBACK_MESSAGE, PI_HISTORY_MESSAGES } from '../../../host-api/piHistoryClient';
import { translate } from '../language';
import { classicRu } from './classic';

/** Screens ported from the classic views; every literal `$t` key needs Russian copy. */
const PORTED_FILES = [
  '../../../app/history/HistoryView.svelte',
  '../../../app/history/HistoryDetails.svelte',
  '../../../app/history/SessionBranches.svelte',
  '../../../app/settings/ExtensionsSettings.svelte',
  '../../../app/settings/ClassicViewEntry.svelte',
  '../../../app/projects/ProjectDialogs.svelte',
  '../../../app/chat/extensions/ExtensionSurface.svelte',
];

/** Keys added to shared screens (sidebar, palette, transcript, approval card, classic settings). */
const SHARED_KEYS = [
  '{0} session history',
  'Open session history',
  'Load earlier history',
  'Rename…',
  'Pin to top',
  'Unpin',
  'Remove from PiUI…',
  'Could not update the project',
  'This request closes automatically if you do not answer.',
  'New interface',
];

function literalKeys(path: string): string[] {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const keys: string[] = [];
  for (const match of source.matchAll(/\$t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) keys.push(match[2] ?? '');
  return keys;
}

describe('Russian copy for the classic parity port', () => {
  it('translates every visible string of the ported screens', () => {
    const keys = new Set([
      ...PORTED_FILES.flatMap(literalKeys),
      ...SHARED_KEYS,
      ...HISTORY_NOTICES,
      ...EXTENSIONS_MESSAGES,
      ...Object.values(PI_HISTORY_MESSAGES),
      FALLBACK_MESSAGE,
      ...(['partial', 'unsupported', 'corrupt'] as const).map((state) => parseStateLabel(state) ?? ''),
      ...(['orphan', 'cycle', 'duplicate', 'depth-limit', 'truncated'] as const).map(treeIssueLabel),
    ]);
    expect(keys.size).toBeGreaterThan(60);
    const missing = [...keys].filter((key) => translate(key, 'ru') === key);
    expect(missing).toEqual([]);
  });

  it('keeps the catalog free of empty or untrimmed entries', () => {
    for (const [key, value] of Object.entries(classicRu)) {
      expect(value.trim(), key).not.toBe('');
      expect(key.trim(), key).toBe(key);
      expect(value.trim(), key).toBe(value);
    }
  });

  it('keeps placeholders intact in translations', () => {
    for (const [key, value] of Object.entries(classicRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
