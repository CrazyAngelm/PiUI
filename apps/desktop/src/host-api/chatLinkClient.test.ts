import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: vi.fn(), desktopAvailable: true }));
import { CHAT_LINK_MAX_BYTES, CHAT_LINK_ROUTE, isChatLink, openChatLink } from './chatLinkClient';

beforeEach(() => {
  invoke.mockReset();
});

describe('chat links client', () => {
  it('sends the address and the wording language to the host route and reports an answered question', async () => {
    invoke.mockResolvedValue({ opened: true });
    expect(await openChatLink('https://example.com/docs?q=1#top', 'ru')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(CHAT_LINK_ROUTE, { request: { url: 'https://example.com/docs?q=1#top', language: 'ru' } });
    expect(CHAT_LINK_ROUTE).toBe('chat_open_link_v1');
  });

  it('treats a No as handled, so the address is not copied', async () => {
    invoke.mockResolvedValue({ opened: false });
    expect(await openChatLink('http://example.com/')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(CHAT_LINK_ROUTE, { request: { url: 'http://example.com/', language: 'en' } });
  });

  it('reports false when the host refuses, fails or answers outside the contract', async () => {
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE' });
    expect(await openChatLink('https://example.com/')).toBe(false);
    invoke.mockRejectedValueOnce(new Error('boom'));
    expect(await openChatLink('https://example.com/')).toBe(false);
    for (const answer of [undefined, null, {}, { opened: 'yes' }, 'opened']) {
      invoke.mockResolvedValueOnce(answer);
      expect(await openChatLink('https://example.com/')).toBe(false);
    }
  });

  it('never sends an address the host would refuse', async () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,hi', 'mailto:a@example.com', '/relative', '', 'https://example.com/a b', 'https://' + 'u:p' + '@example.com/', `https://example.com/${'a'.repeat(CHAT_LINK_MAX_BYTES)}`]) {
      expect(await openChatLink(url)).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts web addresses of both schemes, an international host and the longest allowed address', () => {
    const prefix = 'https://example.com/';
    for (const url of ['https://example.com/', 'http://example.com:8080/a', 'https://пример.рф/путь', `${prefix}${'a'.repeat(CHAT_LINK_MAX_BYTES - prefix.length)}`]) {
      expect(isChatLink(url), url).toBe(true);
    }
  });
});
