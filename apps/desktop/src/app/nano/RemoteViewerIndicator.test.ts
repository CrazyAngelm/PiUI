import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { setLanguage } from '../../features/locale/language';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabRemoteScenario } from '../../host-api/lab/nanoRemoteFake';
import { createNanoRemoteClient, type NanoRemoteStatusV1 } from '../../host-api/nanoRemoteClient';
import RemoteViewerIndicator from './RemoteViewerIndicator.svelte';
import { NanoRemote } from './nanoRemote.svelte';

async function started(remote: LabRemoteScenario): Promise<NanoRemote> {
  const host = labHost('demo', { nano: 'signed-in', remote });
  const store = new NanoRemote(createNanoRemoteClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler)));
  await store.start();
  return store;
}

const html = (remote: NanoRemote, placement: 'sidebar' | 'bar' = 'sidebar'): string =>
  render(RemoteViewerIndicator, { props: { remote, placement, onOpen: () => undefined } }).body;

afterEach(() => setLanguage('en'));

describe('connected-viewer indicator', () => {
  it('shows nothing while nobody is connected', async () => {
    for (const scenario of ['off', 'on', 'pending'] as const) expect(html(await started(scenario)), scenario).not.toContain('<button');
    expect(html(new NanoRemote(createNanoRemoteClient(async () => ({}) as never, async () => () => undefined)))).not.toContain('<button');
  });

  it('is a named button with the number of connected browsers', async () => {
    const body = html(await started('viewer'));
    expect(body).toContain('<button');
    expect(body).toContain('aria-label="Remote access: 1 connected"');
    expect(body).toContain('title="Remote access: 1 connected"');
    expect(body).not.toContain('indicator__count');
  });

  it('adds the count to the icon when several are connected', async () => {
    const remote = await started('viewer');
    const status = remote.status as NanoRemoteStatusV1;
    remote.apply({
      type: 'status',
      status: { ...status, revision: status.revision + 1, viewers: [...status.viewers, { ...status.viewers[0]!, id: 'vw_synthetic0000000000002', grant: 'once' }] },
    });
    const body = html(remote);
    expect(body).toContain('aria-label="Remote access: 2 connected"');
    expect(body).toContain('indicator__count');
  });

  it('takes its place in the sidebar or the narrow top bar', async () => {
    expect(html(await started('viewer'), 'sidebar')).toContain('remote-indicator--sidebar');
    expect(html(await started('viewer'), 'bar')).toContain('remote-indicator--bar');
  });

  it('is in Russian when the language is', async () => {
    setLanguage('ru');
    expect(html(await started('viewer'))).toContain('aria-label="Удалённый доступ: подключено 1"');
  });
});
