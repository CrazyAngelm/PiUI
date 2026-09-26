import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SESSION_TOOL_ERROR_COPY, SESSION_TOOL_HOST_MESSAGES } from '../../../host-api/sessionToolErrors';
import { HANDOFF_COPY } from '../../../app/handoff/handoff';
import { AREA_LABELS, CHANGE_LABELS } from '../../../app/review/review';
import { translate } from '../language';
import { sessionRu } from './session';

/** Every `$t('…')` literal in the session tool components. */
function sourceKeys(): string[] {
  const files: URL[] = [];
  for (const folder of ['../../../app/review/', '../../../app/worktrees/', '../../../app/handoff/']) {
    const base = new URL(folder, import.meta.url);
    files.push(...readdirSync(base).filter((name) => name.endsWith('.svelte')).map((name) => new URL(name, base)));
  }
  files.push(new URL('../../../app/history/ContinueInPiui.svelte', import.meta.url));
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add((match[1] ?? '').replace(/\\'/g, "'"));
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || sessionRu[key] === key;

describe('Russian copy for the session tools', () => {
  it('translates every visible string of the new components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(80);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates labels, the handoff template, refusals and shell entry points', () => {
    const keys = [
      ...Object.values(AREA_LABELS),
      ...Object.values(CHANGE_LABELS),
      ...Object.values(HANDOFF_COPY),
      ...Object.entries(SESSION_TOOL_ERROR_COPY)
        // Harness start refusals are translated by the workspace catalog.
        .filter(([code]) => !['SIGN_IN_REQUIRED', 'UNAVAILABLE', 'ACP_TRUST_REQUIRED', 'ACP_VERSION_UNCONFIRMED', 'ACP_SIGN_IN_REQUIRED'].includes(code))
        .map(([, text]) => text),
      ...SESSION_TOOL_HOST_MESSAGES,
      'Review changes',
      'Continue in another harness…',
      'in worktree {0}',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('keeps placeholders intact', () => {
    for (const [key, value] of Object.entries(sessionRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
