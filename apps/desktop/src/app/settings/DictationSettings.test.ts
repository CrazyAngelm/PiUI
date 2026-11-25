import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { setLanguage } from '../../features/locale/language';
import { createDictationClient, type DictationSettingsUpdateV1, type DictationSettingsV1 } from '../../host-api/dictationClient';
import { labHost } from '../../host-api/lab/labTestKit';
import { DictationSource } from '../nano/dictationSource.svelte';
import DictationSettings from './DictationSettings.svelte';

const signedOut = { canDictate: false };
const signedIn = { canDictate: true };

function lab(patch: Partial<DictationSettingsV1> = {}): DictationSource {
  const host = labHost('demo');
  const client = createDictationClient(async <T,>(command: string, args?: Record<string, unknown>) => {
    const answer = await host.invoke<unknown>(command, args);
    return (command === 'dictation_settings_v1' ? { ...(answer as DictationSettingsV1), ...patch } : answer) as T;
  });
  return new DictationSource(client, { canDictate: false, dictationMaxBytes: undefined });
}

async function started(patch: Partial<DictationSettingsV1> = {}): Promise<DictationSource> {
  const source = lab(patch);
  await source.start();
  return source;
}

const update = (overrides: Partial<DictationSettingsUpdateV1>): DictationSettingsUpdateV1 => ({
  source: 'nano',
  language: null,
  openaiModel: '',
  groqModel: '',
  customBaseUrl: '',
  customModel: '',
  ...overrides,
});

const html = (source: DictationSource, account: { canDictate: boolean } = signedOut, safeMode = false): string =>
  render(DictationSettings, { props: { source, account, safeMode } }).body;

/** The opening tag of the button whose label is `name`. */
function buttonTag(body: string, name: string): string {
  const at = body.indexOf(name);
  const open = body.lastIndexOf('<button', at);
  return open === -1 || at === -1 ? '' : body.slice(open, body.indexOf('>', open) + 1);
}

afterEach(() => setLanguage('en'));

describe('Settings → Dictation', () => {
  it('waits with a skeleton until the settings are read', () => {
    const body = html(lab());
    expect(body).toContain('Dictation');
    expect(body).toContain('aria-busy="true"');
    expect(body).not.toContain('<select');
  });

  it('says only that dictation is off in safe mode', async () => {
    const body = html(await started(), signedOut, true);
    expect(body).toContain('Safe mode is on: dictation is off.');
    expect(body).not.toContain('<select');
    expect(html(await started({ safeMode: true, keyEntry: false })).includes('Safe mode is on: dictation is off.')).toBe(true);
  });

  it('lists the sources, with Nano marked as needing a sign-in', async () => {
    const source = await started();
    const body = html(source);
    for (const label of ['Off', 'Nano subscription (sign in required)', 'OpenAI', 'Groq', 'Custom API']) expect(body).toContain(label);
    expect(body).not.toContain('API key');
    expect(body).not.toContain('role="alert"');
    const microphoneLabel = body.match(/<label for="([^"]+-microphone)"[^>]*>\s*Microphone/);
    expect(microphoneLabel?.[1]).toBeDefined();
    expect(body).toContain(`<select id="${microphoneLabel?.[1]}"`);
    expect(body).toContain('Default microphone');
    expect(body).toContain('Find microphones');
    expect(html(source, signedIn)).not.toContain('(sign in required)');
    expect(html(source, signedIn)).toContain('Nano subscription');
  });

  it('drops the Nano option when another source is chosen and the account cannot dictate', async () => {
    const source = await started();
    await source.save(update({ source: 'off' }));
    expect(html(source)).not.toContain('Nano subscription');
    expect(html(source, signedIn)).toContain('Nano subscription');
  });

  it('shows the OpenAI model, language and key controls', async () => {
    const source = await started();
    await source.save(update({ source: 'openai' }));
    const body = html(source);
    expect(body).toContain('value="gpt-4o-transcribe"');
    for (const name of ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']) expect(body).toContain(`<option value="${name}"`);
    for (const text of ['Model', 'Spoken language', 'API key', 'Not set', 'Set API key…']) expect(body).toContain(text);
    expect(body).not.toContain('API base URL');
    expect(body).not.toContain('Remove API key');
    expect(buttonTag(body, 'Set API key…')).not.toContain('disabled');
    await source.setKey('openai', 'en');
    const keyed = html(source);
    for (const text of ['Saved in the system credential store', 'Replace API key…', 'Remove API key']) expect(keyed).toContain(text);
    expect(keyed).not.toContain('Set API key…');
  });

  it('asks for an address and a model before a custom endpoint can take a key', async () => {
    const source = await started();
    await source.save(update({ source: 'custom' }));
    const body = html(source);
    expect(body).toContain('API base URL');
    // Svelte's block markers may sit between the label and its optional mark.
    expect(body).toMatch(/API key[\s\S]{0,40}<span[^>]*>optional<\/span>/);
    expect(buttonTag(body, 'Set API key…')).toContain('disabled');
    await source.save(update({ source: 'custom', customBaseUrl: 'http://127.0.0.1:8000/v1', customModel: 'whisper-local' }));
    const ready = html(source);
    expect(ready).toContain('value="http://127.0.0.1:8000/v1"');
    expect(ready).toContain('value="whisper-local"');
    expect(buttonTag(ready, 'Set API key…')).not.toContain('disabled');
  });

  it('tells which address was refused and keeps the saved one', async () => {
    const source = await started();
    await source.save(update({ source: 'custom', customBaseUrl: 'https://stt.example.test/v1', customModel: 'm' }));
    expect(await source.save(update({ source: 'custom', customBaseUrl: 'http://example.test/v1', customModel: 'm' }))).toBe(false);
    const body = html(source);
    expect(body).toContain('role="alert"');
    expect(body).toContain('Enter an HTTPS address. HTTP works only for this computer (localhost).');
    expect(body).toContain('value="https://stt.example.test/v1"');
  });

  it('shows a failure that no field owns as one notice', async () => {
    const source = await started({ keyEntry: true });
    await source.save(update({ source: 'openai' }));
    await source.setKey('custom', 'en');
    expect(source.error).toBe('invalid-url');
    // The custom fields are not on screen for OpenAI, so the failure is a notice.
    const body = html(source);
    expect(body).toContain('role="alert"');
    expect(body).toContain('Enter an HTTPS address.');
  });

  it('says where API keys can be entered when the host has no key dialog', async () => {
    const source = await started({ keyEntry: false });
    await source.save(update({ source: 'openai' }));
    const body = html(source);
    expect(body).toContain('API keys can be entered only on Windows in this version.');
    expect(body).not.toContain('Set API key…');
  });

  it('shows the Russian copy', async () => {
    const { loadRussian } = await import('../../features/locale/language');
    await loadRussian();
    setLanguage('ru');
    const source = await started();
    await source.save(update({ source: 'openai' }));
    const body = html(source);
    for (const text of ['Диктовка', 'Распознавание речи', 'Язык речи', 'Ключ API', 'Указать ключ API…']) expect(body).toContain(text);
  });
});
