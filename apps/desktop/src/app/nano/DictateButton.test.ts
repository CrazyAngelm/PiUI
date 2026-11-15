import { expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createRawSnippet, getAllContexts } from 'svelte';
import { Tooltip } from 'bits-ui';
import type { DictationSettingsV1 } from '../../host-api/dictationClient';
import DictateButton from './DictateButton.svelte';
import { DictationSource } from './dictationSource.svelte';

function view(source: DictationSettingsV1['source'], ready: 'openai' | 'groq' | 'custom' | undefined = undefined): DictationSettingsV1 {
  return {
    protocol: 1,
    source,
    language: null,
    providers: [
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe', keyRequired: true, keySet: ready === 'openai', ready: ready === 'openai' },
      { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyRequired: true, keySet: ready === 'groq', ready: ready === 'groq' },
      { id: 'custom', baseUrl: '', model: '', keyRequired: false, keySet: false, ready: ready === 'custom' },
    ],
    maxBytes: 20971520,
    keyEntry: true,
    safeMode: false,
  };
}

async function html(settings: DictationSettingsV1, canDictate: boolean): Promise<string> {
  const source = new DictationSource({ settings: async () => settings }, { canDictate, dictationMaxBytes: 5_000_000 });
  await source.start();
  const children = createRawSnippet(() => ({
    render: () => `<div>${render(DictateButton, { props: { onText: () => undefined, source }, context: getAllContexts() }).body}</div>`,
  }));
  return render(Tooltip.Provider, { props: { children } }).body;
}

it('offers dictation through a ready provider without a Nano sign-in', async () => {
  const body = await html(view('openai', 'openai'), false);
  expect(body).toContain('aria-label="Dictate"');
  expect(await html(view('groq', 'groq'), false)).toContain('aria-label="Dictate"');
  expect(await html(view('custom', 'custom'), false)).toContain('aria-label="Dictate"');
});

it('offers dictation through the Nano account when it allows it', async () => {
  expect(await html(view('nano'), true)).toContain('aria-label="Dictate"');
});

it('shows nothing for off, an unfinished provider, or Nano without an account', async () => {
  expect(await html(view('off'), true)).not.toContain('Dictate');
  expect(await html(view('openai'), true)).not.toContain('Dictate');
  expect(await html(view('nano'), false)).not.toContain('Dictate');
});
