import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-remote-v1.json';
import type { RemoteLink } from './connection';
import * as transport from './transport';
import { desktopAvailable, hostInvoke, hostListen, hostRemote, installRemoteConnection } from './transport';

type Handler = (channel: string, payload: unknown) => void;

function fakeLink(commands: readonly string[] = fixture.commands, channels: readonly string[] = fixture.channels) {
  const handlers = new Set<Handler>();
  const request = vi.fn(async (_command: string, _args: Record<string, unknown>): Promise<unknown> => ({ answered: true }));
  const link: RemoteLink & { emit: Handler; handlers: Set<Handler> } = {
    commands,
    channels,
    request,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit: (channel, payload) => handlers.forEach((handler) => handler(channel, payload)),
    handlers,
  };
  return { link, request };
}

afterEach(() => installRemoteConnection(undefined));

describe('module surface', () => {
  it('exports what the shell imports from the desktop transport, and the installer', () => {
    expect(Object.keys(transport).sort()).toEqual(['desktopAvailable', 'hostInvoke', 'hostListen', 'hostRemote', 'installRemoteConnection']);
    expect(desktopAvailable).toBe(true);
    expect(hostRemote).toBe(true);
  });
});

describe('hostInvoke', () => {
  it('refuses while no session is installed', async () => {
    await expect(hostInvoke('bootstrap_v10')).rejects.toEqual({ code: 'remote-not-connected' });
  });

  it('forwards an advertised command with its arguments, and an empty object when there are none', async () => {
    const { link, request } = fakeLink();
    installRemoteConnection(link);
    await expect(hostInvoke('workspace_command_v15', { command: { type: 'catalog' } })).resolves.toEqual({ answered: true });
    await hostInvoke('bootstrap_v10');
    expect(request.mock.calls).toEqual([
      ['workspace_command_v15', { command: { type: 'catalog' } }],
      ['bootstrap_v10', {}],
    ]);
  });

  it('refuses a command the welcome did not advertise, without calling the session', async () => {
    const { link, request } = fakeLink(['bootstrap_v10']);
    installRemoteConnection(link);
    for (const command of fixture.refusedExamples) await expect(hostInvoke(command, {})).rejects.toEqual({ code: 'remote-not-allowed' });
    await expect(hostInvoke('workspace_history_v1', {})).rejects.toEqual({ code: 'remote-not-allowed' });
    expect(request).not.toHaveBeenCalled();
  });

  it('passes the host error through unchanged', async () => {
    const { link, request } = fakeLink();
    request.mockRejectedValueOnce({ code: 'remote-busy' });
    installRemoteConnection(link);
    await expect(hostInvoke('bootstrap_v10')).rejects.toEqual({ code: 'remote-busy' });
  });

  it('stops answering once the session is removed', async () => {
    const { link } = fakeLink();
    installRemoteConnection(link);
    installRemoteConnection(undefined);
    await expect(hostInvoke('bootstrap_v10')).rejects.toEqual({ code: 'remote-not-connected' });
  });
});

describe('hostListen', () => {
  it('delivers events of advertised channels and stops after unlisten', async () => {
    const { link } = fakeLink();
    installRemoteConnection(link);
    const first = vi.fn();
    const second = vi.fn();
    const stop = await hostListen('piui://workspace-event', first);
    await hostListen('piui://workspace-event', second);
    link.emit('piui://workspace-event', { type: 'text-delta' });
    expect(first).toHaveBeenCalledWith({ type: 'text-delta' });
    expect(second).toHaveBeenCalledWith({ type: 'text-delta' });
    stop();
    link.emit('piui://workspace-event', { type: 'again' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps separate registrations when one handler is registered twice', async () => {
    const { link } = fakeLink();
    installRemoteConnection(link);
    const handler = vi.fn();
    const stopFirst = await hostListen('piui://composer-v19', handler);
    await hostListen('piui://composer-v19', handler);
    stopFirst();
    link.emit('piui://composer-v19', 1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never fires for a channel outside the welcome, even when the session emits it', async () => {
    const { link } = fakeLink(fixture.commands, ['piui://workspace-event']);
    installRemoteConnection(link);
    const handler = vi.fn();
    await hostListen('piui://composer-v19', handler);
    link.emit('piui://composer-v19', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener', async () => {
    const { link } = fakeLink();
    installRemoteConnection(link);
    const after = vi.fn();
    await hostListen('piui://session-catalog', () => {
      throw new Error('listener bug');
    });
    await hostListen('piui://session-catalog', after);
    expect(() => link.emit('piui://session-catalog', 1)).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
  });

  it('follows the installed session: the old one is unsubscribed, a listener registered earlier keeps working', async () => {
    const handler = vi.fn();
    await hostListen('piui://workspace-event', handler);
    const first = fakeLink();
    installRemoteConnection(first.link);
    const second = fakeLink();
    installRemoteConnection(second.link);
    expect(first.link.handlers.size).toBe(0);
    first.link.emit('piui://workspace-event', 'old');
    second.link.emit('piui://workspace-event', 'new');
    expect(handler.mock.calls).toEqual([['new']]);
    installRemoteConnection(undefined);
    expect(second.link.handlers.size).toBe(0);
  });
});
