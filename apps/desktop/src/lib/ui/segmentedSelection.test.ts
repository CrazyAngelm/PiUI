import { describe, expect, it } from 'vitest';
import { nextSegmentedValue } from './segmentedSelection';

const languages = [{ value: 'en' }, { value: 'ru' }] as const;

describe('nextSegmentedValue', () => {
  it('selects another option', () => {
    expect(nextSegmentedValue('en', 'ru', languages)).toBe('ru');
  });

  it('ignores a press on the already selected option', () => {
    expect(nextSegmentedValue('en', 'en', languages)).toBeNull();
  });

  it('ignores the empty value the toggle group reports on deselect', () => {
    expect(nextSegmentedValue('ru', '', languages)).toBeNull();
  });

  it('ignores a value that is not an option', () => {
    expect(nextSegmentedValue('en', 'de', languages)).toBeNull();
  });

  it('keeps one option selected through repeated presses of the active option', () => {
    let selected: 'en' | 'ru' = 'en';
    // The toggle group sends "" for each press on the active item, then the other item's value.
    for (const requested of ['', '', 'ru', '', 'en', '']) {
      const next = nextSegmentedValue(selected, requested, languages);
      if (next !== null) selected = next;
      expect(['en', 'ru']).toContain(selected);
    }
    expect(selected).toBe('en');
  });
});
