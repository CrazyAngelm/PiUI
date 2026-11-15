import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NANO_REMOTE_CHANNELS, NANO_REMOTE_COMMANDS } from '../../../../../contracts/nano-remote-v1';

/**
 * Nano Web runs this shell with a transport that refuses every command outside
 * `NANO_REMOTE_COMMANDS`. Here the transport reports `hostRemote: true` and
 * records every call, so a screen that reaches for a refused command fails.
 */
const seen = vi.hoisted(() => ({ commands: [] as string[], channels: [] as string[] }));

vi.mock('../../host-api/transport', () => {
  // The Lab host imports the typed clients, which import this very module: it
  // is loaded on the first call, never while the mock is being created.
  type LabHost = import('../../host-api/transport').HostTransport;
  let host: Promise<LabHost> | undefined;
  const lab = (): Promise<LabHost> => (host ??= import('../../host-api/lab/labHost').then(({ createLabHost }) => createLabHost({ scenario: 'demo', ambient: false })));
  return {
    desktopAvailable: false,
    hostRemote: true,
    hostInvoke: async (command: string, args?: Record<string, unknown>) => {
      seen.commands.push(command);
      return (await lab()).invoke(command, args);
    },
    hostListen: async (channel: string, handler: (payload: never) => void) => {
      seen.channels.push(channel);
      return (await lab()).listen(channel, handler);
    },
  };
});

const { boards } = await import('../board/boardStore.svelte');
const { chatPipelines } = await import('../chatPipelines/chatPipelines.svelte');
const { fusionMembership } = await import('../fusion/fusionMembership.svelte');
const { pluginRegistry } = await import('../plugins/pluginRegistry.svelte');
const { teammates } = await import('../team/teammatesStore.svelte');
const { WorkspaceStore } = await import('../workspaceStore.svelte');
const { placements } = await import('../worktrees/placements.svelte');
const { nanoRemote } = await import('./nanoRemote.svelte');
const { remoteMode, REMOTE_UNAVAILABLE_COPY } = await import('./remoteMode');
const { remoteShell } = await import('./remoteShell.svelte');

const ROUTE_KEY = 'piui.shell.route.v1';
const allowedCommands: readonly string[] = NANO_REMOTE_COMMANDS;
const allowedChannels: readonly string[] = NANO_REMOTE_CHANNELS;

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

const refused = (): { commands: string[]; channels: string[] } => ({
  commands: [...new Set(seen.commands)].filter((command) => !allowedCommands.includes(command)),
  channels: [...new Set(seen.channels)].filter((channel) => !allowedChannels.includes(channel)),
});

