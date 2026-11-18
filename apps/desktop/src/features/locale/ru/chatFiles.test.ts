import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../ruCatalog';
import { chatFilesRu } from './chatFiles';
import { ORIGIN_LABELS } from '../../../app/chat/files/placeChatFiles';

/** Every English string the chat file cards, their actions and their errors ask for. */
const STRINGS = [
  'Save as…',
  'Open containing folder',
  'File saved',
  ...Object.values(ORIGIN_LABELS),
  '{0} B',
  '{0} KB',
  '{0} MB',
  '{0} GB',
  'This file is no longer available.',
  'This file cannot be previewed. Open it or save a copy.',
  'Nano Desktop does not open this kind of file. Save a copy or show it in its folder.',
  'The file action could not be completed.',
];

describe('Russian copy for chat files', () => {
  it('translates every string of the file cards, their actions and the host errors', () => {
    for (const text of STRINGS) expect(lookupRussian(text), text).toBeDefined();
  });

  it('keeps the placeholders of the size units', () => {
    for (const [key, value] of Object.entries(chatFilesRu)) {
      expect(value.includes('{0}'), key).toBe(key.includes('{0}'));
    }
  });
});
