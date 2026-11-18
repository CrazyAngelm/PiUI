import { CHAT_LINK_MAX_BYTES, CHAT_LINK_ROUTE, type ChatOpenLinkRequestV1, type ChatOpenLinkResultV1 } from '../../../../contracts/chat-link-v1';
import { hostInvoke } from './transport';

export type * from '../../../../contracts/chat-link-v1';
export { CHAT_LINK_MAX_BYTES, CHAT_LINK_ROUTE } from '../../../../contracts/chat-link-v1';

/**
 * Client of chat links v1 (ADR-075). The host re-validates the address and asks the person in a
 * native dialog; this only forwards it. An address the host would refuse anyway is not sent.
 */
export function isChatLink(url: string): boolean {
  if (url === '' || new TextEncoder().encode(url).length > CHAT_LINK_MAX_BYTES || /[\s\p{Cc}]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host !== '' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function isResult(value: unknown): value is ChatOpenLinkResultV1 {
  return typeof value === 'object' && value !== null && typeof (value as { opened?: unknown }).opened === 'boolean';
}

/**
 * Asks the host to open `url` after the person confirms it. Resolves `true` once the person has
 * answered (Yes opened it, No did nothing) and `false` when the host could not ask or open it
 * (safe mode, a refused address, a dialog already open, no browser): the caller copies the
 * address instead.
 */
export async function openChatLink(url: string, language: 'en' | 'ru' = 'en'): Promise<boolean> {
  if (!isChatLink(url)) return false;
  const request: ChatOpenLinkRequestV1 = { url, language };
  try {
    return isResult(await hostInvoke<unknown>(CHAT_LINK_ROUTE, { request }));
  } catch {
    return false;
  }
}
