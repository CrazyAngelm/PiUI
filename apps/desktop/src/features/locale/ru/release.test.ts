import { expect, it } from 'vitest';
import { APP_UPDATE_ERROR_COPY } from '../../../host-api/appUpdateClient';
import { translate } from '../language';
import { releaseRu } from './release';

it('translates every app update failure', () => {
  for (const message of Object.values(APP_UPDATE_ERROR_COPY)) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});

it('translates the About update copy and keeps every placeholder', () => {
  for (const [english, russian] of Object.entries(releaseRu)) {
    expect(translate(english, 'ru'), english).toBe(russian);
    expect(russian.match(/\{\d\}/g) ?? [], english).toEqual(english.match(/\{\d\}/g) ?? []);
  }
  for (const message of ['About', 'Safe mode', 'On', 'Off', 'Cancel', 'Close']) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});
