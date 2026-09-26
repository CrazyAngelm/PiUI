import { describe, expect, it } from 'vitest';
import { harnessMeta, rememberHarnessNames } from './harnessMeta';

describe('harnessMeta', () => {
  it('keeps built-in marks and names ACP agents from the host catalog', () => {
    expect(harnessMeta('codex').label).toBe('Codex');
    const before = harnessMeta('acp:lab-agent');
    expect(before.label).toBe('lab-agent');
    expect(before.monogram).toBe('L');
    rememberHarnessNames([{ kind: 'acp:lab-agent', name: 'Lab Agent' }, { kind: 'codex', name: 'Renamed' }]);
    const after = harnessMeta('acp:lab-agent');
    expect(after).toMatchObject({ label: 'Lab Agent', short: 'Lab Agent', monogram: 'L' });
    expect(after.hue).toBe(before.hue);
    expect(harnessMeta('codex').label).toBe('Codex');
    expect(harnessMeta('something-else').label).toBe('something-else');
  });
});
