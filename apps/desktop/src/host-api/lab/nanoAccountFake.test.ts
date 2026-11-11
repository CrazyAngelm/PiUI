import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NANO_ACCOUNT_EVENT_V1, createNanoAccountClient, decodeNanoAccountStatus, type NanoAccountClient, type NanoAccountEventV1, type NanoAccountStatusV1 } from '../nanoAccountClient';
import {
  LAB_NANO_DICTATION_TEXT,
  LAB_NANO_SCENARIOS,
  LAB_NANO_SIGN_IN_MS,
  labNanoLaunchReady,
  labNanoOpenModes,
  nanoScenarioFromSearch,
  type LabNanoScenario,
} from './nanoAccountFake';
import { labHost } from './labTestKit';
import type { LabScenarioName } from './labState';

function labClient(
  nano: LabNanoScenario | undefined,
  scenario: LabScenarioName = 'demo',
): { client: NanoAccountClient; events: NanoAccountEventV1[]; invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } {
  const host = labHost(scenario, nano === undefined ? {} : { nano });
  const events: NanoAccountEventV1[] = [];
  const client = createNanoAccountClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler));
  void client.subscribe((event) => events.push(event));
  return { client, events, invoke: (command, args) => host.invoke(command, args) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Nano account in the UI Lab', () => {
  it('reads the scenario from the URL and defaults to signed out', () => {
    expect(nanoScenarioFromSearch('')).toBe('signed-out');
    expect(nanoScenarioFromSearch('?nano=bogus')).toBe('signed-out');
    for (const name of LAB_NANO_SCENARIOS) expect(nanoScenarioFromSearch(`?lab=demo&nano=${name}`)).toBe(name);
  });

  it('answers a contract-valid status in every scenario', async () => {
    for (const name of LAB_NANO_SCENARIOS) {
      const { client } = labClient(name);
      const status = await client.status();
      expect(decodeNanoAccountStatus(status), name).toEqual(status);
    }
    const defaults = await labClient(undefined).client.status();
    expect(defaults.state).toBe('signed-out');
    expect(defaults.server.development).toBe(false);
  });

  it('shapes each scenario like the fixtures do', async () => {
    const free = await labClient('free').client.status();
    expect(free.entitlements?.plan.kind).toBe('free');
    expect(free.entitlements?.modes.filter((mode) => !mode.available).map((mode) => [mode.id, mode.lockedReason])).toEqual([['fast', 'plan'], ['smart', 'plan']]);
    const exhausted = await labClient('exhausted').client.status();
    expect(exhausted.entitlements?.credits.balance).toBe(0);
    expect(exhausted.entitlements?.modes.filter((mode) => mode.available).map((mode) => mode.id)).toEqual(['free']);
    const expired = await labClient('expired').client.status();
    expect([expired.state, expired.lastError, expired.user?.displayName]).toEqual(['expired', 'device-revoked', 'Synthetic Person']);
    const unsupported = await labClient('unsupported').client.status();
    expect([unsupported.state, unsupported.server.development, unsupported.lastError]).toEqual(['unsupported', true, 'unsupported-server']);
    const offline = await labClient('offline').client.status();
    expect([offline.state, offline.lastError, offline.credentialStore]).toEqual(['offline', 'offline', 'os']);
  });

  it('signs in after about a second and publishes both states', async () => {
    const { client, events } = labClient('signed-out');
    const waiting = await client.signIn();
    expect([waiting.state, waiting.busy]).toEqual(['signing-in', true]);
    await expect(client.signIn()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    const status = await client.status();
    expect([status.state, status.busy, status.user?.displayName, status.credentialStore]).toEqual(['signed-in', false, 'Synthetic Person', 'os']);
    expect(status.entitlements?.workspaceId).toBe(status.selectedWorkspaceId);
    expect(events.map((event) => event.status.state)).toEqual(['signing-in', 'signed-in']);
    expect(events[1]!.status.revision).toBeGreaterThan(events[0]!.status.revision);
  });

  it('cancels a sign-in that is still waiting', async () => {
    const { client, events } = labClient('signed-out');
    await client.signIn();
    const cancelled = await client.cancelSignIn();
    expect([cancelled.state, cancelled.busy, cancelled.lastError]).toEqual(['signed-out', false, null]);
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS * 2);
    expect((await client.status()).state).toBe('signed-out');
    expect(events.map((event) => event.status.state)).toEqual(['signing-in', 'signed-out']);
  });

  it('keeps the scenario flavour when signing in again', async () => {
    const { client } = labClient('expired');
    await client.signIn();
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect((await client.status()).state).toBe('signed-in');
    const free = labClient('free').client;
    await free.signOut();
    await free.signIn();
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect((await free.status()).entitlements?.plan.kind).toBe('free');
  });

  it('signs out to an empty status and refuses what needs a sign-in', async () => {
    const { client } = labClient('signed-in');
    const out = await client.signOut();
    expect([out.state, out.user, out.entitlements, out.credentialStore, out.workspaces]).toEqual(['signed-out', null, null, null, []]);
    await expect(client.refresh()).rejects.toMatchObject({ code: 'sign-in-required' });
    await expect(client.openCloud()).rejects.toMatchObject({ code: 'sign-in-required' });
    await expect(client.openLink('billing')).rejects.toMatchObject({ code: 'sign-in-required' });
    await expect(client.openLink('signup')).resolves.toMatchObject({ state: 'signed-out' });
    await expect(client.dictate({ audioBase64: 'AA==', mimeType: 'audio/webm' })).rejects.toMatchObject({ code: 'sign-in-required' });
  });

  it('switches workspace with its own entitlements and refuses an unknown one', async () => {
    const { client, events } = labClient('signed-in');
    const team = await client.selectWorkspace('ws_synthetic02');
    expect(team.selectedWorkspaceId).toBe('ws_synthetic02');
    expect(team.entitlements?.workspaceId).toBe('ws_synthetic02');
    expect(team.entitlements?.plan.name).toBe('Team');
    await vi.advanceTimersByTimeAsync(5);
    expect(events.at(-1)?.status.selectedWorkspaceId).toBe('ws_synthetic02');
    await expect(client.selectWorkspace('ws_missing')).rejects.toMatchObject({ code: 'workspace-not-found' });
  });

  it('answers the failure states of expired, unsupported and offline accounts', async () => {
    await expect(labClient('expired').client.refresh()).rejects.toMatchObject({ code: 'device-revoked' });
    await expect(labClient('unsupported').client.signIn()).rejects.toMatchObject({ code: 'unsupported-server' });
    await expect(labClient('offline').client.refresh()).rejects.toMatchObject({ code: 'offline' });
    await expect(labClient('offline').client.signIn()).rejects.toMatchObject({ code: 'offline' });
  });

  it('dictates fixed synthetic text, gated by capability, feature and credits', async () => {
    const paid = labClient('signed-in').client;
    const answer = paid.dictate({ audioBase64: 'AAEC', mimeType: 'audio/webm;codecs=opus' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(answer).resolves.toEqual({ text: LAB_NANO_DICTATION_TEXT });
    await expect(labClient('free').client.dictate({ audioBase64: 'AAEC', mimeType: 'audio/webm' })).rejects.toMatchObject({ code: 'feature-unavailable' });
    await expect(labClient('exhausted').client.dictate({ audioBase64: 'AAEC', mimeType: 'audio/webm' })).rejects.toMatchObject({ code: 'credits-exhausted' });
    const { invoke } = labClient('signed-in');
    await expect(invoke('nano_dictation_v1', { request: { audioBase64: 'AA' } })).rejects.toBeTruthy();
  });

  it('opens the cloud as a no-op when the plan includes it and refuses otherwise', async () => {
    await expect(labClient('signed-in').client.openCloud()).resolves.toBeUndefined();
    await expect(labClient('free').client.openCloud()).rejects.toMatchObject({ code: 'feature-unavailable' });
  });

  it('behaves like the host in safe mode: signed out, only the local sign-out works', async () => {
    // Whatever the scenario stores, safe mode restores nothing.
    for (const name of ['signed-in', 'expired', 'offline'] as const) {
      expect((await labClient(name, 'safe').client.status()).state, name).toBe('signed-out');
    }
    const { client, events, invoke } = labClient('signed-in', 'safe');
    const refused = [
      () => client.signIn(),
      () => client.cancelSignIn(),
      () => client.refresh(),
      () => client.selectWorkspace('ws_synthetic01'),
      () => client.openLink('signup'),
      () => client.openLink('billing'),
      () => client.openLink('devices'),
      () => client.openCloud(),
      () => client.dictate({ audioBase64: 'AAEC', mimeType: 'audio/webm' }),
    ];
    for (const call of refused) await expect(call()).rejects.toMatchObject({ code: 'safe-mode' });
    // The host's own error shape: a rejected `{ code }`, before any state change.
    await expect(invoke('nano_account_sign_in_v1')).rejects.toEqual({ code: 'safe-mode' });
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS * 2);
    expect((await client.status()).state).toBe('signed-out');
    expect(events).toEqual([]);
    // Malformed requests are still argument errors first, as Tauri decodes before the command runs.
    const malformed = await invoke('nano_account_open_link_v1', { request: { link: 'elsewhere' } }).then(() => undefined, (error: unknown) => error);
    expect(malformed).toBeTruthy();
    expect(malformed).not.toEqual({ code: 'safe-mode' });
    // The local sign-out makes no network call and still answers.
    const out = await client.signOut();
    expect([out.state, out.user, out.entitlements, out.credentialStore]).toEqual(['signed-out', null, null, null]);
    await vi.advanceTimersByTimeAsync(5);
    expect(events.map((event) => event.status.state)).toEqual(['signed-out']);
  });

  it('keeps the account out of safe mode unrestricted', async () => {
    const { client } = labClient('signed-out', 'demo');
    await expect(client.signIn()).resolves.toMatchObject({ state: 'signing-in' });
  });

  it('lists the open modes and the launch gate like the host', async () => {
    const statusOf = (name: LabNanoScenario): Promise<NanoAccountStatusV1> => labClient(name).client.status();
    expect(labNanoOpenModes(await statusOf('signed-in')).map((mode) => mode.id)).toEqual(['auto', 'free', 'fast', 'smart']);
    expect(labNanoOpenModes(await statusOf('free')).map((mode) => mode.id)).toEqual(['auto', 'free']);
    expect(labNanoOpenModes(await statusOf('exhausted')).map((mode) => mode.id)).toEqual(['free']);
    for (const name of ['signed-out', 'expired', 'unsupported', 'offline'] as const) {
      const status = await statusOf(name);
      expect(labNanoOpenModes(status), name).toEqual([]);
      expect(labNanoLaunchReady(status), name).toBe(false);
    }
    const paid = await statusOf('signed-in');
    for (const name of ['signed-in', 'free', 'exhausted'] as const) expect(labNanoLaunchReady(await statusOf(name)), name).toBe(true);
    const entitlements = paid.entitlements as NonNullable<NanoAccountStatusV1['entitlements']>;
    expect(labNanoLaunchReady({ ...paid, selectedWorkspaceId: null })).toBe(false);
    expect(labNanoLaunchReady({ ...paid, capabilities: null })).toBe(false);
    expect(labNanoLaunchReady({ ...paid, entitlements: null })).toBe(false);
    expect(labNanoLaunchReady({ ...paid, entitlements: { ...entitlements, features: { ...entitlements.features, localAgent: false } } })).toBe(false);
    expect(labNanoLaunchReady({ ...paid, entitlements: { ...entitlements, modes: entitlements.modes.map((mode) => ({ ...mode, available: false, lockedReason: 'plan' as const })) } })).toBe(false);
  });

  it('rejects malformed requests as the host does', async () => {
    const { invoke } = labClient('signed-in');
    await expect(invoke('nano_account_open_link_v1', { request: { link: 'elsewhere' } })).rejects.toBeTruthy();
    await expect(invoke('nano_account_select_workspace_v1', { request: { workspaceId: 'ws_synthetic01', extra: 1 } })).rejects.toBeTruthy();
    await expect(invoke('nano_account_select_workspace_v1', {})).rejects.toBeTruthy();
    expect(NANO_ACCOUNT_EVENT_V1).toBe('piui://nano-account-v1');
  });
});
