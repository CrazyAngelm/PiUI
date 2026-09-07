import { describe, expect, it } from 'vitest';
import { runUsageTotal, usageTotal } from './runUsage';
describe('native run consumption', () => {
  it('deduplicates session identities without adding cache tokens to native totals', () => {
    const data = { a: [{ id: 'total', totalTokens: 100, cacheReadTokens: 80 }] };
    expect(runUsageTotal(['a','a'], data, 'totalTokens')).toBe(100);
    expect(runUsageTotal(['a'], data, 'cacheReadTokens')).toBe(80);
  });
  it('retains unknown values and rejects invalid or overflowing counts', () => {
    expect(runUsageTotal(['a','b'], { a: [{id:'a', totalTokens:0}] }, 'totalTokens')).toBeUndefined();
    expect(usageTotal([{id:'a', outputTokens:0}], 'outputTokens')).toBe(0);
    expect(usageTotal([{id:'a', outputTokens:-1}], 'outputTokens')).toBeUndefined();
    expect(usageTotal([{id:'a', outputTokens:Number.MAX_SAFE_INTEGER},{id:'b',outputTokens:1}], 'outputTokens')).toBeUndefined();
  });
});
