import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';
import { backgroundError, createBackgroundClient, type BackgroundRoute, type TrayLabelsV1 } from '../../host-api/backgroundClient';
import { PATTERN_ISSUE_COPY } from '../../host-api/triggerPatterns';
import { syncTrayLabels, trayLabels, type Translate } from './trayLabels';

const english: Translate = (value, parameters = []) =>
  value.replace(/\{(\d+)\}/g, (token, index: string) => (Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
const russian: Translate = (value, parameters = []) => english(translate(value, 'ru'), parameters);

describe('tray menu copy', () => {
  it('comes from the locale catalog in both languages', () => {
    expect(trayLabels(english)).toEqual({
      open: 'Open PiUI', pause: 'Pause all automations', resume: 'Resume automations', quit: 'Quit PiUI',
      tooltip: 'PiUI', pausedTooltip: 'PiUI (automations paused)',
    });
    const labels = trayLabels(russian);
    for (const key of ['open', 'pause', 'resume', 'quit', 'pausedTooltip'] as const) expect(labels[key]).toMatch(/[а-яё]/i);
    expect(labels.tooltip).toBe('PiUI');
  });

  it('is sent to the host and a refusal is harmless', async () => {
    const sent: TrayLabelsV1[] = [];
    syncTrayLabels(russian, createBackgroundClient(async <T>(route: BackgroundRoute, { request }: { request: unknown }): Promise<T> => {
      if (route === 'background_tray_labels_v1') sent.push(request as TrayLabelsV1);
      return null as T;
    }));
    syncTrayLabels(english, createBackgroundClient(async () => { throw { code: 'unavailable' }; }));
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.quit).toBe('Выйти из PiUI');
  });

  it('translates every background error and pattern explanation', () => {
    for (const code of ['invalid', 'read-only', 'unavailable', 'io', 'unknown']) {
      const message = backgroundError({ code }).message;
      expect(translate(message, 'ru'), message).not.toBe(message);
    }
    for (const message of Object.values(PATTERN_ISSUE_COPY)) expect(translate(message, 'ru'), message).not.toBe(message);
  });
});
