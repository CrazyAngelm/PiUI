import { describe, expect, it, vi } from 'vitest';
import {
  DICTATION_ERROR_CODES,
  DictationOperationError,
  createDictationClient,
  decodeDictationSettings,
  dictationError,
} from './dictationClient';

function settingsView(): Record<string, unknown> {
  return {
    protocol: 1,
    source: 'openai',
    language: null,
    providers: [
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe', keyRequired: true, keySet: true, ready: true },
      { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyRequired: true, keySet: false, ready: false },
      { id: 'custom', baseUrl: '', model: '', keyRequired: false, keySet: false, ready: false },
    ],
    maxBytes: 20971520,
    keyEntry: true,
    safeMode: false,
  };
}

const CLIP = { audioBase64: 'AAAA', mimeType: 'audio/webm' };

describe('dictation settings decoding', () => {
  it('decodes a host-shaped view into a fresh object', () => {
    const raw = settingsView();
    const decoded = decodeDictationSettings(raw);
    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decodeDictationSettings({ ...raw, language: 'ru' })?.language).toBe('ru');
  });

  it('rejects anything that is not exactly the contract', () => {
    const providers = settingsView().providers as Record<string, unknown>[];
    const bad: unknown[] = [
      undefined,
      'text',
      { ...settingsView(), protocol: 2 },
      { ...settingsView(), providers: providers.slice(0, 2) },
      { ...settingsView(), providers: [providers[1], providers[0], providers[2]] },
      { ...settingsView(), source: 'deepgram' },
      { ...settingsView(), maxBytes: 0 },
      { ...settingsView(), maxBytes: Number.POSITIVE_INFINITY },
      { ...settingsView(), keyEntry: 'yes' },
      { ...settingsView(), language: 3 },
      { ...settingsView(), providers: [{ ...providers[0], keySet: 'yes' }, providers[1], providers[2]] },
      { ...settingsView(), providers: [{ ...providers[0], model: 1 }, providers[1], providers[2]] },
    ];
    for (const value of bad) expect(decodeDictationSettings(value)).toBeUndefined();
  });
});

describe('dictation client', () => {
  it('sends settings and transcription requests as one request argument', async () => {
    const invoke = vi.fn((command: string) => Promise.resolve(command === 'dictation_settings_v1' ? settingsView() : { text: 'hello' }));
    const client = createDictationClient(invoke as never);
    expect((await client.settings({ type: 'get' })).source).toBe('openai');
    expect(invoke).toHaveBeenLastCalledWith('dictation_settings_v1', { request: { type: 'get' } });
    expect(await client.transcribe(CLIP)).toEqual({ text: 'hello' });
    expect(invoke).toHaveBeenLastCalledWith('dictation_transcribe_v1', { request: CLIP });
  });

  it('maps rejections to typed errors and never forwards host text', async () => {
    const code = async (cause: unknown): Promise<string> => {
      try {
        await createDictationClient((() => Promise.reject(cause)) as never).transcribe(CLIP);
      } catch (error) {
        expect(error).toBeInstanceOf(DictationOperationError);
        expect((error as Error).message).not.toContain('secret host text');
        return (error as DictationOperationError).code;
      }
      return 'resolved';
    };
    expect(await code({ code: 'invalid-key' })).toBe('invalid-key');
    expect(await code(JSON.stringify({ code: 'invalid-key' }))).toBe('invalid-key');
    expect(await code(new Error('boom secret host text'))).toBe('unknown');
    expect(await code({ code: 'made-up', message: 'secret host text' })).toBe('unknown');
    expect(dictationError(new DictationOperationError('offline')).code).toBe('offline');
    expect(dictationError('not json').code).toBe('unknown');
  });

  it('accepts an empty text and refuses an answer that is not one', async () => {
    const answer = (value: unknown) => createDictationClient((() => Promise.resolve(value)) as never).transcribe(CLIP);
    expect(await answer({ text: '' })).toEqual({ text: '' });
    await expect(answer({ words: 'x' })).rejects.toMatchObject({ code: 'unknown' });
    await expect(createDictationClient((() => Promise.resolve({ protocol: 3 })) as never).settings({ type: 'get' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('lists the contract error codes once each', () => {
    expect(DICTATION_ERROR_CODES).toHaveLength(17);
    expect(new Set(DICTATION_ERROR_CODES).size).toBe(17);
  });
});
