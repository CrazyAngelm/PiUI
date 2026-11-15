import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDictationClient, type DictationClient, type DictationSettingsUpdateV1, type DictationSettingsV1 } from '../dictationClient';
import { LAB_DICTATION_TEXT } from './dictationFake';
import { labHost } from './labTestKit';
import type { LabScenarioName } from './labState';

const CLIP = { audioBase64: 'AAAA', mimeType: 'audio/webm;codecs=opus' };

function client(scenario: LabScenarioName = 'demo'): DictationClient {
  const host = labHost(scenario);
  return createDictationClient((command, args) => host.invoke(command, args));
}

function update(source: DictationSettingsUpdateV1['source'], overrides: Partial<DictationSettingsUpdateV1> = {}): DictationSettingsUpdateV1 {
  return { source, language: null, openaiModel: '', groqModel: '', customBaseUrl: '', customModel: '', ...overrides };
}

const custom = (settings: DictationSettingsV1) => settings.providers[2];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dictation sources in the UI Lab', () => {
  it('starts on the Nano source with nothing ready', async () => {
    const settings = await client().settings({ type: 'get' });
    expect([settings.source, settings.language, settings.keyEntry, settings.safeMode]).toEqual(['nano', null, true, false]);
    expect(settings.providers.map((provider) => provider.id)).toEqual(['openai', 'groq', 'custom']);
    expect(settings.providers[0]).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe', keyRequired: true });
    expect(settings.providers[1]).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' });
    expect(settings.providers.some((provider) => provider.ready || provider.keySet)).toBe(false);
    expect(settings.maxBytes).toBe(20971520);
  });

  it('refuses a plain http address and keeps the old settings', async () => {
    const dictation = client();
    await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'http://127.0.0.1:8000/v1', customModel: 'whisper-local' }) });
    await expect(dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'http://example.test/v1', customModel: 'other' }) })).rejects.toMatchObject({ code: 'invalid-url' });
    const kept = custom(await dictation.settings({ type: 'get' }));
    expect([kept.baseUrl, kept.model]).toEqual(['http://127.0.0.1:8000/v1', 'whisper-local']);
    for (const bad of ['https://user:key@example.test/v1', 'https://example.test/v1?key=1', 'https://example.test/v1#x', 'not a url', 'ftp://example.test']) {
      await expect(dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: bad }) }), bad).rejects.toMatchObject({ code: 'invalid-url' });
    }
  });

  it('makes a local custom endpoint ready without a key', async () => {
    const dictation = client();
    const settings = await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'http://127.0.0.1:8000/v1', customModel: 'whisper-local' }) });
    expect(custom(settings)).toMatchObject({ keyRequired: false, keySet: false, ready: true });
    const unfinished = await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'http://127.0.0.1:8000/v1' }) });
    expect(custom(unfinished).ready).toBe(false);
  });

  it('readies a preset only after its key is set, and clears it', async () => {
    const dictation = client();
    const saved = await dictation.settings({ type: 'save', settings: update('openai') });
    expect(saved.providers[0]).toMatchObject({ model: 'gpt-4o-transcribe', keySet: false, ready: false });
    const keyed = await dictation.settings({ type: 'set-key', provider: 'openai', language: 'en' });
    expect(keyed.providers[0]).toMatchObject({ keySet: true, ready: true });
    const cleared = await dictation.settings({ type: 'clear-key', provider: 'openai' });
    expect(cleared.providers[0]).toMatchObject({ keySet: false, ready: false });
    await expect(dictation.settings({ type: 'set-key', provider: 'custom', language: 'en' })).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('drops the custom key when the address changes', async () => {
    const dictation = client();
    await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'https://stt.example.test/v1', customModel: 'm' }) });
    expect(custom(await dictation.settings({ type: 'set-key', provider: 'custom', language: 'ru' })).keySet).toBe(true);
    const same = await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'https://stt.example.test/v1/', customModel: 'm2' }) });
    expect(custom(same).keySet).toBe(true);
    const moved = await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'https://moved.example.test/v1', customModel: 'm2' }) });
    expect(custom(moved).keySet).toBe(false);
    const back = await dictation.settings({ type: 'save', settings: update('custom', { customBaseUrl: 'https://stt.example.test/v1', customModel: 'm2' }) });
    expect(custom(back).keySet).toBe(false);
  });

  it('validates models and the language hint like the host', async () => {
    const dictation = client();
    await expect(dictation.settings({ type: 'save', settings: update('openai', { openaiModel: 'a\nb' }) })).rejects.toMatchObject({ code: 'invalid-model' });
    await expect(dictation.settings({ type: 'save', settings: update('openai', { groqModel: 'm'.repeat(129) }) })).rejects.toMatchObject({ code: 'invalid-model' });
    for (const bad of ['english', 'e', 'r1']) {
      await expect(dictation.settings({ type: 'save', settings: update('openai', { language: bad }) }), bad).rejects.toMatchObject({ code: 'invalid-language' });
    }
    const saved = await dictation.settings({ type: 'save', settings: update('groq', { language: ' RU ', groqModel: ' whisper-large-v3 ' }) });
    expect([saved.language, saved.providers[1].model]).toEqual(['ru', 'whisper-large-v3']);
  });

  it('transcribes only with a ready provider source', async () => {
    const dictation = client();
    await expect(dictation.transcribe(CLIP)).rejects.toMatchObject({ code: 'not-configured' });
    await dictation.settings({ type: 'save', settings: update('off') });
    await expect(dictation.transcribe(CLIP)).rejects.toMatchObject({ code: 'not-configured' });
    await dictation.settings({ type: 'save', settings: update('openai') });
    await expect(dictation.transcribe(CLIP)).rejects.toMatchObject({ code: 'not-configured' });
    await dictation.settings({ type: 'set-key', provider: 'openai', language: 'en' });
    const text = dictation.transcribe(CLIP);
    await vi.advanceTimersByTimeAsync(500);
    expect(await text).toEqual({ text: LAB_DICTATION_TEXT });
    await expect(dictation.transcribe({ audioBase64: 'AAAA', mimeType: 'audio/wav' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reads in safe mode and refuses everything else', async () => {
    const dictation = client('safe');
    const settings = await dictation.settings({ type: 'get' });
    expect([settings.safeMode, settings.keyEntry]).toEqual([true, false]);
    await expect(dictation.settings({ type: 'save', settings: update('openai') })).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(dictation.settings({ type: 'set-key', provider: 'openai', language: 'en' })).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(dictation.settings({ type: 'clear-key', provider: 'openai' })).rejects.toMatchObject({ code: 'safe-mode' });
    await expect(dictation.transcribe(CLIP)).rejects.toMatchObject({ code: 'safe-mode' });
  });
});
