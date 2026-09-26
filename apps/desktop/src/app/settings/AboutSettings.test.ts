import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { setLanguage } from '../../features/locale/language';
import { createAppUpdateClient } from '../../host-api/appUpdateClient';
import type { LabUpdateScenario } from '../../host-api/lab/appUpdateFake';
import { labHost } from '../../host-api/lab/labTestKit';
import AboutSettings from './AboutSettings.svelte';
import { AppUpdates } from './appUpdates.svelte';

async function loaded(scenario: LabUpdateScenario | undefined): Promise<AppUpdates> {
  const host = labHost('demo', scenario === undefined ? {} : { updates: scenario });
  const updates = new AppUpdates(createAppUpdateClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler)));
  await updates.load();
  return updates;
}

function html(updates: AppUpdates, safeMode = false): string {
  return render(AboutSettings, { props: { safeMode, updates } }).body;
}

afterEach(() => {
  setLanguage('en');
  vi.useRealTimers();
});

describe('Settings → About', () => {
  it('shows the version and no update controls in a build without updater keys', async () => {
    const body = html(await loaded(undefined), true);
    expect(body).toContain('0.2.0');
    expect(body).toMatch(/Safe mode<\/span><span class="muted[^"]*">On</);
    expect(body).toContain('Local-first: no account, cloud backend or telemetry.');
    for (const text of ['Updates', 'Check for updates', 'Download and restart', 'Check for updates automatically', 'github.com']) {
      expect(body).not.toContain(text);
    }
  });

  it('shows the check, the automatic-check switch and where checks go when configured', async () => {
    const body = html(await loaded('current'));
    expect(body).toContain('id="about-updates-title"');
    expect(body).toContain('Check for updates');
    expect(body).toContain('Not checked yet.');
    expect(body).toContain('aria-label="Check for updates automatically"');
    expect(body).toContain('aria-checked="false"');
    expect(body).toContain('Checks contact github.com.');
    expect(body).not.toContain('Download and restart');
  });

  it('shows the release notes as plain text and the install action for an offer', async () => {
    const body = html(await loaded('available'));
    expect(body).toContain('PiUI 0.2.1 is available.');
    expect(body).toContain('aria-labelledby="about-offer-title"');
    expect(body).toContain('- Runs: the step panel keeps its width after a restart.');
    expect(body).toContain('Download and restart');
    expect(body).toContain('aria-checked="true"');
    // The confirmation opens only after the person asks for it.
    expect(body).not.toContain('Install PiUI 0.2.1?');
  });

  it('never renders feed notes as markup', async () => {
    const offer = {
      protocol: 1, configured: true, currentVersion: '0.2.0', feedHost: 'github.com', autoCheck: false, phase: 'idle',
      lastCheck: { at: '2026-09-27T09:30:00Z', automatic: false, outcome: 'available', error: null },
      available: { version: '0.2.1', date: null, notes: '<img src=x onerror="alert(1)"> **bold**' },
    };
    const updates = new AppUpdates(createAppUpdateClient(async <T>() => offer as T, async () => () => undefined));
    await updates.load();
    const body = html(updates);
    expect(body).toContain('&lt;img src=x onerror="alert(1)"> **bold**');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<strong>bold</strong>');
  });

  it('offers a restart after an installer that did not start', async () => {
    vi.useFakeTimers();
    const updates = await loaded('install-fails');
    const checking = updates.check();
    await vi.advanceTimersByTimeAsync(1_000);
    await checking;
    const installing = updates.install('0.2.1');
    await vi.advanceTimersByTimeAsync(3_000);
    await installing;
    const body = html(updates);
    expect(body).toContain('The update did not start. PiUI stopped its agents, so restart it to continue.');
    expect(body).toContain('role="alert"');
    expect(body).toContain('The update could not be installed.');
    expect(body).toContain('Restart PiUI');
    expect(body).not.toContain('Download and restart');
  });

  it('renders Russian copy without translating the version or the notes', async () => {
    setLanguage('ru');
    const body = html(await loaded('available'));
    expect(body).toContain('Обновления');
    expect(body).toContain('Проверить обновления');
    expect(body).toContain('Доступна версия PiUI 0.2.1.');
    expect(body).toContain('Загрузить и перезапустить');
    expect(body).toContain('- Runs: the step panel keeps its width after a restart.');
  });
});
