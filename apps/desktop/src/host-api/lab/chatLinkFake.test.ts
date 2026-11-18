// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { toasts } from '../../lib/ui/toast.svelte';
import { setLanguage } from '../../features/locale/language';
import { labHost, rejection } from './labTestKit';

const open = (host: ReturnType<typeof labHost>, request: Record<string, unknown>) => host.invoke<{ opened: boolean }>('chat_open_link_v1', { request });
const code = async (promise: Promise<unknown>): Promise<unknown> => ((await rejection(promise)) as { code?: unknown }).code;

afterEach(() => {
  for (const toast of [...toasts.items]) toasts.dismiss(toast.id);
  delete window.__piuiLabChatLinks;
  setLanguage('en');
});

describe('UI Lab chat links', () => {
  it('opens nothing, records the call and says which site it would open', async () => {
    const host = labHost();
    expect(await open(host, { url: 'https://example.com/docs?q=1', language: 'en' })).toEqual({ opened: false });
    expect(window.__piuiLabChatLinks?.calls).toEqual([{ url: 'https://example.com/docs?q=1', host: 'example.com' }]);
    expect(toasts.items.map((toast) => toast.title)).toEqual(['Would open example.com']);
  });

  it('says it in Russian when the interface is Russian', async () => {
    setLanguage('ru');
    await open(labHost(), { url: 'http://example.com/' });
    expect(toasts.items.map((toast) => toast.title)).toEqual(['Откроется example.com']);
  });

  it('refuses what the host refuses', async () => {
    const host = labHost();
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hi', 'mailto:a@example.com', 'https://' + 'u' + ':p' + '@example.com/', `https://example.com/${'a'.repeat(2048)}`, 'https://example.com/a b', '']) {
      expect(await code(open(host, { url }))).toBe('INVALID_LINK');
    }
    expect(window.__piuiLabChatLinks).toBeUndefined();
    expect(toasts.items).toEqual([]);
  });

  it('accepts an international host and refuses safe mode and unknown fields', async () => {
    expect(await open(labHost(), { url: 'https://пример.рф/путь' })).toEqual({ opened: false });
    expect(await code(open(labHost('safe'), { url: 'https://example.com/' }))).toBe('SAFE_MODE');
    await expect(open(labHost(), { url: 'https://example.com/', path: 'C:/x' })).rejects.toBeTruthy();
  });
});
