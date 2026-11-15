import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../contracts/fixtures/nano-remote-v1.json';
import { labHost } from '../../host-api/lab/labTestKit';
import { LAB_REMOTE_CONNECT_MS, type LabRemoteScenario } from '../../host-api/lab/nanoRemoteFake';
import type { LabNanoScenario } from '../../host-api/lab/nanoAccountFake';
import { createNanoRemoteClient, type NanoRemoteClient, type NanoRemoteStatusV1 } from '../../host-api/nanoRemoteClient';
import { NanoRemote } from './nanoRemote.svelte';

function labClient(remote: LabRemoteScenario, calls: string[] = [], nano: LabNanoScenario = 'signed-in'): NanoRemoteClient {
  const host = labHost('demo', { nano, remote });
  return createNanoRemoteClient(
    (command, args) => {
      calls.push(command);
      return host.invoke(command, args);
    },
    (channel, handler) => {
      calls.push(`listen ${channel}`);
      return host.listen(channel, handler);
    },
  );
}

async function started(remote: LabRemoteScenario, calls: string[] = []): Promise<NanoRemote> {
  const store = new NanoRemote(labClient(remote, calls));
  await store.start();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Nano remote access store', () => {
  it('loads nothing until it is started, then subscribes once and reads the status once', async () => {
    const calls: string[] = [];
    const store = new NanoRemote(labClient('off', calls));
    expect(store.loaded).toBe(false);
    expect(store.pending).toBeUndefined();
    expect(store.viewers).toEqual([]);
    expect(calls).toEqual([]);
    await store.start();
    await store.start();
    // Subscribed first, so an event published while the status is read is not lost.
    expect(calls).toEqual(['listen piui://nano-remote-v1', 'nano_remote_status_v1']);
    expect(store.status?.enabled).toBe(false);
  });

  it('starts after first paint, and the cancellation keeps it from starting', async () => {
    const calls: string[] = [];
    const store = new NanoRemote(labClient('off', calls));
    const stop = store.startLater(300);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(store.loaded).toBe(true);
    const never = new NanoRemote(labClient('off', calls));
    never.startLater(300)();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(never.loaded).toBe(false);
    stop();
  });

  it('shows the waiting browser and the connected ones', async () => {
    const waiting = await started('pending');
    expect(waiting.pending?.code).toBe('908621');
    const connected = await started('viewer');
    expect(connected.viewers.map((viewer) => viewer.label)).toEqual(['Chrome · Android']);
    expect(connected.pending).toBeUndefined();
  });

  it('follows the host: a decision updates the status and the event does not undo it', async () => {
    const store = await started('pending');
    expect(await store.decide('req_synthetic01', 'once')).toBe(true);
    expect(store.pending).toBeUndefined();
    expect(store.viewers[0]?.grant).toBe('once');
    await vi.advanceTimersByTimeAsync(10);
    expect(store.viewers).toHaveLength(1);
    expect(store.action).toBeUndefined();
  });

  it('turns the switch on and off and follows the connection', async () => {
    const store = await started('off');
    expect(await store.setEnabled(true)).toBe(true);
    expect(store.status?.link).toBe('connecting');
    await vi.advanceTimersByTimeAsync(LAB_REMOTE_CONNECT_MS + 10);
    expect(store.status?.link).toBe('online');
    expect(await store.setEnabled(false)).toBe(true);
    expect(store.status?.link).toBe('off');
  });

  it('disconnects a browser and forgets a remembered one', async () => {
    const store = await started('viewer');
    expect(await store.kick('vw_synthetic0000000000001')).toBe(true);
    expect(store.viewers).toEqual([]);
    expect(store.status?.browsers).toHaveLength(1);
    expect(await store.forget('br_synthetic01')).toBe(true);
    expect(store.status?.browsers).toEqual([]);
  });

  it('keeps the failure as fixed English copy and lets the next action clear it', async () => {
    const store = await started('pending');
    expect(await store.decide('req_missing', 'deny')).toBe(false);
    expect(store.error).toBe('That request or browser is no longer available.');
    expect(store.action).toBeUndefined();
    expect(await store.decide('req_synthetic01', 'deny')).toBe(true);
    expect(store.error).toBeUndefined();
    const unsupported = await started('unsupported');
    expect(await unsupported.setEnabled(true)).toBe(false);
    expect(unsupported.error).toBe('This Nano server does not support remote access yet.');
    unsupported.clearError();
    expect(unsupported.error).toBeUndefined();
  });

  it('runs one action at a time', async () => {
    const store = await started('viewer');
    const first = store.kick('vw_synthetic0000000000001');
    expect(store.action).toBe('kick');
    expect(await store.forget('br_synthetic01')).toBe(false);
    expect(await first).toBe(true);
    expect(store.status?.browsers).toHaveLength(1);
  });

  it('keeps the newest status: an older revision never replaces a newer one', () => {
    const store = new NanoRemote(labClient('off'));
    const newer: NanoRemoteStatusV1 = { ...(fixture.statusViewer as NanoRemoteStatusV1), revision: 9 };
    store.apply({ type: 'status', status: newer });
    store.apply({ type: 'status', status: { ...(fixture.statusOff as NanoRemoteStatusV1), revision: 3 } });
    expect(store.status?.revision).toBe(9);
    store.apply({ type: 'status', status: { ...(fixture.statusOff as NanoRemoteStatusV1), revision: 9 } });
    expect(store.status?.enabled).toBe(false);
  });

  it('reports a failed start and can be started again', async () => {
    let fail = true;
    const client = createNanoRemoteClient(
      async <T>() => {
        if (fail) throw { code: 'io' };
        return fixture.statusOff as T;
      },
      async () => () => undefined,
    );
    const store = new NanoRemote(client);
    await store.start();
    expect(store.loaded).toBe(false);
    expect(store.error).toBe('Nano Desktop could not save the remote access settings.');
    fail = false;
    await store.start();
    expect(store.loaded).toBe(true);
  });

  it('does nothing after it is disposed', async () => {
    const store = await started('off');
    store.dispose();
    const calls: string[] = [];
    const late = new NanoRemote(labClient('off', calls));
    late.dispose();
    await late.start();
    expect(calls).toEqual(['listen piui://nano-remote-v1']);
    expect(late.loaded).toBe(false);
  });
});
