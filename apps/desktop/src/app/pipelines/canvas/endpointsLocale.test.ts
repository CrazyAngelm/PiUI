import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../../../features/locale/language';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Every visible string of the Start and Output blocks that is new, and where it is written. */
const COPY: readonly (readonly [string, string])[] = [
  ['Start connects automatically', './StartNodeCard.svelte'],
  ['Start connects automatically', './FlowCanvas.svelte'],
  ['{0} has nothing before it, so it already starts with the run.', './FlowCanvas.svelte'],
  ['{0} waits for the steps connected to it. Remove those connections to start it with the run.', './FlowCanvas.svelte'],
  ['{0} is on call: it starts only when another agent calls it.', './FlowCanvas.svelte'],
  ['Start and Output stay in every pipeline', './FlowCanvas.svelte'],
  ['Delete steps or connections instead.', './FlowCanvas.svelte'],
];

describe('Start and Output block copy', () => {
  it.each(COPY)('has Russian text for "%s" and uses it in %s', (text, file) => {
    expect(translate(text, 'ru')).not.toBe(text);
    expect(read(file)).toContain(`'${text}'`);
  });

  it('keeps the step name placeholder in every Russian sentence', () => {
    for (const [text] of COPY.filter(([value]) => value.includes('{0}'))) expect(translate(text, 'ru')).toContain('{0}');
  });
});
