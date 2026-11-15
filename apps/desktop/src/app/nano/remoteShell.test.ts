import { describe, expect, it, vi } from 'vitest';
import { remoteShell } from './remoteShell.svelte';

describe('remote access surfaces in the shell', () => {
  it('holds nothing before first paint and when the load is cancelled', async () => {
    expect(remoteShell.Controller).toBeUndefined();
    expect(remoteShell.Indicator).toBeUndefined();
    remoteShell.loadLater(20)();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(remoteShell.Controller).toBeUndefined();
    expect(remoteShell.Indicator).toBeUndefined();
  });

  it('loads the controller and the indicator once after the delay', async () => {
    const stop = remoteShell.loadLater(0);
    await vi.waitFor(() => expect(remoteShell.Controller !== undefined && remoteShell.Indicator !== undefined).toBe(true));
    const controller = remoteShell.Controller;
    remoteShell.loadLater(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remoteShell.Controller).toBe(controller);
    stop();
  });
});
