import { beforeEach, describe, expect, it, vi } from 'vitest';

const { embedded, external } = vi.hoisted(() => ({ embedded: vi.fn(), external: vi.fn() }));
vi.mock('../../host-api/siteBrowserClient', () => ({ openSiteBrowserLink: embedded }));
vi.mock('../../host-api/chatLinkClient', async (original) => ({
  ...await original<typeof import('../../host-api/chatLinkClient')>(),
  openChatLink: external,
}));
import { setLanguage } from '../../features/locale/language';
import { openLinkInHost } from './openChatLink';

beforeEach(() => {
  embedded.mockReset();
  external.mockReset();
  setLanguage('en');
});

describe('opening a chat link through the host', () => {
  it('opens the address in the built-in browser with the interface language', async () => {
    embedded.mockResolvedValue(true);
    setLanguage('ru');
    expect(await openLinkInHost('https://example.com/a')).toBe(true);
    expect(embedded).toHaveBeenCalledWith({ url: 'https://example.com/a', language: 'ru' });
    expect(external).not.toHaveBeenCalled();
  });

  it('uses the confirmed external route when the host has no built-in browser', async () => {
    embedded.mockResolvedValue(false);
    external.mockResolvedValue(true);
    expect(await openLinkInHost('https://example.com/')).toBe(true);
    expect(external).toHaveBeenCalledWith('https://example.com/', 'en');
  });

  it('keeps declined and invalid addresses on the copy fallback', async () => {
    embedded.mockRejectedValue({ code: 'UNAVAILABLE' });
    expect(await openLinkInHost('https://example.com/')).toBe(false);
    expect(await openLinkInHost('file:///test')).toBe(false);
    expect(embedded).toHaveBeenCalledTimes(1);
    expect(external).not.toHaveBeenCalled();
  });
});
