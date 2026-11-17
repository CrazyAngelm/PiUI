import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import fixture from '../../../../../contracts/fixtures/nano-remote-v1.json';
import { setLanguage } from '../../features/locale/language';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabNanoScenario } from '../../host-api/lab/nanoAccountFake';
import type { LabRemoteScenario } from '../../host-api/lab/nanoRemoteFake';
import { createNanoRemoteClient, type NanoRemoteStatusV1 } from '../../host-api/nanoRemoteClient';
import { NanoRemote } from '../nano/nanoRemote.svelte';
import RemoteAccessSettings from './RemoteAccessSettings.svelte';

async function started(remote: LabRemoteScenario, nano: LabNanoScenario = 'signed-in', scenario: 'demo' | 'safe' = 'demo'): Promise<NanoRemote> {
  const host = labHost(scenario, { nano, remote });
  const store = new NanoRemote(createNanoRemoteClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler)));
  await store.start();
  return store;
}

const html = (remote: NanoRemote, safeMode = false): string => render(RemoteAccessSettings, { props: { remote, safeMode } }).body;
const withStatus = (remote: NanoRemote, patch: Partial<NanoRemoteStatusV1>): void =>
  remote.apply({ type: 'status', status: { ...(remote.status as NanoRemoteStatusV1), ...patch, revision: (remote.status?.revision ?? 0) + 100 } });

afterEach(() => setLanguage('en'));

describe('Settings → remote access', () => {
  it('waits with a skeleton until the status is known', () => {
    const body = html(new NanoRemote(createNanoRemoteClient(async <T>() => fixture.statusOff as T, async () => () => undefined)));
    expect(body).toContain('aria-busy="true"');
    expect(body).not.toContain('role="switch"');
  });

  it('offers a named, unchecked switch that is off by default', async () => {
    const body = html(await started('off'));
    expect(body).toContain('aria-label="Allow remote access from Nano Web"');
    expect(body).toContain('role="switch"');
    expect(body).toContain('aria-checked="false"');
    // The disclosure names all open chats, not only the ones the browser opens.
    expect(body).toContain('the content of all open chats pass through');
    expect(body).toContain('server to the browser and are not stored there.');
    expect(body).not.toContain('Waiting for connections');
    expect(body).not.toContain('Connected now');
    expect(body).not.toContain('Allowed browsers');
    expect(body).not.toContain('role="alert"');
  });

  it('says it is waiting once the link is online without anyone connected', async () => {
    const body = html(await started('on'));
    expect(body).toContain('aria-checked="true"');
    expect(body).toContain('Waiting for connections');
  });

  it('shows the connection progress and a refusal as one status line', async () => {
    const connecting = await started('on');
    withStatus(connecting, { link: 'connecting' });
    expect(html(connecting)).toContain('Connecting…');
    expect(html(connecting)).not.toContain('Waiting for connections');
    withStatus(connecting, { link: 'retrying' });
    expect(html(connecting)).toContain('Connecting…');
    withStatus(connecting, { link: 'refused' });
    const refused = html(connecting);
    expect(refused).toContain('The Nano server refused remote access.');
    expect(refused).not.toContain('Connecting…');
  });

  it('lists connected browsers with a named disconnect and the fingerprint as a hover title', async () => {
    const body = html(await started('viewer'));
    expect(body).toContain('Connected now');
    expect(body).toContain('Chrome · Android');
    expect(body).toContain('title="0ed3a6ab957ff6f5"');
    expect(body).toContain('aria-label="Disconnect Chrome · Android"');
    expect(body).not.toContain('Waiting for connections');
    expect(body).not.toContain('Allowed once');
  });

  it('marks a browser that was allowed once', async () => {
    const remote = await started('pending');
    await remote.decide('req_synthetic01', 'once');
    const body = html(remote);
    expect(body).toContain('Allowed once');
    expect(body).not.toContain('Allowed browsers');
  });

  it('lists the remembered browsers with their dates and a named remove', async () => {
    const body = html(await started('viewer'));
    expect(body).toContain('Allowed browsers');
    expect(body).toContain('aria-label="Remove Chrome · Android"');
    expect(body).toContain('Added ');
    expect(body).toContain('Last used ');
    const unused = await started('viewer');
    withStatus(unused, { browsers: unused.status!.browsers.map((browser) => ({ ...browser, lastUsedAt: null })) });
    expect(html(unused)).not.toContain('Last used');
  });

  it('disables the switch with the reason: signed out, unsupported server, safe mode', async () => {
    const unsupported = html(await started('unsupported'));
    expect(unsupported).toContain('This Nano server does not support remote access yet.');
    expect(unsupported).toMatch(/<button[^>]*role="switch"[^>]*disabled|<button[^>]*disabled[^>]*role="switch"/);
    expect(unsupported).not.toContain('pass through');

    const signedOut = html(await started('off', 'signed-out'));
    expect(signedOut).toContain('Sign in to use remote access.');

    const safe = html(await started('off', 'signed-in', 'safe'), true);
    expect(safe).toContain('Not available in safe mode.');
    expect(safe).toMatch(/<button[^>]*role="switch"[^>]*disabled|<button[^>]*disabled[^>]*role="switch"/);
    expect(safe).toContain('aria-checked="false"');
    // Safe mode wins even before the status is known.
    const waiting = html(new NanoRemote(createNanoRemoteClient(async <T>() => fixture.statusOff as T, async () => () => undefined)), true);
    expect(waiting).toContain('Not available in safe mode.');
    expect(waiting).not.toContain('aria-busy');
  });

  it('shows a failed action as an alert in fixed copy, and offers a retry when nothing loaded', async () => {
    const remote = await started('pending');
    await remote.decide('req_missing', 'deny');
    expect(html(remote)).toContain('role="alert"');
    expect(html(remote)).toContain('That request or browser is no longer available.');

    const failing = new NanoRemote(
      createNanoRemoteClient(
        async () => {
          throw { code: 'io' };
        },
        async () => () => undefined,
      ),
    );
    await failing.start();
    const body = html(failing);
    expect(body).toContain('role="alert"');
    expect(body).toContain('Try again');
    expect(body).not.toContain('aria-busy');
  });

  it('is in Russian when the language is', async () => {
    setLanguage('ru');
    const body = html(await started('viewer'));
    for (const text of ['Разрешить удалённый доступ из Nano Web', 'Подключены сейчас', 'Разрешённые браузеры', 'Отключить', 'Убрать Chrome · Android']) {
      expect(body, text).toContain(text);
    }
    expect(html(await started('on'))).toContain('Ожидание подключений');
    expect(html(await started('unsupported'))).toContain('Этот сервер Nano пока не поддерживает удалённый доступ.');
    expect(html(await started('off', 'signed-out'))).toContain('Войдите в аккаунт, чтобы включить удалённый доступ.');
    expect(html(await started('off', 'signed-in', 'safe'), true)).toContain('Недоступно в безопасном режиме.');
  });
});
