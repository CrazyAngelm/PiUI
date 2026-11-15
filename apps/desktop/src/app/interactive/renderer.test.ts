import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, formatValue, parsePartialJson, parseSpec, setIntelligentUiLocale } from './renderer.js';

afterEach(() => setIntelligentUiLocale('en-US'));

describe('interactive answer parsing and expressions', () => {
  it('parses a complete specification without changing its content', () => {
    const spec = { title: 'Estimate', state: { count: 3 }, body: [{ type: 'stat', label: 'Total', value: '=count * 2' }] };
    expect(parseSpec(JSON.stringify(spec))).toEqual({ value: spec, closed: true });
  });

  it('keeps the usable parts of a cut-off specification', () => {
    const result = parsePartialJson('{"title":"Estimate","body":[{"type":"text","text":"Still building');
    expect(result.closed).toBe(false);
    expect(result.value).toMatchObject({ title: 'Estimate', body: [{ type: 'text', text: 'Still building' }] });
  });

  it.each([
    ['price * count - 2', 13],
    ['price >= 5 && count == 3', true],
    ["count > 1 ? 'many' : 'one'", 'many'],
    ['round(10 / 3, 2)', 3.33],
    ['sum([1, 2, 3])', 6],
    ['clamp(20, 0, 10)', 10],
  ])('evaluates %s with the own interpreter', (expression, expected) => {
    const values: Record<string, unknown> = { price: 5, count: 3 };
    expect(evaluate(expression, { get: name => values[name] })).toEqual(expected);
  });

  it('returns no value for an invalid expression', () => {
    expect(evaluate('price + (', { get: () => undefined })).toBeUndefined();
  });
});

describe.each([
  { locale: 'en-US', number: '1,234.5', percent: '25.5 %', usd: '$1,000', compact: '1.3M' },
  { locale: 'ru-RU', number: '1 234,5', percent: '25,5 %', usd: '1 000 $', compact: '1,3 млн' },
])('interactive answer formatting in $locale', ({ locale, number, percent, usd, compact }) => {
  const spaces = (value: string) => value.replace(/[\u00a0\u202f]/gu, ' ');
  it('formats numbers', () => {
    setIntelligentUiLocale(locale);
    expect(spaces(formatValue(1234.5, 'number', 1))).toBe(number);
  });
  it('formats percent values without rescaling them', () => {
    setIntelligentUiLocale(locale);
    expect(spaces(formatValue(25.5, 'percent'))).toBe(percent);
  });
  it('formats USD', () => {
    setIntelligentUiLocale(locale);
    expect(spaces(formatValue(1000, 'usd'))).toBe(usd);
  });
  it('formats compact values', () => {
    setIntelligentUiLocale(locale);
    expect(spaces(formatValue(1_250_000, 'compact'))).toBe(compact);
  });
  it('formats durations', () => {
    setIntelligentUiLocale(locale);
    expect(formatValue(65, 'duration')).toBe('1:05');
    expect(formatValue(3723, 'duration')).toBe('1:02:03');
  });
});

it('uses English for an unsupported formatting locale', () => {
  setIntelligentUiLocale('de-DE');
  expect(formatValue(1234.5, 'number', 1)).toBe('1,234.5');
});
