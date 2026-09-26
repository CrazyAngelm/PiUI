import { backgroundHost, type BackgroundClient, type TrayLabelsV1 } from '../../host-api/backgroundClient';

/** `$t` from the locale catalog. */
export type Translate = (value: string, parameters?: readonly unknown[]) => string;

/** Tray menu copy in the current interface language (English source keys). */
export function trayLabels(t: Translate): TrayLabelsV1 {
  return {
    open: t('Open PiUI'),
    pause: t('Pause all automations'),
    resume: t('Resume automations'),
    quit: t('Quit PiUI'),
    tooltip: 'PiUI',
    pausedTooltip: t('PiUI (automations paused)'),
  };
}

/**
 * Sends the tray menu copy to the host. The tray is native, so its labels
 * cannot come from the WebView's catalog otherwise; failures are harmless
 * (the host keeps English labels).
 */
export function syncTrayLabels(t: Translate, client: BackgroundClient = backgroundHost): void {
  void client.trayLabels(trayLabels(t)).catch(() => {
    // An older host or an unavailable tray keeps its English menu.
  });
}
