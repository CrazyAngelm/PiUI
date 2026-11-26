import { get } from 'svelte/store';
import { language } from '../../features/locale/language';
import { isChatLink, openChatLink } from '../../host-api/chatLinkClient';
import { openSiteBrowserLink } from '../../host-api/siteBrowserClient';

/** Opens a chat link in the local site browser. The caller offers to copy a refused link. */
export async function openLinkInHost(url: string): Promise<boolean> {
  if (!isChatLink(url)) return false;
  const hint = get(language) === 'ru' ? 'ru' : 'en';
  try {
    const opened = await openSiteBrowserLink({ url, language: hint });
    // Only an unsupported OS can use the separate, confirmed system-browser route.
    return opened === false ? openChatLink(url, hint) : opened === true;
  } catch {
    return false;
  }
}
