import { describe, expect, it } from 'vitest';
import { translate } from './language';
import { CATALOG_PREFIX, KNOWN_REASONING_LEVELS, reasoningLabel } from './reasoningLabel';

const english = (value: string): string => translate(value, 'en');
const russian = (value: string): string => translate(value, 'ru');

describe('reasoningLabel', () => {
  it('names every native level in English, each one differently', () => {
    const names = KNOWN_REASONING_LEVELS.map((level) => reasoningLabel(level, english));
    expect(names).toEqual(['Off', 'None', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never shows xhigh or max as High', () => {
    expect(reasoningLabel('high', english)).toBe('High');
    expect(reasoningLabel('xhigh', english)).not.toBe(reasoningLabel('high', english));
    expect(reasoningLabel('max', english)).not.toBe(reasoningLabel('high', english));
    expect(reasoningLabel('max', english)).not.toBe(reasoningLabel('xhigh', english));
  });

  it('names every native level in Russian, each one differently, none left in English', () => {
    const names = KNOWN_REASONING_LEVELS.map((level) => reasoningLabel(level, russian));
    expect(names).toEqual([
      'Отключено', 'Без рассуждений', 'Минимально', 'Низкое', 'Среднее', 'Высокое', 'Очень высокое', 'Максимальное', 'Ультра',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const level of KNOWN_REASONING_LEVELS) expect(russian(`${CATALOG_PREFIX}${level}`), level).not.toBe(`${CATALOG_PREFIX}${level}`);
  });

  it('turns the empty level into Auto', () => {
    expect(reasoningLabel('', english)).toBe('Auto');
    expect(reasoningLabel('', russian)).toBe(russian('Auto'));
  });

  it('leaves a level it does not know as the harness wrote it', () => {
    expect(reasoningLabel('turbo', english)).toBe('turbo');
    expect(reasoningLabel('turbo', russian)).toBe('turbo');
    // A bare id another screen translates ("none" is "нет" in sub-pipelines) is not read from there.
    expect(russian('none')).toBe('нет');
    expect(reasoningLabel('none', russian)).toBe('Без рассуждений');
    // Words of the object prototype are not levels either.
    expect(reasoningLabel('constructor', english)).toBe('constructor');
    expect(reasoningLabel('toString', english)).toBe('toString');
  });
});
