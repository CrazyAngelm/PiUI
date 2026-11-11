import { get } from 'svelte/store';
import { language, translate } from '../../features/locale/language';
import { toasts } from '../../lib/ui';
import { nanoAccount, type NanoAccount } from './nanoAccount.svelte';

/**
 * "Open Nano Cloud": the host fetches a one-time launch link and opens the
 * window, which takes a moment, so a short notice confirms the click; a
 * refusal is told once as a toast.
 */
export async function openNanoCloud(account: NanoAccount = nanoAccount): Promise<boolean> {
  const locale = get(language);
  if (await account.openCloud()) {
    toasts.show({ title: translate('Opening Nano Cloud…', locale), duration: 2500 });
    return true;
  }
  if (account.error !== undefined) {
    toasts.show({ tone: 'warning', title: translate('Could not open Nano Cloud', locale), description: translate(account.error, locale), duration: 6000 });
  }
  return false;
}
