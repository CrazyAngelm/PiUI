import {
  SITE_BROWSER_ACTION,
  SITE_BROWSER_CHANGED,
  SITE_BROWSER_DOWNLOAD_BLOCKED,
  SITE_BROWSER_POPUP_BLOCKED,
  type SiteBrowserAction,
  type SiteBrowserSnapshot,
} from '../../../../contracts/site-browser-v1';
import { desktopAvailable, hostInvoke, hostListen, hostRemote } from './transport';

export function browserAction(request: SiteBrowserAction): Promise<SiteBrowserSnapshot> {
  if (!desktopAvailable && !hostRemote) return labAction(request);
  return hostInvoke(SITE_BROWSER_ACTION, { request });
}

export function onBrowserChange(handler: () => void): Promise<() => void> {
  return desktopAvailable ? hostListen(SITE_BROWSER_CHANGED, handler) : Promise.resolve(() => {});
}

export async function onBrowserNotice(handler: (kind: 'popup' | 'download') => void): Promise<() => void> {
  if (!desktopAvailable) return () => {};
  const stopPopup = await hostListen(SITE_BROWSER_POPUP_BLOCKED, () => handler('popup'));
  try {
    const stopDownload = await hostListen(SITE_BROWSER_DOWNLOAD_BLOCKED, () => handler('download'));
    return () => { stopPopup(); stopDownload(); };
  } catch (cause) {
    stopPopup();
    throw cause;
  }
}

let fake: Promise<typeof import('./lab/siteBrowserFake')> | undefined;

async function labAction(request: SiteBrowserAction): Promise<SiteBrowserSnapshot> {
  fake ??= import('./lab/siteBrowserFake');
  return (await fake).siteBrowserAction(request);
}
