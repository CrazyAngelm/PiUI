import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';
import { SCRIPT_TEST_ERROR_COPY } from '../../host-api/scriptTestClient';
import { NODE_TYPE_LABEL } from './nodeConversion';

/** Every visible English string of node conversion, the code editor and script tests. */
function sourceStrings(): string[] {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const calls = ['./NodeTypeMenu.svelte', './ScriptTestPanel.svelte', './code/ScriptEditor.svelte']
    .flatMap((path) => [...read(path).matchAll(/\$t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]!));
  const conversion = [...read('./nodeConversion.ts').matchAll(/'((?:[A-Z][^'\\]*|[^'\\]*\{0\}[^'\\]*))'/g)]
    .map((match) => match[1]!)
    .filter((text) => /\s/.test(text));
  const samples = [...read('./scriptTests.svelte.ts').matchAll(/error: '([^']+)'/g)].map((match) => match[1]!);
  const panel = [...read('./ScriptTestPanel.svelte').matchAll(/(?:label|note|[:?] )'([A-Z][^']+)'/g)].map((match) => match[1]!);
  return [...new Set([...calls, ...conversion, ...samples, ...panel, ...Object.values(NODE_TYPE_LABEL), ...Object.values(SCRIPT_TEST_ERROR_COPY)])]
    .filter((text) => text.trim() !== '' && !['stderr'].includes(text));
}

describe('step editing copy', () => {
  it('has Russian text for every new string', () => {
    const strings = sourceStrings();
    expect(strings.length).toBeGreaterThan(60);
    const missing = strings.filter((text) => translate(text, 'ru') === text);
    expect(missing).toEqual([]);
  });

  it('keeps the keyboard help of the code editor translated', () => {
    expect(translate('Tab indents. Press Esc, then Tab, to move focus out of the code.', 'ru')).not.toContain('Tab indents');
  });
});
