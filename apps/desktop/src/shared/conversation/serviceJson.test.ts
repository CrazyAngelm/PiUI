import { describe, expect, it } from 'vitest';
import { isServiceJson } from './serviceJson';

describe('isServiceJson', () => {
  it('folds a message that is one JSON object', () => {
    expect(isServiceJson('{"id":1,"timeoutMs":20000,"format":"full output"}')).toBe(true);
  });
  it('keeps prose, arrays and broken JSON', () => {
    expect(isServiceJson('Here is {"a":1}')).toBe(false);
    expect(isServiceJson('[{"a":1}]')).toBe(false);
    expect(isServiceJson('{"a": nope}')).toBe(false);
    expect(isServiceJson(undefined)).toBe(false);
  });
  it('folds an unfinished object only while streaming', () => {
    expect(isServiceJson('{"command":"rg -n', true)).toBe(true);
    expect(isServiceJson('{"command":"rg -n', false)).toBe(false);
  });
});
