import { describe, expect, it } from 'vitest';
import { composeReply, MAX_PAYLOAD, MAX_REPLY, normalizeReply } from './reply';

describe('interactive reply content', () => {
  it('normalizes plain text and refuses an empty reply', () => {
    expect(composeReply('  Use this plan  ', null)).toBe('Use this plan');
    expect(composeReply('  Use this plan  ', '  ')).toBe('Use this plan');
    expect(normalizeReply(' \u0000\r ')).toBeUndefined();
    expect(composeReply('', '{"x":1}')).toBeUndefined();
  });
  it('includes a complete compact JSON block after the normalized text', () => {
    expect(composeReply(' Choose A ', '{ "rows": [1, 2] }')).toBe('Choose A\n\n```json\n{"rows":[1,2]}\n```');
  });
  it('refuses oversized or invalid payloads instead of truncating them', () => {
    expect(composeReply('Choose A', JSON.stringify('a'.repeat(MAX_PAYLOAD)))).toBeUndefined();
    expect(composeReply('Choose A', '{"rows":[')).toBeUndefined();
  });
  it('escapes fence terminators within JSON strings without changing their values', () => {
    const reply = composeReply('Keep code', '{"text":"```js\\nexample\\n```"}');
    expect(reply).toBe('Keep code\n\n```json\n{"text":"\\u0060\\u0060\\u0060js\\nexample\\n\\u0060\\u0060\\u0060"}\n```');
    expect(JSON.parse(reply!.split('\n')[3]!)).toEqual({ text: '```js\nexample\n```' });
  });
  it('removes control characters except newline and tab, then caps and trims text', () => {
    expect(normalizeReply(' \u0000A\r\nB\tC\u007f\u0085 ')).toBe('A\nB\tC');
    expect(normalizeReply('x'.repeat(MAX_REPLY - 1) + ' y')).toBe('x'.repeat(MAX_REPLY - 1));
    expect(normalizeReply('x'.repeat(MAX_REPLY + 1))).toHaveLength(MAX_REPLY);
  });
});
