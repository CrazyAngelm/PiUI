import { describe, expect, it, vi } from 'vitest';
import { LazyPanel } from './lazyPanel.svelte';

describe('deferred picker panel', () => {
  it('does not fetch while closed, shares a pending open and reuses the loaded panel', async () => {
    let resolve!: (value: { default: object }) => void;
    const importer = vi.fn(() => new Promise<{ default: object }>((done) => { resolve = done; }));
    const panel = new LazyPanel(importer);
    expect(importer).not.toHaveBeenCalled();
    const firstOpen = panel.load();
    expect(panel.load()).toBe(firstOpen);
    const component = {};
    resolve({ default: component });
    await firstOpen;
    await panel.load();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(panel.component).toBe(component);
  });

  it('keeps a failed load retryable without retrying automatically', async () => {
    const component = {};
    const importer = vi.fn<() => Promise<{ default: object }>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: component });
    const panel = new LazyPanel(importer);
    await panel.load();
    expect(panel.failed).toBe(true);
    expect(panel.component).toBeUndefined();
    expect(importer).toHaveBeenCalledTimes(1);
    await panel.load();
    expect(panel.failed).toBe(false);
    expect(panel.component).toBe(component);
  });
});
