import { afterEach, describe, expect, it } from 'vitest';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabNanoScenario } from '../../host-api/lab/nanoAccountFake';
import { NanoAccountOperationError, createNanoAccountClient, type NanoAccountClient } from '../../host-api/nanoAccountClient';
import { setLanguage } from '../../features/locale/language';
import { toasts } from '../../lib/ui';
import { NanoAccount } from './nanoAccount.svelte';
import { openNanoCloud } from './openCloud';

async function started(nano: LabNanoScenario, override: Partial<NanoAccountClient> = {}): Promise<NanoAccount> {
  const host = labHost('demo', { nano });
  const client = createNanoAccountClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler));
  const account = new NanoAccount({ ...client, ...override });
  await account.start();
  return account;
}

afterEach(() => {
  for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
  setLanguage('en');
});

describe('Open Nano Cloud', () => {
  it('confirms the click with a short notice', async () => {
    expect(await openNanoCloud(await started('signed-in'))).toBe(true);
    expect(toasts.items.map((toast) => toast.title)).toEqual(['Opening Nano Cloud…']);
  });

  it('says nothing when the plan has no cloud, since the action is not offered', async () => {
    expect(await openNanoCloud(await started('free'))).toBe(false);
    expect(toasts.items).toEqual([]);
  });

  it('tells a refusal once, in the language of the app', async () => {
    const account = await started('signed-in', {
      openCloud: async () => {
        throw new NanoAccountOperationError('offline');
      },
    });
    expect(await openNanoCloud(account)).toBe(false);
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({ tone: 'warning', title: 'Could not open Nano Cloud', description: 'Could not reach Nano. Check your connection and try again.' });
    for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
    setLanguage('ru');
    await openNanoCloud(account);
    expect(toasts.items[0]?.title).toBe('Не удалось открыть Nano Cloud');
  });
});
