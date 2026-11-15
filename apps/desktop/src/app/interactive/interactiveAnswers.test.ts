import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ settings: vi.fn(), update: vi.fn() }));
vi.mock('../../host-api/interactiveAnswersClient', () => ({ interactiveAnswersHost: host }));
beforeEach(() => { vi.resetModules(); host.settings.mockReset(); host.update.mockReset(); });

describe('interactive instruction preference', () => {
  it('loads once and respects a read-only host', async () => {
    host.settings.mockResolvedValue({ protocol: 1, enabled: false, readOnly: true });
    const { interactiveAnswers: store } = await import('./interactiveAnswers.svelte');
    await Promise.all([store.load(), store.load()]);
    expect(host.settings).toHaveBeenCalledOnce();
    expect(store).toMatchObject({ loaded: true, enabled: false, readOnly: true, error: '' });
    await store.set(true);
    expect(host.update).not.toHaveBeenCalled();
  });
  it('changes optimistically, reverts a failed update, and reports fixed error copy', async () => {
    host.settings.mockResolvedValue({ protocol: 1, enabled: true, readOnly: false });
    const { interactiveAnswers: store } = await import('./interactiveAnswers.svelte');
    await store.load();
    let reject!: (cause: Error) => void;
    host.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const changing = store.set(false);
    expect(store.enabled).toBe(false);
    reject(new Error('The setting could not be saved. Nothing was changed.'));
    await changing;
    expect(store.enabled).toBe(true);
    expect(store.error).toBe('The setting could not be saved. Nothing was changed.');
    host.update.mockResolvedValue({ protocol: 1, enabled: false, readOnly: false });
    await store.set(false);
    expect(store).toMatchObject({ enabled: false, error: '' });
  });
  it('leaves the switch unavailable when settings cannot be loaded', async () => {
    host.settings.mockRejectedValue(new Error('The setting could not be saved. Nothing was changed.'));
    const { interactiveAnswers: store } = await import('./interactiveAnswers.svelte');
    await store.load();
    expect(store).toMatchObject({ loaded: true, readOnly: true, error: 'The setting could not be saved. Nothing was changed.' });
  });
});
