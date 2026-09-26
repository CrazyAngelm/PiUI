import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../../../features/locale/language';
import { connectionLabel } from './connectionLabel';

afterEach(() => setLanguage('en'));

describe('canvas connection names', () => {
  it('names the kind and both ends instead of node ids', () => {
    expect(connectionLabel(get(t), 'result', 'Developer', 'Reviewer')).toBe('Result connection from Developer to Reviewer');
    expect(connectionLabel(get(t), 'spawn', 'Lead', 'Worker')).toBe('Delegate connection from Lead to Worker');
    expect(connectionLabel(get(t), 'start', 'Start', 'Planner')).toBe('Connection from Start to Planner');
  });

  it('translates the copy but never the node names', () => {
    setLanguage('ru');
    expect(connectionLabel(get(t), 'result', 'Developer', 'Reviewer')).toBe('Результат: связь от «Developer» к «Reviewer»');
    expect(connectionLabel(get(t), 'start', 'Старт', 'Planner')).toBe('Связь от «Старт» к «Planner»');
  });
});
