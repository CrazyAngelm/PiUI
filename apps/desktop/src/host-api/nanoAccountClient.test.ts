import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-account-v1.json';
import {
  NANO_ACCOUNT_ERROR_COPY,
  NANO_ACCOUNT_EVENT_V1,
  NanoAccountOperationError,
  createNanoAccountClient,
  decodeNanoAccountEvent,
  decodeNanoAccountStatus,
  decodeNanoDictation,
  nanoAccountError,
  type NanoAccountEventV1,
} from './nanoAccountClient';

const STATUS_KEYS = ['signedOut', 'signingIn', 'signedIn', 'expired', 'unsupported'] as const;

describe('Nano account v1 client', () => {
  it('accepts every status in the public fixture', () => {
    for (const key of STATUS_KEYS) {
      expect(decodeNanoAccountStatus(fixture[key]), key).toEqual(fixture[key]);
    }
    expect(decodeNanoAccountEvent({ type: 'status', status: fixture.signedIn })).toEqual({ type: 'status', status: fixture.signedIn });
  });

  it('refuses statuses outside the contract', () => {
    const base = fixture.signedIn;
    const entitlements = base.entitlements;
    const broken: unknown[] = [
      null,
      'signed-in',
      [],
      { ...base, protocol: 2 },
      { ...base, revision: -1 },
      { ...base, revision: 1.5 },
      { ...base, state: 'paused' },
      { ...base, server: { origin: 'https://nanoagents.ru' } },
      { ...base, server: { origin: 7, development: false } },
      { ...base, user: { displayName: 3, email: null } },
      { ...base, user: { displayName: 'A' } },
      { ...base, device: { id: 'd' } },
      { ...base, workspaces: [{ id: 'w', name: 'W', role: 'root' }] },
      { ...base, workspaces: 'none' },
      { ...base, selectedWorkspaceId: 4 },
      { ...base, capabilities: { gateway: true } },
      { ...base, capabilities: { ...base.capabilities, voice: 'yes' } },
      { ...base, credentialStore: 'file' },
      { ...base, busy: 'no' },
      { ...base, lastError: 'disk-full' },
      { ...base, usage: { workspaceId: 'w' } },
      { ...base, entitlements: { ...entitlements, plan: { ...entitlements.plan, kind: 'gold' } } },
      { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, balance: 'many' } } },
      { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, balance: 1.5 } } },
      { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, balance: Number.NaN } } },
      { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, included: 2 ** 60 } } },
      { ...base, entitlements: { ...entitlements, limits: { ...entitlements.limits, maxRequestBytes: -1 } } },
      { ...base, entitlements: { ...entitlements, features: { localAgent: true } } },
      { ...base, entitlements: { ...entitlements, limits: { ...entitlements.limits, dictationMaxBytes: null } } },
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[0], id: 'turbo' }] } },
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[0], tier: 'gold' }] } },
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[0], input: ['audio'] }] } },
      // `lockedReason` is set exactly when the mode is unavailable.
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[0], lockedReason: 'plan' }] } },
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[3], lockedReason: null }] } },
      { ...base, entitlements: { ...entitlements, modes: [{ ...entitlements.modes[3], lockedReason: 'rich' }] } },
    ];
    for (const value of broken) {
      expect(decodeNanoAccountStatus(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
    }
    expect(decodeNanoAccountEvent({ type: 'progress', status: base })).toBeUndefined();
    expect(decodeNanoAccountEvent({ type: 'status', status: { ...base, protocol: 0 } })).toBeUndefined();
    expect(decodeNanoAccountEvent(null)).toBeUndefined();
  });

  it('accepts a negative credit balance: credits are signed in the host', () => {
    const base = fixture.signedIn;
    const entitlements = base.entitlements;
    const overdrawn = { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, balance: -5, included: null } } };
    expect(decodeNanoAccountStatus(overdrawn)).toEqual(overdrawn);
    const owing = { ...base, entitlements: { ...entitlements, credits: { ...entitlements.credits, balance: -120 } } };
    expect(decodeNanoAccountStatus(owing)).toEqual(owing);
    expect(decodeNanoAccountEvent({ type: 'status', status: overdrawn })).toEqual({ type: 'status', status: overdrawn });

    // Usage rows carry the same signed credits; request counts and revisions stay non-negative.
    const usage = { workspaceId: 'ws_synthetic01', periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', creditsUsed: 25005, creditsRemaining: -5, byMode: [{ mode: 'smart', credits: -2, requests: 3 }] };
    expect(decodeNanoAccountStatus({ ...base, usage })).toEqual({ ...base, usage });
    expect(decodeNanoAccountStatus({ ...base, usage: { ...usage, byMode: [{ mode: 'smart', credits: 2, requests: -3 }] } })).toBeUndefined();
    expect(decodeNanoAccountStatus({ ...base, usage: { ...usage, creditsUsed: 1.5 } })).toBeUndefined();
  });

  it('maps host refusals to fixed copy and never forwards host details', () => {
    for (const code of Object.keys(NANO_ACCOUNT_ERROR_COPY)) {
      const error = nanoAccountError({ code, message: 'C:/secret/path and token abc' });
      expect(error).toBeInstanceOf(NanoAccountOperationError);
      expect(error.message).toBe(NANO_ACCOUNT_ERROR_COPY[code as keyof typeof NANO_ACCOUNT_ERROR_COPY]);
      expect(error.message).not.toContain('secret');
    }
    expect(nanoAccountError(JSON.stringify({ code: 'offline' })).code).toBe('offline');
    expect(nanoAccountError('Command nano_account_status_v1 not found').code).toBe('unknown');
    expect(nanoAccountError({ code: 'launch-missiles' }).code).toBe('unknown');
    expect(nanoAccountError(new Error('boom')).code).toBe('unknown');
  });

  it('keeps the copy table in step with every contract error code', () => {
    const contractCodes = [
      'invalid', 'safe-mode', 'busy', 'offline', 'unsupported-server', 'client-too-old', 'sign-in-required', 'sign-in-cancelled',
      'sign-in-timeout', 'sign-in-failed', 'device-revoked', 'workspace-not-found', 'credential-store-failed', 'browser-failed',
      'credits-exhausted', 'mode-locked', 'rate-limited', 'feature-unavailable',
    ];
    expect(Object.keys(NANO_ACCOUNT_ERROR_COPY).sort()).toEqual([...contractCodes, 'unknown'].sort());
    for (const copy of Object.values(NANO_ACCOUNT_ERROR_COPY)) expect(copy.length).toBeGreaterThan(10);
  });

  it('sends the commands the contract lists and drops malformed events', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const listeners: ((payload: unknown) => void)[] = [];
    const client = createNanoAccountClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        if (command === 'nano_account_refresh_v1') throw { code: 'offline' };
        if (command === 'nano_cloud_open_v1') return null as T;
        if (command === 'nano_dictation_v1') return { text: 'hello' } as T;
        return fixture.signedIn as T;
      },
      async <T>(channel: string, handler: (payload: T) => void) => {
        expect(channel).toBe(NANO_ACCOUNT_EVENT_V1);
        listeners.push(handler as (payload: unknown) => void);
        return () => undefined;
      },
    );
    await expect(client.status()).resolves.toEqual(fixture.signedIn);
    await client.signIn();
    await client.cancelSignIn();
    await client.signOut();
    await client.selectWorkspace('ws_synthetic02');
    await client.openLink('billing');
    await expect(client.refresh()).rejects.toMatchObject({ code: 'offline' });
    await expect(client.openCloud()).resolves.toBeUndefined();
    await expect(client.dictate({ audioBase64: 'AAEC', mimeType: 'audio/webm;codecs=opus' })).resolves.toEqual({ text: 'hello' });
    expect(calls).toEqual([
      ['nano_account_status_v1', undefined],
      ['nano_account_sign_in_v1', undefined],
      ['nano_account_cancel_sign_in_v1', undefined],
      ['nano_account_sign_out_v1', undefined],
      ['nano_account_select_workspace_v1', { request: { workspaceId: 'ws_synthetic02' } }],
      ['nano_account_open_link_v1', { request: { link: 'billing' } }],
      ['nano_account_refresh_v1', undefined],
      ['nano_cloud_open_v1', undefined],
      ['nano_dictation_v1', { request: { audioBase64: 'AAEC', mimeType: 'audio/webm;codecs=opus' } }],
    ]);
    const events: NanoAccountEventV1[] = [];
    await client.subscribe((event) => events.push(event));
    for (const listener of listeners) {
      listener({ type: 'status', status: { ...fixture.signedIn, protocol: 7 } });
      listener({ type: 'status', status: fixture.signedOut });
    }
    expect(events).toEqual([{ type: 'status', status: fixture.signedOut }]);
  });

  it('treats an answer outside the contract as a failure', async () => {
    const client = createNanoAccountClient(async <T>() => ({ protocol: 1 }) as T, async () => () => undefined);
    await expect(client.status()).rejects.toMatchObject({ code: 'unknown' });
    await expect(client.dictate({ audioBase64: 'AA', mimeType: 'audio/webm' })).rejects.toMatchObject({ code: 'unknown' });
    expect(decodeNanoDictation({ text: 4 })).toBeUndefined();
    expect(decodeNanoDictation({ text: '' })).toEqual({ text: '' });
  });
});
