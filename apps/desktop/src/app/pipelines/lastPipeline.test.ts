import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLastPipeline, lastPipelineKey, readLastPipeline, rememberLastPipeline } from './lastPipeline';

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
});

describe('last open pipeline', () => {
  beforeEach(() => memory.clear());

  it('is remembered per project under a versioned key', () => {
    expect(readLastPipeline('a')).toBeUndefined();
    rememberLastPipeline('a', 'command-1');
    rememberLastPipeline('b', 'command-2');
    expect(lastPipelineKey('a')).toBe('piui.pipelines.last.v1:a');
    expect(memory.get('piui.pipelines.last.v1:a')).toBe('command-1');
    expect(readLastPipeline('a')).toBe('command-1');
    expect(readLastPipeline('b')).toBe('command-2');
    rememberLastPipeline('a', 'command-3');
    expect(readLastPipeline('a')).toBe('command-3');
  });

  it('is forgotten for one project only', () => {
    rememberLastPipeline('a', 'command-1');
    rememberLastPipeline('b', 'command-2');
    forgetLastPipeline('a');
    expect(readLastPipeline('a')).toBeUndefined();
    expect(readLastPipeline('b')).toBe('command-2');
  });

  it('ignores an empty id', () => {
    rememberLastPipeline('a', '');
    expect(memory.size).toBe(0);
    memory.set(lastPipelineKey('a'), '');
    expect(readLastPipeline('a')).toBeUndefined();
  });

  it('never throws when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => rememberLastPipeline('a', 'command-1')).not.toThrow();
    expect(() => forgetLastPipeline('a')).not.toThrow();
    expect(readLastPipeline('a')).toBeUndefined();
  });
});
