import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESYNC_COOLDOWN_MS, RESYNC_SETTLE_MS, createResync } from './resync';

afterEach(() => vi.useRealTimers());

describe('resync', () => {
  it('turns a burst of requests into one run after they settle', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createResync(run);
    resync.request();
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS - 1);
    resync.request();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESYNC_COOLDOWN_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps runs apart: a request right after a run waits for the cooldown, and only one is kept', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createResync(run);
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    resync.request();
    resync.request();
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_COOLDOWN_MS - 1000 - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RESYNC_COOLDOWN_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs again after a quiet period without waiting beyond the settle time', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createResync(run);
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    await vi.advanceTimersByTimeAsync(RESYNC_COOLDOWN_MS);
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops a scheduled run on cancel', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createResync(run);
    resync.request();
    resync.cancel();
    await vi.advanceTimersByTimeAsync(RESYNC_COOLDOWN_MS);
    expect(run).not.toHaveBeenCalled();
    resync.request();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a run that throws or rejects', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('remount failed')).mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    const resync = createResync(run, 10, 20);
    resync.request();
    await vi.advanceTimersByTimeAsync(10);
    resync.request();
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
