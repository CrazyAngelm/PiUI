import { get } from 'svelte/store';
import type { ConversationOwner } from '../../../../../contracts/conversation-presentation-v1';
import { language, t } from '../../features/locale/language';
import { composeReply } from './reply';
import type { IntelligentUiHost, IntelligentUiScope } from './renderer.js';

/** Only trusted application code supplies the host operations; message JSON supplies content. */
export function interactiveDecoration(options: { reply: () => ((text: string) => Promise<boolean>) | undefined }): NonNullable<ConversationOwner['decorateMessage']> {
  return (element, block, signal) => {
    if (block.kind !== 'assistant' || signal.aborted) return undefined;
    let scope: IntelligentUiScope | undefined;
    let loaded: typeof import('./load') | undefined;
    let loading = false;
    let disposed = false;
    const host: IntelligentUiHost = {
      ...(options.reply() === undefined ? {} : { send: async (text: string, payload: string | null) => {
        const post = options.reply();
        const message = composeReply(text, payload);
        return post !== undefined && message !== undefined ? post(message) : false;
      } }),
      copy: async text => {
        try { await navigator.clipboard.writeText(text); return true; }
        catch { return false; }
      },
      label: (key, args) => get(t)(key, args ?? []),
    };
    function enhance(): void {
      if (disposed || signal.aborted) return;
      if (scope && loaded) {
        loaded.setIntelligentUiLocale(get(language) === 'ru' ? 'ru-RU' : 'en-US');
        scope.enhance(element, host);
      } else if (!loading && element.querySelector('pre > code.language-hermes-ui')) {
        loading = true;
        void import('./load').then(module => {
          if (disposed || signal.aborted) return;
          loaded = module;
          scope = module.createIntelligentUiScope();
          enhance();
        }).catch(() => {
          // A failed lazy load leaves the original code readable; a later update may retry.
        }).finally(() => { loading = false; });
      }
    }
    const observer = new MutationObserver(enhance);
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      scope?.dispose();
      signal.removeEventListener('abort', dispose);
    }
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    signal.addEventListener('abort', dispose, { once: true });
    enhance();
    return { update: enhance, dispose };
  };
}
