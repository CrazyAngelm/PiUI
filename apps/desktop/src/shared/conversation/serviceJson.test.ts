import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import { isServiceData } from './serviceJson';

const answer = (patch: Partial<TimelineBlock>): TimelineBlock => ({ id: 'a', kind: 'assistant', status: 'complete', ...patch });

describe('isServiceData', () => {
  it('keeps an assistant answer that is JSON, whatever its shape or progress', () => {
    expect(isServiceData(answer({ text: '{"answer":42}' }))).toBe(false);
    expect(isServiceData(answer({ text: '{"id":1,"timeoutMs":20000,"format":"full output"}' }))).toBe(false);
    expect(isServiceData(answer({ text: '{"command":"rg -n', status: 'streaming' }))).toBe(false);
    expect(isServiceData(answer({ text: '[{"a":1}]' }))).toBe(false);
  });

  it('folds only an assistant block the protocol ties to a tool', () => {
    expect(isServiceData(answer({ toolName: 'bash', text: '{"command":"pwd"}' }))).toBe(true);
    expect(isServiceData(answer({ toolName: '' }))).toBe(false);
    expect(isServiceData({ kind: 'user', toolName: 'bash' })).toBe(false);
    expect(isServiceData({ kind: 'tool', toolName: 'bash' })).toBe(false);
  });
});
