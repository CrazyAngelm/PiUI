import { describe, expect, it, vi } from 'vitest';
import type { DictationSettingsRequestV1, DictationSettingsUpdateV1, DictationSettingsV1 } from '../../host-api/dictationClient';
import { DictationDrafts, draftFromHost, savedUpdate } from './dictationDrafts.svelte';
import { DictationSource } from './dictationSource.svelte';

interface Saved {
  source?: DictationSettingsV1['source'];
  language?: string | null;
  openaiModel?: string;
  customBaseUrl?: string;
  customModel?: string;
}

/** The host's view after it saved `saved`; an unset field keeps its default. */
function view(saved: Saved = {}): DictationSettingsV1 {
  return {
    protocol: 1,
    source: saved.source ?? 'openai',
    language: saved.language ?? null,
    providers: [
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: saved.openaiModel ?? 'gpt-4o-transcribe', keyRequired: true, keySet: false, ready: false },
      { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyRequired: true, keySet: false, ready: false },
      { id: 'custom', baseUrl: saved.customBaseUrl ?? '', model: saved.customModel ?? '', keyRequired: false, keySet: false, ready: false },
    ],
    maxBytes: 20971520,
    keyEntry: true,
    safeMode: false,
  };
}

/** What the host would keep for an update: the text fields cleaned the way it cleans them. */
function applied(update: DictationSettingsUpdateV1): DictationSettingsV1 {
  return view({
    source: update.source,
    language: update.language === null ? null : update.language.toLowerCase(),
    openaiModel: update.openaiModel.trim() === '' ? 'gpt-4o-transcribe' : update.openaiModel.trim(),
    customBaseUrl: update.customBaseUrl.trim(),
    customModel: update.customModel.trim(),
  });
}

