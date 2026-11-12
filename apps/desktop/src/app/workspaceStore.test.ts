import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceHost } from '../host-api/workspaceClient';
import { WorkspaceStore } from './workspaceStore.svelte';
import * as settingsApi from '../host-api/runtimeSettings';
import * as composerApi from '../host-api/composerClient';

// Extension surfaces are their own chunk with their own tests; starting the shell does not need them.
vi.mock('./chat/extensions/extensionSurfaces.svelte', () => ({
  extensionSurfaces: { start: async () => () => undefined },
}));

const ROUTE_KEY = 'piui.shell.route.v1';

/** The WebView's localStorage for the node test environment. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

const restoring = (route: object): void => {
  vi.stubGlobal('localStorage', memoryStorage({ [ROUTE_KEY]: JSON.stringify(route) }));
};

describe('WorkspaceStore start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the first prompt unsent if the harness refuses the requested settings', async () => {
    const store = new WorkspaceStore();
    await store.loadCatalog();
    const session = store.catalog.sessions.find((item) => item.harness === 'codex')!;
    const snapshot = await workspaceHost.request({ type: 'snapshot', sessionId: session.id });
    expect(snapshot.type).toBe('session');
    const original = workspaceHost.request.bind(workspaceHost);
    vi.spyOn(workspaceHost, 'request').mockImplementation(command => command.type === 'createSession' ? Promise.resolve(snapshot) : original(command));
    vi.spyOn(settingsApi, 'runtimeSettings').mockRejectedValueOnce(new Error('The requested reasoning level is unavailable.'));
    const send = vi.spyOn(composerApi, 'composerRequest');
    const message = 'Keep this first prompt until the settings are corrected.';

    const result = await store.createChat({ workspaceId: session.workspaceId, harness: 'codex', permissionMode: 'read-only',
      model: { id: 'selected', name: 'Selected' }, thinkingLevel: 'high', text: message }, { open: false });

    expect(result).toEqual({ sessionId: session.id, error: 'The requested reasoning level is unavailable.' });
    expect(send).not.toHaveBeenCalled();
    expect(store.drafts[session.id]).toBe(message);
    store.dispose();
  });

  it('stops loading and reports the error when the event stream cannot start', async () => {
    vi.spyOn(workspaceHost, 'listen').mockRejectedValueOnce(new Error('The event stream is unavailable.'));
    const store = new WorkspaceStore();
    expect(store.catalogLoading).toBe(true);

    await store.start();

    expect(store.catalogLoading).toBe(false);
    expect(store.catalogError).toBe('The event stream is unavailable.');
    store.dispose();
  });

  it('Retry after a failed start subscribes to the event stream, not only the catalog', async () => {
    const listen = vi.spyOn(workspaceHost, 'listen').mockRejectedValueOnce(new Error('The event stream is unavailable.'));
    const store = new WorkspaceStore();
    await store.start();
    expect(listen).toHaveBeenCalledTimes(1);

    await store.retryCatalog();

    expect(listen).toHaveBeenCalledTimes(2);
    expect(store.catalogError).toBeUndefined();
    await store.retryCatalog();
    expect(listen, 'a live subscription is not opened twice').toHaveBeenCalledTimes(2);
    store.dispose();
  }, 20_000);

  it('checks the restored route against the catalog that loads on Retry', async () => {
    restoring({ name: 'board', workspaceId: 'project-removed-earlier' });
    vi.spyOn(workspaceHost, 'listen').mockRejectedValueOnce(new Error('The event stream is unavailable.'));
    const store = new WorkspaceStore();
    await store.start();
    expect(store.route).toEqual({ name: 'board', workspaceId: 'project-removed-earlier' });

    await store.retryCatalog();

    expect(store.route).toEqual({ name: 'home' });
    store.dispose();
  }, 20_000);

  it.each(['board', 'team', 'history'] as const)('opens home when the restored %s route names a project that is gone', async (name) => {
    restoring({ name, workspaceId: 'project-removed-earlier' });
    const store = new WorkspaceStore();

    await store.start();

    expect(store.route).toEqual({ name: 'home' });
    expect(JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null')).toEqual({ name: 'home' });
    store.dispose();
  });

  it.each(['board', 'team', 'history'] as const)('keeps the restored %s route of a project that still exists', async (name) => {
    const probe = new WorkspaceStore();
    await probe.loadCatalog();
    const workspaceId = probe.catalog.workspaces.find((workspace) => !workspace.personal)?.id ?? '';
    expect(workspaceId).not.toBe('');
    probe.dispose();

    restoring({ name, workspaceId });
    const store = new WorkspaceStore();

    await store.start();

    expect(store.route).toEqual({ name, workspaceId });
    store.dispose();
  });
});
