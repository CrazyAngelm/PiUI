import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../contracts/fixtures/nano-remote-v1.json';
import { createNanoRemoteClient, decodeNanoRemoteStatus, type NanoRemoteClient, type NanoRemoteEventV1 } from '../nanoRemoteClient';
import { labHost } from './labTestKit';
import type { LabNanoScenario } from './nanoAccountFake';
import { LAB_REMOTE_CONNECT_MS, LAB_REMOTE_SCENARIOS, remoteScenarioFromSearch, type LabRemoteScenario } from './nanoRemoteFake';
import type { LabScenarioName } from './labState';

function labClient(
  remote: LabRemoteScenario | undefined,
  nano: LabNanoScenario = 'signed-in',
  scenario: LabScenarioName = 'demo',
): { client: NanoRemoteClient; events: NanoRemoteEventV1[]; invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } {
  const host = labHost(scenario, { nano, ...(remote === undefined ? {} : { remote }) });
  const events: NanoRemoteEventV1[] = [];
  const client = createNanoRemoteClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler));
  void client.listen((event) => events.push(event));
  return { client, events, invoke: (command, args) => host.invoke(command, args) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Nano remote access in the UI Lab', () => {
  it('reads the scenario from the URL and defaults to off', () => {
    expect(remoteScenarioFromSearch('')).toBe('off');
    expect(remoteScenarioFromSearch('?remote=bogus')).toBe('off');
    for (const name of LAB_REMOTE_SCENARIOS) expect(remoteScenarioFromSearch(`?lab=demo&remote=${name}`)).toBe(name);
  });

  it('answers a contract-valid status in every scenario', async () => {
    for (const name of LAB_REMOTE_SCENARIOS) {
      const status = await labClient(name).client.status();
      expect(decodeNanoRemoteStatus(status), name).toEqual(status);
    }
    const defaults = await labClient(undefined).client.status();
    expect([defaults.enabled, defaults.link, defaults.unavailable]).toEqual([false, 'off', null]);
  });

  it('shapes each scenario like the fixtures do', async () => {
    const off = await labClient('off').client.status();
    expect({ ...off, revision: 1 }).toEqual(fixture.statusOff);
    const on = await labClient('on').client.status();
    expect([on.enabled, on.link, on.viewers.length, on.pending]).toEqual([true, 'online', 0, null]);
    const pending = await labClient('pending').client.status();
    expect(pending.pending).toMatchObject({ requestId: 'req_synthetic01', label: 'Chrome · Android', code: '908621', fingerprint: '0ed3a6ab957ff6f5' });
    const viewer = await labClient('viewer').client.status();
    expect(viewer.viewers).toEqual(fixture.statusViewer.viewers);
    expect(viewer.browsers).toEqual(fixture.statusViewer.browsers);
    const unsupported = await labClient('unsupported').client.status();
    expect([unsupported.unavailable, unsupported.enabled, unsupported.link]).toEqual(['unsupported-server', false, 'off']);
  });

  it('turns on through connecting to online, and off at once, publishing each state', async () => {
    const { client, events } = labClient('off');
    const connecting = await client.setEnabled(true);
    expect([connecting.enabled, connecting.link]).toEqual([true, 'connecting']);
    await vi.advanceTimersByTimeAsync(LAB_REMOTE_CONNECT_MS + 10);
    expect((await client.status()).link).toBe('online');
    const off = await client.setEnabled(false);
    expect([off.enabled, off.link]).toEqual([false, 'off']);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((event) => event.status.link)).toEqual(['connecting', 'online', 'off']);
    expect(events[2]!.status.revision).toBeGreaterThan(events[0]!.status.revision);
    // Turning on twice is harmless.
    await client.setEnabled(true);
    expect((await client.setEnabled(true)).link).toBe('connecting');
  });

  it('turning off drops the connected browsers and the waiting request but keeps the remembered ones', async () => {
    const { client } = labClient('viewer');
    const off = await client.setEnabled(false);
    expect([off.viewers, off.pending, off.browsers.length]).toEqual([[], null, 1]);
    const pending = labClient('pending').client;
    expect((await pending.setEnabled(false)).pending).toBeNull();
  });

  it('refuses to turn on when the account or the server cannot', async () => {
    await expect(labClient('off', 'signed-out').client.setEnabled(true)).rejects.toMatchObject({ code: 'sign-in-required' });
    await expect(labClient('unsupported').client.setEnabled(true)).rejects.toMatchObject({ code: 'unsupported-server' });
    const signedOut = await labClient('on', 'signed-out').client.status();
    expect([signedOut.unavailable, signedOut.link, signedOut.viewers, signedOut.pending]).toEqual(['signed-out', 'off', [], null]);
    const free = await labClient('off', 'free').client.status();
    expect(free.unavailable).toBeNull();
  });

  it('behaves like the host in safe mode: no link, every command refused but the status and turning off', async () => {
    const { client } = labClient('pending', 'signed-in', 'safe');
    const status = await client.status();
    expect(status).toMatchObject({ unavailable: 'safe-mode', enabled: false, link: 'off', pending: null });
    expect({ ...status, revision: 1 }).toEqual(fixture.statusSafeMode);
    await expect(client.setEnabled(true)).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(client.decide('req_synthetic01', 'once')).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(client.kick('vw_synthetic0000000000001')).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(client.forget('br_synthetic01')).rejects.toMatchObject({ code: 'safe-mode' });
    expect((await client.setEnabled(false)).unavailable).toBe('safe-mode');
  });

  it('decides a waiting browser: deny, allow once and always allow', async () => {
    const denied = labClient('pending');
    const afterDeny = await denied.client.decide('req_synthetic01', 'deny');
    expect([afterDeny.pending, afterDeny.viewers, afterDeny.browsers]).toEqual([null, [], []]);
    await expect(denied.client.decide('req_synthetic01', 'once')).rejects.toMatchObject({ code: 'not-found' });

    const once = labClient('pending');
    const afterOnce = await once.client.decide('req_synthetic01', 'once');
    expect(afterOnce.pending).toBeNull();
    expect(afterOnce.viewers).toMatchObject([{ label: 'Chrome · Android', grant: 'once', fingerprint: '0ed3a6ab957ff6f5' }]);
    expect(afterOnce.browsers).toEqual([]);

    const always = labClient('pending');
    await expect(always.client.decide('req_other', 'always')).rejects.toMatchObject({ code: 'not-found' });
    const afterAlways = await always.client.decide('req_synthetic01', 'always');
    expect(afterAlways.viewers).toMatchObject([{ grant: 'always' }]);
    expect(afterAlways.browsers).toMatchObject([{ label: 'Chrome · Android', fingerprint: '0ed3a6ab957ff6f5' }]);
    expect(decodeNanoRemoteStatus(afterAlways)).toEqual(afterAlways);
  });

  it('disconnects a browser and forgets a remembered one with its connection', async () => {
    const kicked = labClient('viewer');
    await expect(kicked.client.kick('vw_missing')).rejects.toMatchObject({ code: 'not-found' });
    const afterKick = await kicked.client.kick('vw_synthetic0000000000001');
    expect([afterKick.viewers, afterKick.browsers.length]).toEqual([[], 1]);

    const forgotten = labClient('viewer');
    await expect(forgotten.client.forget('br_missing')).rejects.toMatchObject({ code: 'not-found' });
    const afterForget = await forgotten.client.forget('br_synthetic01');
    expect([afterForget.viewers, afterForget.browsers]).toEqual([[], []]);
  });

  it('follows the account: signing out makes the switch unavailable and publishes it', async () => {
    const { client, events, invoke } = labClient('viewer');
    await vi.advanceTimersByTimeAsync(10);
    events.length = 0;
    await invoke('nano_account_sign_out_v1');
    await vi.advanceTimersByTimeAsync(10);
    const last = events.at(-1)?.status;
    expect(last).toMatchObject({ unavailable: 'signed-out', link: 'off', viewers: [], browsers: [] });
    expect(await client.status()).toEqual(last);
  });

  it('rejects arguments the host would refuse', async () => {
    const { invoke } = labClient('pending');
    await expect(invoke('nano_remote_set_enabled_v1', { request: { enabled: true, extra: 1 } })).rejects.toBeDefined();
    await expect(invoke('nano_remote_decide_v1', { request: { requestId: 'req_synthetic01', decision: 'maybe' } })).rejects.toBeDefined();
    await expect(invoke('nano_remote_kick_v1', {})).rejects.toBeDefined();
  });
});
