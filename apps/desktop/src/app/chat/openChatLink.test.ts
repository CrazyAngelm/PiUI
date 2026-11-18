import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('../../host-api/chatLinkClient', () => ({ openChatLink: open }));
import { setLanguage } from '../../features/locale/language';
import { openLinkInHost } from './openChatLink';

beforeEach(() => {
  open.mockReset();
  setLanguage('en');
});

describe('opening a chat link through the host', () => {
  it('passes the address and the interface language to the client', async () => {
    open.mockResolvedValue(true);
    expect(await openLinkInHost('https://example.com/')).toBe(true);
    expect(open).toHaveBeenLastCalledWith('https://example.com/', 'en');
    setLanguage('ru');
    open.mockResolvedValue(false);
    expect(await openLinkInHost('https://example.com/a')).toBe(false);
    expect(open).toHaveBeenLastCalledWith('https://example.com/a', 'ru');
    setLanguage('en');
  });
});
