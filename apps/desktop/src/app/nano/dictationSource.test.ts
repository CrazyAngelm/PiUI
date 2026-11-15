import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DictationOperationError,
  type DictationSettingsRequestV1,
  type DictationSettingsUpdateV1,
  type DictationSettingsV1,
} from '../../host-api/dictationClient';
import { DictationSource } from './dictationSource.svelte';

type Provider = DictationSettingsV1['providers'][number];

function provider(id: Provider['id'], overrides: Partial<Provider> = {}): Provider {
  const preset = id !== 'custom';
  return {
    id,
    baseUrl: id === 'openai' ? 'https://api.openai.com/v1' : id === 'groq' ? 'https://api.groq.com/openai/v1' : '',
    model: id === 'openai' ? 'gpt-4o-transcribe' : id === 'groq' ? 'whisper-large-v3-turbo' : '',
    keyRequired: preset,
    keySet: false,
    ready: false,
    ...overrides,
  };
}

function view(source: DictationSettingsV1['source'], ready: Provider['id'] | undefined = undefined, overrides: Partial<DictationSettingsV1> = {}): DictationSettingsV1 {
  return {
    protocol: 1,
    source,
    language: null,
    providers: (['openai', 'groq', 'custom'] as const).map((id) => provider(id, id === ready ? { keySet: id !== 'custom', ready: true } : {})),
    maxBytes: 20971520,
    keyEntry: true,
    safeMode: false,
    ...overrides,
  };
}

const update: DictationSettingsUpdateV1 = { source: 'openai', language: null, openaiModel: '', groqModel: '', customBaseUrl: '', customModel: '' };

function account(canDictate: boolean): { canDictate: boolean; dictationMaxBytes: number | undefined } {
  return { canDictate, dictationMaxBytes: 5_000_000 };
}

async function started(settings: DictationSettingsV1, canDictate = false): Promise<DictationSource> {
  const source = new DictationSource({ settings: async () => settings }, account(canDictate));
  await source.start();
  return source;
}

describe('dictation source', () => {
  it('is the Nano account until the settings are read, and when they cannot be', async () => {
    expect(new DictationSource({ settings: async () => view('off') }, account(true)).active).toBe('nano');
    expect(new DictationSource({ settings: async () => view('off') }, account(false)).active).toBeUndefined();
    const client = { settings: vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(view('off')) };
    const source = new DictationSource(client, account(true));
    await source.start();
    expect([source.settings, source.active, source.available]).toEqual([undefined, 'nano', true]);
    await source.start();
    expect(client.settings).toHaveBeenCalledTimes(2);
    expect(source.active).toBeUndefined();
    await source.start();
    expect(client.settings).toHaveBeenCalledTimes(2);
  });

  it('shows no button for off, or for Nano without an account that allows it', async () => {
    expect((await started(view('off'), true)).available).toBe(false);
    expect((await started(view('nano'), false)).available).toBe(false);
    const signedIn = await started(view('nano'), true);
    expect([signedIn.active, signedIn.maxBytes]).toEqual(['nano', 5_000_000]);
  });

  it('follows a provider only while it can transcribe', async () => {
    expect((await started(view('openai'), true)).available).toBe(false);
    const ready = await started(view('openai', 'openai'));
    expect([ready.active, ready.available, ready.maxBytes]).toEqual(['openai', true, 20971520]);
    // A provider that is ready but not the chosen source does not count.
    expect((await started(view('groq', 'openai'))).available).toBe(false);
    expect((await started(view('custom', 'custom'))).active).toBe('custom');
  });

  it('never offers a provider in safe mode', async () => {
    expect((await started(view('openai', 'openai', { safeMode: true }))).available).toBe(false);
  });

  it('keeps the settings and reports the code when an action fails', async () => {
    const client = {
      settings: vi.fn(async (request: DictationSettingsRequestV1) => {
        if (request.type === 'get') return view('off');
        if (request.type === 'save' && request.settings.source === 'openai') throw { code: 'invalid-url' };
        return view('openai', 'openai');
      }),
    };
    const source = new DictationSource(client, account(false));
    await source.start();
    expect(await source.save(update)).toBe(false);
    expect([source.error, source.settings?.source, source.busy]).toEqual(['invalid-url', 'off', false]);
    expect(await source.save({ ...update, source: 'groq' })).toBe(true);
    expect([source.error, source.settings?.source]).toEqual([undefined, 'openai']);
    client.settings.mockRejectedValueOnce(new DictationOperationError('prompt-failed'));
    expect(await source.setKey('openai', 'en')).toBe(false);
    expect(source.error).toBe('prompt-failed');
    client.settings.mockRejectedValueOnce(new Error('boom'));
    expect(await source.clearKey('openai')).toBe(false);
    expect(source.error).toBe('unknown');
  });

  it('sends host calls one at a time, in the order asked', async () => {
    const order: string[] = [];
    let release: (settings: DictationSettingsV1) => void = () => undefined;
    const client = {
      settings: vi.fn((request: DictationSettingsRequestV1) => {
        order.push(request.type);
        if (request.type !== 'save') return Promise.resolve(view('openai', 'openai'));
        return new Promise<DictationSettingsV1>((resolve) => {
          release = resolve;
        });
      }),
    };
    const source = new DictationSource(client, account(false));
    const first = source.save(update);
    const second = source.setKey('openai', 'ru');
    const third = source.clearKey('openai');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['save']);
    expect(source.busy).toBe(true);
    release(view('openai'));
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(order).toEqual(['save', 'set-key', 'clear-key']);
    expect(source.busy).toBe(false);
  });
});

describe('dictation source saves', () => {
  it('builds a save from the settings of its turn, and may send nothing', async () => {
    const seen: (string | undefined)[] = [];
    const client = {
      settings: vi.fn(async (request: DictationSettingsRequestV1) => (request.type === 'save' ? view(request.settings.source) : view('off'))),
    };
    const source = new DictationSource(client, account(false));
    const first = source.save({ ...update, source: 'groq' });
    const second = source.save((current) => {
      seen.push(current?.source);
      return { ...update, source: 'custom' };
    });
    const none = source.save(() => undefined);
    expect(await Promise.all([first, second, none])).toEqual([true, true, false]);
    expect(seen).toEqual(['groq']);
    expect(client.settings).toHaveBeenCalledTimes(2);
    expect(source.settings?.source).toBe('custom');
    expect(source.error).toBeUndefined();
  });
});

describe('reading the settings after first paint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the delay and can be cancelled before the read', async () => {
    const client = { settings: vi.fn(async () => view('off')) };
    const source = new DictationSource(client, account(false));
    source.startLater(300);
    await vi.advanceTimersByTimeAsync(299);
    expect(client.settings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.settings).toHaveBeenCalledTimes(1);

    const other = { settings: vi.fn(async () => view('off')) };
    const cancelled = new DictationSource(other, account(false));
    cancelled.startLater(300)();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(other.settings).not.toHaveBeenCalled();
  });
});
