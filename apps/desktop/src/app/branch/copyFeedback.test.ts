import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyFeedback } from './copyFeedback.svelte';

describe('copy feedback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the copied state for 1.5 seconds', async () => {
    const write = vi.fn(async () => undefined);
    const feedback = new CopyFeedback(write);
    await feedback.copy({ id: 'a1', kind: 'assistant', text: 'Answer' });
    expect(write).toHaveBeenCalledWith('Answer');
    expect(feedback.id).toBe('a1');
    vi.advanceTimersByTime(1499);
    expect(feedback.id).toBe('a1');
    vi.advanceTimersByTime(2);
    expect(feedback.id).toBe('');
  });

  it('restarts the timer on a second copy and throws when the clipboard refuses', async () => {
    const feedback = new CopyFeedback(async () => undefined);
    await feedback.copy({ id: 'a1', kind: 'assistant', text: 'one' });
    vi.advanceTimersByTime(1000);
    await feedback.copy({ id: 'u1', kind: 'user', text: 'two' });
    vi.advanceTimersByTime(1000);
    expect(feedback.id).toBe('u1');
    const refused = new CopyFeedback(async () => {
      throw new Error('denied');
    });
    await expect(refused.copy({ id: 'a1', kind: 'assistant', text: 'x' })).rejects.toThrow('denied');
    expect(refused.id).toBe('');
    feedback.dispose();
  });
});
