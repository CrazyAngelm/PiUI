import { get } from 'svelte/store';
import { t } from '../../features/locale/language';
import { appUpdateHost, type AppUpdateClient, type AppUpdateStatusV1 } from '../../host-api/appUpdateClient';
import { toasts } from '../../lib/ui';

/**
 * Tells the person when an automatic check (which they turned on in Settings →
 * About) found a newer version: one toast per version and session, with a way
 * to the release notes. A build without updates reads one local status and
 * does nothing else: no subscription, no toast.
 */
export async function watchUpdateNotices(open: () => void, client: AppUpdateClient = appUpdateHost): Promise<() => void> {
  let status: AppUpdateStatusV1;
  try {
    status = await client.status();
  } catch {
    return () => undefined;
  }
  if (!status.configured) return () => undefined;
  const notified = new Set<string>();
  const notice = (current: AppUpdateStatusV1): void => {
    const version = current.available?.version;
    if (version === undefined || notified.has(version) || current.lastCheck?.automatic !== true || current.lastCheck.outcome !== 'available') return;
    notified.add(version);
    const translate = get(t);
    toasts.show({
      title: translate('PiUI {0} is available', [version]),
      description: translate('Read what changed and install it from Settings → About.'),
      action: { label: translate('View update'), run: open },
      duration: 0,
    });
  };
  notice(status);
  return client.subscribe((event) => {
    if (event.type === 'status') notice(event.status);
  });
}
