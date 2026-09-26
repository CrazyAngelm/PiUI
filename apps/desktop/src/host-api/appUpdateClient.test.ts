import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/app-update-v1.json';
import {
  APP_UPDATE_ERROR_COPY,
  APP_UPDATE_EVENT,
  AppUpdateOperationError,
  appUpdateError,
  createAppUpdateClient,
  decodeAppUpdateEvent,
  decodeAppUpdateStatus,
  type AppUpdateEventV1,
} from './appUpdateClient';

describe('app update v1 client', () => {
  it('accepts every status and event in the public fixture', () => {
    for (const key of ['notConfigured', 'available', 'failedCheck', 'downloading'] as const) {
      expect(decodeAppUpdateStatus(fixture[key]), key).toEqual(fixture[key]);
    }
    expect(decodeAppUpdateEvent(fixture.statusEvent)).toEqual(fixture.statusEvent);
    expect(decodeAppUpdateEvent(fixture.progressEvent)).toEqual(fixture.progressEvent);
    expect(appUpdateError(fixture.error).code).toBe('signature-invalid');
  });

  it('refuses statuses and events outside the contract', () => {
    const base = fixture.available;
    for (const broken of [
      null,
      { ...base, protocol: 2 },
      { ...base, configured: 'yes' },
      { ...base, phase: 'paused' },
      { ...base, feedHost: 42 },
      { ...base, lastCheck: { ...base.lastCheck, outcome: 'maybe' } },
      { ...base, lastCheck: { ...base.lastCheck, error: 'disk-full' } },
      { ...base, available: { version: '', date: null, notes: null } },
      { ...base, available: { version: '0.2.1', date: 7, notes: null } },
    ]) {
      expect(decodeAppUpdateStatus(broken)).toBeUndefined();
    }
    for (const broken of [
      { type: 'progress', downloadedBytes: -1, totalBytes: null },
      { type: 'progress', downloadedBytes: 1.5, totalBytes: 10 },
      { type: 'status', status: { ...base, protocol: 0 } },
      { type: 'restart' },
    ]) {
      expect(decodeAppUpdateEvent(broken)).toBeUndefined();
    }
  });

  it('maps host refusals to fixed copy and never forwards host details', () => {
    const codes = Object.keys(APP_UPDATE_ERROR_COPY);
    for (const code of codes) {
      const error = appUpdateError({ code, message: 'C:/secret/path and native text' });
      expect(error).toBeInstanceOf(AppUpdateOperationError);
      expect(error.message).toBe(APP_UPDATE_ERROR_COPY[code as keyof typeof APP_UPDATE_ERROR_COPY]);
      expect(error.message).not.toContain('secret');
    }
    expect(appUpdateError(JSON.stringify({ code: 'network' })).code).toBe('network');
    expect(appUpdateError('Command app_update_check_v1 not found').code).toBe('unknown');
    expect(appUpdateError({ code: 'launch-missiles' }).code).toBe('unknown');
    expect(appUpdateError(new Error('boom')).code).toBe('unknown');
  });

  it('sends typed requests and drops malformed events', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const listeners: ((payload: unknown) => void)[] = [];
    const client = createAppUpdateClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        if (command === 'app_update_install_v1') throw { code: 'signature-invalid' };
        return (command === 'app_update_restart_v1' ? null : fixture.available) as T;
      },
      async <T>(channel: string, handler: (payload: T) => void) => {
        expect(channel).toBe(APP_UPDATE_EVENT);
        listeners.push(handler as (payload: unknown) => void);
        return () => undefined;
      },
    );
    await expect(client.status()).resolves.toEqual(fixture.available);
    await expect(client.check()).resolves.toEqual(fixture.available);
    await expect(client.setAutoCheck(true)).resolves.toEqual(fixture.available);
    await expect(client.install('0.2.1')).rejects.toMatchObject({ code: 'signature-invalid' });
    await expect(client.restart()).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['app_update_status_v1', undefined],
      ['app_update_check_v1', undefined],
      ['app_update_set_auto_check_v1', { request: { enabled: true } }],
      ['app_update_install_v1', { request: { version: '0.2.1' } }],
      ['app_update_restart_v1', undefined],
    ]);
    const events: AppUpdateEventV1[] = [];
    await client.subscribe((event) => events.push(event));
    for (const listener of listeners) {
      listener({ type: 'progress', downloadedBytes: 'many' });
      listener(fixture.progressEvent);
    }
    expect(events).toEqual([fixture.progressEvent]);
  });

  it('treats an answer outside the contract as a failure', async () => {
    const client = createAppUpdateClient(async <T>() => ({ protocol: 1 }) as T, async () => () => undefined);
    await expect(client.status()).rejects.toMatchObject({ code: 'unknown' });
  });
});
