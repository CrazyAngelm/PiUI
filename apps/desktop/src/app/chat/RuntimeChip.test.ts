// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeSettings } from '../../../../../contracts/workspace-settings-v16';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';
import { language } from '../../features/locale/language';

// Vitest resolves `svelte` to its server build, which cannot mount: take the browser one.
const mocks = vi.hoisted(() => ({ runtimeSettings: vi.fn() }));
vi.mock('svelte', () => import(/* @vite-ignore */ join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js')));
vi.mock('../../host-api/runtimeSettings', () => ({
  runtimeSettings: mocks.runtimeSettings,
  onRuntimeSettingsSet: () => () => {},
}));

const { flushSync, mount, unmount } = await import('svelte');
const { default: RuntimeChip } = await import('./RuntimeChip.svelte');

const PI = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const model = (levels: string[]) => ({ id: 'gpt-6.2-sol', provider: 'cpamc', name: 'GPT 6.2 Sol', thinkingLevels: levels });

function settings(levels: string[], thinkingLevel: string): RuntimeSettings {
  return { protocol: 16, sessionId: 'chat-1', model: model(levels), models: [model(levels)], thinkingLevel, serviceTier: null };
}

const session = { id: 'chat-1', harness: 'pi', status: 'idle', model: model(PI) } as unknown as WorkspaceSession;
const mounted: Array<ReturnType<typeof mount>> = [];

/** The reasoning text next to the model name on the composer chip. */
async function chipText(levels: string[], thinkingLevel: string): Promise<string> {
  mocks.runtimeSettings.mockResolvedValue(settings(levels, thinkingLevel));
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(RuntimeChip, { target, props: { session } }));
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
    flushSync();
  }
  return target.querySelector('.chip__sub')?.textContent?.trim() ?? '';
}

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
  mocks.runtimeSettings.mockReset();
  language.set('en');
});

describe('the composer chip names the reasoning level', () => {
  it('shows xhigh and max apart from High for a model whose levels end in them', async () => {
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    expect(await chipText(levels, 'high')).toBe('High');
    expect(await chipText(levels, 'xhigh')).toBe('Extra high');
    expect(await chipText(PI, 'max')).toBe('Max');
  });

  it('names the same levels in Russian without folding them into Высокое', async () => {
    language.set('ru');
    expect(await chipText(PI, 'high')).toBe('Высокое');
    expect(await chipText(PI, 'xhigh')).toBe('Очень высокое');
    expect(await chipText(PI, 'max')).toBe('Максимальное');
  });

  it('shows a level it has no name for as the harness wrote it', async () => {
    expect(await chipText(['off', 'turbo'], 'turbo')).toBe('turbo');
  });
});