async function started(initial: Record<string, string> = {}): Promise<InstanceType<typeof WorkspaceStore>> {
  vi.stubGlobal('localStorage', memoryStorage(initial));
  const store = new WorkspaceStore();
  await store.start();
  // The catalog loads, then every session reconciles in the background.
  for (let turn = 0; turn < 20 && store.catalog.sessions.length === 0; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return store;
}

beforeEach(() => {
  seen.commands.length = 0;
  seen.channels.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the shell in a remote browser', () => {
  it('is told it runs remotely', () => {
    expect(remoteMode).toBe(true);
  });

  it('starts, loads the catalog and opens a chat with allowed commands and channels only', async () => {
    const store = await started();
    expect(store.catalog.sessions.length).toBeGreaterThan(0);
    const chat = store.catalog.sessions.find((session) => !session.runId)!;
    await store.openSession(chat.id);
    expect(store.route).toEqual({ name: 'chat', sessionId: chat.id });
    expect(seen.commands.length).toBeGreaterThan(0);
    expect(refused()).toEqual({ commands: [], channels: [] });
    store.dispose();
  });

  it('starts a chat and sends its first message with allowed commands only', async () => {
    const store = await started();
    const workspace = store.catalog.workspaces.find((item) => !item.personal && !item.missing && item.trust === 'trusted') ?? store.catalog.workspaces.find((item) => !item.missing)!;
    const harness = store.catalog.harnesses.find((item) => item.kind === 'codex' && item.status === 'available') ?? store.catalog.harnesses.find((item) => item.status === 'available')!;
    seen.commands.length = 0;
    const id = await store.startChat({ workspaceId: workspace.id, harness: harness.kind, permissionMode: 'read-only', text: 'Hello from the browser' });
    expect(id).not.toBe('');
    expect(seen.commands).toContain('workspace_command_v15');
    expect(seen.commands).toContain('workspace_composer_v19');
    expect(refused()).toEqual({ commands: [], channels: [] });
    store.dispose();
  });

  it('lands on home for a screen the remote browser does not have', async () => {
    const store = await started();
    store.navigate({ name: 'settings', section: 'general' });
    expect(store.route).toEqual({ name: 'home' });
    store.navigate({ name: 'pipelines', section: 'systems' });
    expect(store.route).toEqual({ name: 'home' });
    store.navigate({ name: 'board', workspaceId: 'any' });
    expect(store.route).toEqual({ name: 'home' });
    store.navigate({ name: 'team', workspaceId: 'any' });
    expect(store.route).toEqual({ name: 'home' });
    store.openRun('any', 'run');
    expect(store.route).toEqual({ name: 'home' });
    for (const route of [{ name: 'inbox' }, { name: 'history', workspaceId: 'any' }] as const) {
      store.navigate(route);
      expect(store.route).toEqual(route);
    }
    store.dispose();
  });

  it('does not restore a screen it has none of', async () => {
    const store = await started({ [ROUTE_KEY]: JSON.stringify({ name: 'settings', section: 'nano' }) });
    expect(store.route).toEqual({ name: 'home' });
    store.dispose();
  });

  it('never writes the desktop preferences, projects or chats', async () => {
    const store = await started();
    seen.commands.length = 0;
    await store.savePreferences({ ...store.preferences, theme: 'dark' });
    await store.addProject();
    expect(store.catalogError).toBe(REMOTE_UNAVAILABLE_COPY);
    const chat = store.catalog.sessions[0]!;
    const workspaceId = chat.workspaceId;
    await expect(store.deleteChat(chat.id)).rejects.toThrow(REMOTE_UNAVAILABLE_COPY);
    await expect(store.trustProject(workspaceId)).rejects.toThrow(REMOTE_UNAVAILABLE_COPY);
    await expect(store.renameProject(workspaceId, 'Renamed')).rejects.toThrow(REMOTE_UNAVAILABLE_COPY);
    await expect(store.setProjectPinned(workspaceId, true)).rejects.toThrow(REMOTE_UNAVAILABLE_COPY);
    await expect(store.removeProject(workspaceId)).rejects.toThrow(REMOTE_UNAVAILABLE_COPY);
    expect(seen.commands).toEqual([]);
    expect(store.catalog.sessions.some((session) => session.id === chat.id)).toBe(true);
    store.dispose();
  });

  it('keeps the desktop-only stores empty without asking the host', async () => {
    const workspaceId = 'ws_any';
    await placements.refresh();
    await fusionMembership.load('session_any');
    fusionMembership.watch();
    await teammates.ensure(workspaceId);
    boards.ensure([workspaceId]);
    await pluginRegistry.start();
    await pluginRegistry.loadContributions();
    await chatPipelines.loadProject(workspaceId);
    expect(await chatPipelines.loadLibrary(workspaceId)).toBeUndefined();
    expect(await chatPipelines.loadChat('session_any')).toBeNull();
    expect(fusionMembership.peek('session_any')).toBeUndefined();
    expect(boards.stores.get(workspaceId)?.board).toBeUndefined();
    expect(seen.commands).toEqual([]);
    expect(seen.channels).toEqual([]);
  });

  it('does not read or follow the desktop remote access state', async () => {
    const stop = nanoRemote.startLater(0);
    const stopShell = remoteShell.loadLater(0);
    await nanoRemote.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    stopShell();
    expect(nanoRemote.loaded).toBe(false);
    expect(remoteShell.Controller).toBeUndefined();
    expect(remoteShell.Indicator).toBeUndefined();
    expect(seen.commands).toEqual([]);
    expect(seen.channels).toEqual([]);
  });
});
