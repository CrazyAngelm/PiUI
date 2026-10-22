import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsHost } from '../host-api/projectsClient';
import type { Preferences } from '../host-api/types';
import { WorkspaceStore } from './workspaceStore.svelte';

const BASE: Preferences = {
  theme: 'system',
  density: 'comfortable',
  reducedMotion: 'system',
  fontSize: 'medium',
  chatWidth: 'centered',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('WorkspaceStore preferences', () => {
  let store: WorkspaceStore;
  beforeEach(() => {
    store = new WorkspaceStore();
  });
  afterEach(() => {
    store.dispose();
    vi.restoreAllMocks();
  });

  it('keeps the latest choice when an earlier save answers last', async () => {
    const light = deferred<Preferences>();
    const dark = deferred<Preferences>();
    vi.spyOn(projectsHost, 'updatePreferences')
      .mockReturnValueOnce(light.promise)
      .mockReturnValueOnce(dark.promise);

    const first = store.savePreferences({ ...BASE, theme: 'light' });
    const second = store.savePreferences({ ...BASE, theme: 'dark' });
    dark.resolve({ ...BASE, theme: 'dark' });
    await second;
    light.resolve({ ...BASE, theme: 'light' });
    await first;

    expect(store.preferences.theme).toBe('dark');
    expect(store.preferencesBusy).toBe(false);
  });

  it('a superseded save that fails neither rolls back nor reports', async () => {
    const light = deferred<Preferences>();
    const dark = deferred<Preferences>();
    vi.spyOn(projectsHost, 'updatePreferences')
      .mockReturnValueOnce(light.promise)
      .mockReturnValueOnce(dark.promise);

    const first = store.savePreferences({ ...BASE, theme: 'light' });
    const second = store.savePreferences({ ...BASE, theme: 'dark' });
    light.reject(new Error('disk full'));
    await first;
    expect(store.preferences.theme).toBe('dark');
    expect(store.preferencesError).toBeUndefined();
    expect(store.preferencesBusy).toBe(true);

    dark.resolve({ ...BASE, theme: 'dark' });
    await second;
    expect(store.preferences.theme).toBe('dark');
    expect(store.preferencesBusy).toBe(false);
  });

  it('the latest failed save rolls back and reports', async () => {
    vi.spyOn(projectsHost, 'updatePreferences').mockRejectedValueOnce(new Error('disk full'));
    const before = store.preferences;
    await store.savePreferences({ ...before, theme: before.theme === 'dark' ? 'light' : 'dark' });
    expect(store.preferences).toEqual(before);
    expect(store.preferencesError).toBeTruthy();
  });

  it('a bootstrap answer does not undo a save made while it was in flight', async () => {
    const boot = deferred<Awaited<ReturnType<typeof projectsHost.bootstrap>>>();
    vi.spyOn(projectsHost, 'bootstrap').mockReturnValueOnce(boot.promise);
    vi.spyOn(projectsHost, 'updatePreferences').mockResolvedValueOnce({ ...BASE, theme: 'dark' });

    const loading = store.loadPreferences();
    await store.savePreferences({ ...BASE, theme: 'dark' });
    boot.resolve({ preferences: { ...BASE, theme: 'light' }, projects: [] } as unknown as Awaited<
      ReturnType<typeof projectsHost.bootstrap>
    >);
    await loading;
    expect(store.preferences.theme).toBe('dark');
  });
});
