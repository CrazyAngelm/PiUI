import { CHAT_LINK_MAX_BYTES, type ChatLinkErrorCode, type ChatOpenLinkResultV1 } from '../../../../../contracts/chat-link-v1';
import { get } from 'svelte/store';
import { toasts } from '../../lib/ui/toast.svelte';
import { t } from '../../features/locale/language';
import type { LabHandlers } from './labHandlers';
import { decodeArgument, enumOf, object, option, string } from './labSchema';
import type { LabState } from './labState';

/**
 * Chat links v1 (`chat_open_link_v1`, ADR-075) for the UI Lab. The host asks the person in a native
 * dialog and opens the system browser; a browser tab has neither, so the Lab validates the address
 * the way the host does, opens nothing, and shows a toast "Would open <host>". Every call is
 * recorded on `window.__piuiLabChatLinks` for the e2e specs.
 */
export interface LabChatLinksRecord {
  calls: { url: string; host: string }[];
}

declare global {
  interface Window {
    /** Read by Playwright; the Lab is the only writer. */
    __piuiLabChatLinks?: LabChatLinksRecord;
  }
}

const requestSchema = object({ url: string, language: option(enumOf(['en', 'ru'])) });

const refusal = (code: ChatLinkErrorCode): { readonly code: ChatLinkErrorCode } => ({ code });

/** `validate_link`: http(s) with a host, no credentials, at most 2048 bytes, no whitespace or control character. */
function validLink(value: string): URL | undefined {
  if (value === '' || new TextEncoder().encode(value).length > CHAT_LINK_MAX_BYTES || /[\s\p{Cc}]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const web = url.protocol === 'https:' || url.protocol === 'http:';
  return web && url.host !== '' && url.username === '' && url.password === '' ? url : undefined;
}

export function chatLinkHandlers(state: LabState): LabHandlers {
  return {
    chat_open_link_v1: (args): ChatOpenLinkResultV1 => {
      const request = decodeArgument<{ url: string; language?: 'en' | 'ru' | null }>(args, 'request', requestSchema);
      if (state.safeMode) throw refusal('SAFE_MODE');
      const url = validLink(request.url);
      if (url === undefined) throw refusal('INVALID_LINK');
      if (typeof window !== 'undefined') {
        const record = (window.__piuiLabChatLinks ??= { calls: [] });
        record.calls.push({ url: url.href, host: url.hostname });
      }
      toasts.show({ title: get(t)('Would open {0}', [url.hostname]) });
      return { opened: false };
    },
  };
}
