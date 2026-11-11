import { expect, it } from 'vitest';
import { DICTATION_ERROR_COPY } from '../../../app/nano/dictation';
import { NANO_LOCK_COPY, NANO_TIER_COPY, chipFor } from '../../../app/nano/nanoView';
import { NANO_ACCOUNT_ERROR_COPY } from '../../../host-api/nanoAccountClient';
import { translate } from '../language';
import { nanoRu } from './nano';

it('translates every Nano account failure, lock, tier and dictation error', () => {
  const copies = [
    ...Object.values(NANO_ACCOUNT_ERROR_COPY),
    ...Object.values(NANO_LOCK_COPY),
    ...Object.values(NANO_TIER_COPY),
    ...Object.values(DICTATION_ERROR_COPY),
  ];
  for (const message of copies) expect(translate(message, 'ru'), message).not.toBe(message);
});

it('translates the labels of the sidebar chip', () => {
  const labels = [chipFor(undefined), ...(['signed-out', 'signing-in', 'expired', 'unsupported', 'offline'] as const).map((state) => chipFor({ state } as never))];
  for (const { label } of labels) expect(translate(label, 'ru'), label).not.toBe(label);
});

it('keeps every placeholder of the Nano copy', () => {
  for (const [english, russian] of Object.entries(nanoRu)) {
    expect(translate(english, 'ru'), english).toBe(russian);
    expect([...(russian.match(/\{\d\}/g) ?? [])].sort(), english).toEqual([...(english.match(/\{\d\}/g) ?? [])].sort());
  }
});

it('shows the same screen strings in Russian that the views ask for', () => {
  for (const message of ['Nano account', 'Sign in', 'Create account', 'Manage plan', 'Devices', 'Sign out', 'Show Nano avatar', 'Dictate', 'Stop dictation', 'Open Nano Cloud', 'Sign in to use Nano']) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});
