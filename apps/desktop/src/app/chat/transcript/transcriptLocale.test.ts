import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../../../features/locale/ruCatalog';

describe('transcript activity copy', () => {
  it.each([
    'Thought',
    'Thought for {0}s',
    'Thought for {0}m {1}s',
    'Worked for {0}s',
    'Worked for {0}m {1}s',
    'Worked for {0}h {1}m',
    'Reasoning',
    '{0} failed',
    'Work plan',
    'Thinking…',
    'Stopped',
    'working…',
  ])('has a Russian translation for %s', (key) => {
    expect(lookupRussian(key)).toBeDefined();
  });

  it('keeps the work plan apart from the subscription plan', () => {
    expect(lookupRussian('Work plan')).not.toBe('Тариф');
  });
});
