import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_UPDATE_ERROR_COPY, createAppUpdateClient, type AppUpdateClient } from '../../host-api/appUpdateClient';
import type { LabUpdateScenario } from '../../host-api/lab/appUpdateFake';
import { labHost } from '../../host-api/lab/labTestKit';
import { toasts } from '../../lib/ui';
import { AppUpdates, megabytes, progressPercent } from './appUpdates.svelte';
import { watchUpdateNotices } from './updateNotices';

/** A client over the UI Lab host that records every host call. */
function labClient(updates: LabUpdateScenario | undefined, calls: string[] = []): AppUpdateClient {
  const host = labHost('demo', updates === undefined ? {} : { updates });
  return createAppUpdateClient(
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
  vi.useRealTimers();
});

describe('updates in a build without updater keys', () => {
  it('reads one local status and never subscribes, checks or saves anything', async () => {
    const calls: string[] = [];
    const updates = new AppUpdates(labClient(undefined, calls));
    await updates.load();
    expect(updates.visible).toBe(false);
    expect(updates.status?.configured).toBe(false);
    expect(updates.status?.currentVersion).toBe('0.2.0');
    expect(await updates.check()).toBe(false);
    expect(await updates.setAutoCheck(true)).toBe(false);
    expect(await updates.install('0.2.1')).toBe(false);
    expect(calls).toEqual(['app_update_status_v1']);
    updates.dispose();
  });

  it('refuses every update command at the host as well', async () => {
    const host = labHost('demo');
    for (const [command, args] of [
      ['app_update_check_v1', {}],
      ['app_update_install_v1', { request: { version: '0.2.1' } }],
      ['app_update_set_auto_check_v1', { request: { enabled: true } }],
    ] as const) {
      await expect(host.invoke(command, args)).rejects.toMatchObject({ code: 'not-configured' });
    }
    await expect(host.invoke('app_update_restart_v1')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('shows no update notice', async () => {
    const calls: string[] = [];
    const stop = await watchUpdateNotices(() => undefined, labClient(undefined, calls));
    stop();
    expect(calls).toEqual(['app_update_status_v1']);
    expect(toasts.items).toEqual([]);
  });
});

describe('updates in a configured build', () => {
  it('checks, reports an up-to-date build and saves the automatic-check choice', async () => {
    const updates = new AppUpdates(labClient('current'));
    await updates.load();
    expect(updates.visible).toBe(true);
    expect(updates.status?.feedHost).toBe('github.com');
    expect(updates.status?.autoCheck).toBe(false);
    const checking = updates.check();
    expect(updates.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await checking).toBe(true);
    expect(updates.status?.lastCheck).toMatchObject({ outcome: 'up-to-date', automatic: false, error: null });
    expect(updates.status?.available).toBeNull();
    expect(await updates.setAutoCheck(true)).toBe(true);
    expect(updates.status?.autoCheck).toBe(true);
    updates.dispose();
  });

  it('downloads only the confirmed version with progress, then restarts', async () => {
    const updates = new AppUpdates(labClient('available'));
    await updates.load();
    expect(updates.status?.available?.version).toBe('0.2.1');
    expect(await updates.install('0.2.0')).toBe(false);
    const installing = updates.install('0.2.1');
    await vi.advanceTimersByTimeAsync(500);
    expect(updates.status?.phase).toBe('downloading');
    const percent = progressPercent(updates.progress);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(100);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await installing).toBe(true);
    expect(updates.status?.phase).toBe('restarting');
    expect(updates.progress).toBeUndefined();
    expect(updates.error).toBeUndefined();
    updates.dispose();
  });

  it('keeps the offer and explains a failed signature check', async () => {
    const updates = new AppUpdates(labClient('bad-signature'));
    await updates.load();
    const checking = updates.check();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await checking).toBe(true);
    const installing = updates.install('0.2.1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await installing).toBe(false);
    expect(updates.error).toBe(APP_UPDATE_ERROR_COPY['signature-invalid']);
    expect(updates.status?.phase).toBe('idle');
    expect(updates.status?.available?.version).toBe('0.2.1');
    updates.dispose();
  });

  it('reports an unreachable server locally and keeps the previous state', async () => {
    const updates = new AppUpdates(labClient('failing'));
    await updates.load();
    const checking = updates.check();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await checking).toBe(false);
    expect(updates.error).toBe(APP_UPDATE_ERROR_COPY.network);
    expect(updates.status?.lastCheck).toMatchObject({ outcome: 'failed', error: 'network' });
    expect(updates.status?.phase).toBe('idle');
    updates.dispose();
  });

  it('offers a restart when the installer did not start', async () => {
    const updates = new AppUpdates(labClient('install-fails'));
    await updates.load();
    const checking = updates.check();
    await vi.advanceTimersByTimeAsync(1_000);
    await checking;
    const installing = updates.install('0.2.1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await installing).toBe(false);
    expect(updates.error).toBe(APP_UPDATE_ERROR_COPY['install-failed']);
    expect(updates.status?.phase).toBe('restart-required');
    expect(await updates.restart()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(updates.status?.phase).toBe('idle');
    updates.dispose();
  });

  it('announces a version found by an automatic check once', async () => {
    const opened = vi.fn();
    const stop = await watchUpdateNotices(opened, labClient('available'));
    expect(toasts.items).toHaveLength(1);
    const [toast] = toasts.items;
    expect(toast?.title).toBe('PiUI 0.2.1 is available');
    expect(toast?.duration).toBe(0);
    toast?.action?.run();
    expect(opened).toHaveBeenCalledOnce();
    stop();
  });

  it('does not announce what the person found with a manual check', async () => {
    const client = labClient('bad-signature');
    const stop = await watchUpdateNotices(() => undefined, client);
    const updates = new AppUpdates(client);
    await updates.load();
    const checking = updates.check();
    await vi.advanceTimersByTimeAsync(1_000);
    await checking;
    expect(updates.status?.available?.version).toBe('0.2.1');
    expect(toasts.items).toEqual([]);
    stop();
    updates.dispose();
  });
});

it('formats download sizes and unknown totals', () => {
  expect(megabytes(12 * 1024 * 1024)).toBe('12.0 MB');
  expect(progressPercent({ downloadedBytes: 5, totalBytes: 10 })).toBe(50);
  expect(progressPercent({ downloadedBytes: 20, totalBytes: 10 })).toBe(100);
  expect(progressPercent({ downloadedBytes: 5, totalBytes: null })).toBeUndefined();
  expect(progressPercent(undefined)).toBeUndefined();
});
