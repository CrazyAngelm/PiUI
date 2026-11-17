import { get } from 'svelte/store';
import { language } from '../../features/locale/language';
import { openChatLink } from '../../host-api/chatLinkClient';

/**
 * Opens a link of a chat message through the host (ADR-075): the host asks the person in a native
 * dialog and opens the browser only on Yes. Resolves `false` when the host could not ask, and the
 * caller copies the address instead.
 */
export function openLinkInHost(url: string): Promise<boolean> {
  return openChatLink(url, get(language) === 'ru' ? 'ru' : 'en');
}
