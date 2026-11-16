import { describe, expect, it, vi } from 'vitest';
import { LazyPipelines, type PipelineCode } from './lazyPipelines.svelte';

describe('lazy pipeline code', () => {
  it('shares concurrent loads and remembers the loaded code', async () => {
    const code = {} as unknown as PipelineCode;
    let complete: (value: PipelineCode) => void = () => undefined;
    const loader = vi.fn(() => new Promise<PipelineCode>((resolve) => { complete = resolve; }));
    const lazy = new LazyPipelines(loader);
    const first = lazy.load();
    const second = lazy.load();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    complete(code);
    expect(await first).toBe(code);
    expect(await second).toBe(code);
    expect(lazy.code).toBe(code);
    expect(await lazy.load()).toBe(code);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('allows a failed load to be retried and clears failure on success', async () => {
    const code = {} as unknown as PipelineCode;
    const error = new Error('unavailable chunk');
    const loader = vi.fn<() => Promise<PipelineCode>>().mockRejectedValueOnce(error).mockResolvedValueOnce(code);
    const lazy = new LazyPipelines(loader);
    await expect(lazy.load()).rejects.toBe(error);
    expect(lazy.failed).toBe(true);
    expect(lazy.code).toBeUndefined();
    expect(await lazy.load()).toBe(code);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(lazy.failed).toBe(false);
    expect(lazy.code).toBe(code);
  });
});
