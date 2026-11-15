import { describe, expect, it } from 'vitest';
import { DICTATION_NOTICE_COPY } from '../../../app/nano/dictation';
import { DICTATION_SOURCE_ERROR_COPY } from '../../../app/nano/dictationCopy';
import { lookupRussian } from '../ruCatalog';
import { dictationRu } from './dictation';

/** Every English string the Dictation section and the dictation button ask for. */
const SCREEN_STRINGS = [
  'Dictation',
  'Safe mode is on: dictation is off.',
  'Choose what turns your speech into text in the message box. A recording goes only to the service you choose. One that could not be sent stays on this computer for up to 24 hours, until you send, save or delete it.',
  'Speech to text',
  'Off',
  'Nano subscription',
  'Nano subscription (sign in required)',
  'Custom API',
  'API base URL',
  'Model',
  'Spoken language',
  'optional',
  'API key',
  'Saved in the system credential store',
  'Not set',
  'Set API key…',
  'Replace API key…',
  'Remove API key',
  'API keys can be entered only on Windows in this version.',
  ...Object.values(DICTATION_NOTICE_COPY),
  'Unsent recording',
  'Recording {0} was not transcribed',
  'Recording {0} was not sent',
  'Recording {0} was too large to send',
  'Kept only until the app closes',
  'Retry',
  'Save audio',
  'Delete',
  'Confirm delete',
  'Audio saved.',
  'Could not save the audio.',
];

describe('dictation Russian copy', () => {
  it.each([...Object.values(DICTATION_SOURCE_ERROR_COPY), ...SCREEN_STRINGS])('translates %s through the catalog', (source) => {
    expect(lookupRussian(source), source).toBeTruthy();
    expect(lookupRussian(source), source).not.toBe(source);
  });

  it('serves every entry of the dictation file unchanged and keeps the placeholders', () => {
    for (const [english, russian] of Object.entries(dictationRu)) {
      expect(lookupRussian(english), english).toBe(russian);
      expect([...(russian.match(/\{\d\}/g) ?? [])].sort(), english).toEqual([...(english.match(/\{\d\}/g) ?? [])].sort());
      expect(russian.toLowerCase(), english).not.toContain('харнес');
    }
    expect(lookupRussian('Dictation')).toBe('Диктовка');
  });
});