/** A client whose saves wait until they are answered one by one, in the order they were sent. */
function slowHost(first: DictationSettingsV1 = view()) {
  const requests: DictationSettingsUpdateV1[] = [];
  const pending: { request: DictationSettingsUpdateV1; answer: (value: DictationSettingsV1 | Error) => void }[] = [];
  const client = {
    settings: vi.fn((request: DictationSettingsRequestV1) => {
      if (request.type !== 'save') return Promise.resolve(first);
      requests.push(request.settings);
      return new Promise<DictationSettingsV1>((resolve, reject) => {
        pending.push({ request: request.settings, answer: (value) => (value instanceof Error ? reject(value) : resolve(value)) });
      });
    }),
  };
  const source = new DictationSource(client, { canDictate: false, dictationMaxBytes: undefined });
  return {
    source,
    requests,
    /** Answers the oldest save the way the host would. */
    reply: () => {
      const next = pending.shift()!;
      next.answer(applied(next.request));
    },
    /** Refuses the oldest save with a contract error code. */
    refuse: (code: string) => pending.shift()!.answer(Object.assign(new Error(code), { code })),
  };
}

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('dictation drafts', () => {
  it('starts from the host settings and takes them once, when they arrive late', async () => {
    const test = slowHost(view({ language: 'ru', customBaseUrl: 'https://stt.example.test/v1', customModel: 'whisper-1' }));
    const drafts = new DictationDrafts(test.source);
    expect(draftFromHost(undefined)).toEqual({ openaiModel: '', groqModel: '', customModel: '', customBaseUrl: '', language: '' });
    expect(drafts.language).toBe('');
    await test.source.start();
    drafts.adopt();
    expect([drafts.language, drafts.customBaseUrl, drafts.customModel, drafts.openaiModel]).toEqual(['ru', 'https://stt.example.test/v1', 'whisper-1', 'gpt-4o-transcribe']);
    // What is typed afterwards is the person's, not the host's.
    drafts.customModel = 'typed';
    drafts.adopt();
    expect(drafts.customModel).toBe('typed');
  });

  it('keeps what was typed while an older save is still being answered', async () => {
    const test = slowHost();
    await test.source.start();
    const drafts = new DictationDrafts(test.source);
    drafts.openaiModel = 'model-a';
    const first = drafts.save('openaiModel');
    await turn();
    expect(test.requests.map((request) => request.openaiModel)).toEqual(['model-a']);

    // The person keeps typing before the host answers.
    drafts.openaiModel = 'model-b';
    test.reply();
    expect(await first).toBe(true);
    expect(test.source.settings?.providers[0]?.model).toBe('model-a');
    expect(drafts.openaiModel).toBe('model-b');

    // The next save carries what was typed, and its answer is adopted.
    const second = drafts.save('openaiModel');
    await turn();
    expect(test.requests.map((request) => request.openaiModel)).toEqual(['model-a', 'model-b']);
    test.reply();
    expect(await second).toBe(true);
    expect(drafts.openaiModel).toBe('model-b');
  });

  it('keeps the newest text when two saves of the same field are queued', async () => {
    const test = slowHost();
    await test.source.start();
    const drafts = new DictationDrafts(test.source);
    drafts.openaiModel = 'model-a';
    const first = drafts.save('openaiModel');
    drafts.openaiModel = 'model-b';
    const second = drafts.save('openaiModel');
    await turn();
    test.reply();
    await first;
    // The answer to the first save does not overwrite the second text.
    expect(drafts.openaiModel).toBe('model-b');
    await turn();
    test.reply();
    await second;
    expect(drafts.openaiModel).toBe('model-b');
    expect(test.requests.map((request) => request.openaiModel)).toEqual(['model-a', 'model-b']);
  });

  it('shows the cleaned value of a field the person has not touched since', async () => {
    const test = slowHost();
    await test.source.start();
    const drafts = new DictationDrafts(test.source);
    drafts.language = ' EN ';
    drafts.openaiModel = '';
    const saving = drafts.save('language', 'openaiModel');
    await turn();
    test.reply();
    expect(await saving).toBe(true);
    expect(test.requests[0]?.language).toBe('EN');
    expect([drafts.language, drafts.openaiModel]).toEqual(['en', 'gpt-4o-transcribe']);
  });

  it('keeps a refused value so it can be corrected, and carries the other fields on their own', async () => {
    const test = slowHost();
    await test.source.start();
    const drafts = new DictationDrafts(test.source);
    drafts.customBaseUrl = 'http://example.test/v1';
    const refused = drafts.save('customBaseUrl');
    await turn();
    test.refuse('invalid-url');
    expect(await refused).toBe(false);
    expect(test.source.error).toBe('invalid-url');
    expect(drafts.customBaseUrl).toBe('http://example.test/v1');

    // The refused address is not sent along with the next field.
    drafts.customModel = 'whisper-local';
    const next = drafts.save('customModel');
    await turn();
    expect(test.requests[1]).toMatchObject({ customBaseUrl: '', customModel: 'whisper-local' });
    test.reply();
    expect(await next).toBe(true);
    expect(drafts.customBaseUrl).toBe('http://example.test/v1');
  });

  it('builds a save from the settings of its own turn', async () => {
    const test = slowHost();
    await test.source.start();
    const drafts = new DictationDrafts(test.source);
    drafts.customBaseUrl = ' https://stt.example.test/v1 ';
    const address = drafts.save('customBaseUrl');
    drafts.customModel = 'whisper-1';
    const model = drafts.save('customModel');
    await turn();
    test.reply();
    await address;
    await turn();
    // The second save starts from what the first one left on the host.
    expect(test.requests[1]).toMatchObject({ customBaseUrl: 'https://stt.example.test/v1', customModel: 'whisper-1' });
    test.reply();
    await model;
    expect([drafts.customBaseUrl, drafts.customModel]).toEqual(['https://stt.example.test/v1', 'whisper-1']);
  });

  it('turns the saved settings back into an update', () => {
    expect(savedUpdate(view({ source: 'custom', language: 'de', customBaseUrl: 'https://x.example.test/v1', customModel: 'm' }))).toEqual({
      source: 'custom',
      language: 'de',
      openaiModel: 'gpt-4o-transcribe',
      groqModel: 'whisper-large-v3-turbo',
      customBaseUrl: 'https://x.example.test/v1',
      customModel: 'm',
    });
  });
});
