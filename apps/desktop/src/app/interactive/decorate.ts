import { get } from 'svelte/store';
import type { ConversationOwner } from '../../../../../contracts/conversation-presentation-v1';
import { renderFormula } from '../../components/formula';
import { language, t } from '../../features/locale/language';
import { createInteractiveFiles, type InteractiveFileSource, type InteractiveFiles } from './files';
import { composeReply } from './reply';
import type { IntelligentUiHost, IntelligentUiScope } from './renderer.js';

/** Why a widget cannot post a reply right now; `undefined` while it can. */
export type InteractiveReplyBlock = 'safe-mode' | 'closed' | 'busy' | 'no-prompt' | 'read-only';

/** The closed list of application actions a button in an answer may request (kept equal to the renderer's). */
export const INTERACTIVE_APP_TARGETS = ['open_settings', 'new_chat', 'open_schedule', 'open_agents'] as const;
export type InteractiveAppTarget = (typeof INTERACTIVE_APP_TARGETS)[number];

const isAppTarget = (target: string): target is InteractiveAppTarget => (INTERACTIVE_APP_TARGETS as readonly string[]).includes(target);

const BLOCK_TEXT: Readonly<Record<InteractiveReplyBlock, string>> = {
  'safe-mode': 'Safe mode is on. Answers cannot send messages.',
  closed: 'This chat is closed.',
  busy: 'The agent is still answering. Send is available when it finishes.',
  'no-prompt': 'This agent cannot take a new message here.',
  'read-only': 'Sending is not available here',
};

/** Only trusted application code supplies these operations; message JSON supplies content. */
export interface InteractiveDecorationOptions {
  /** The current way to post a reply, or `undefined` where the view cannot send. Read live. */
  reply: () => ((text: string) => Promise<boolean>) | undefined;
  /** Why a reply cannot be posted right now (read live): the real reason is shown on the disabled button. */
  replyBlock?: () => InteractiveReplyBlock | undefined;
  /** Opens an absolute https address in the system browser through the host. Without it, links copy their address. */
  openLink?: (url: string) => Promise<boolean>;
  /** Runs one action of the closed `INTERACTIVE_APP_TARGETS` list; true when it was done. */
  app?: (target: InteractiveAppTarget) => Promise<boolean>;
  /** The files of this chat an answer may show by name. Without it a `file` shows as missing. */
  files?: InteractiveFileSource;
  /** Short status text for the person (a copied link, a failed open). */
  notify?: (message: string) => void;
}

/** The message decoration, plus a way to tell every mounted answer that the host's own state changed. */
export type InteractiveDecorator = NonNullable<ConversationOwner['decorateMessage']> & { refresh(): void };

export function interactiveDecoration(options: InteractiveDecorationOptions): InteractiveDecorator {
  const live = new Set<() => void>();
  const decorate: NonNullable<ConversationOwner['decorateMessage']> = (element, block, signal) => {
    if (block.kind !== 'assistant' || signal.aborted) return undefined;
    let scope: IntelligentUiScope | undefined;
    let loaded: typeof import('./load') | undefined;
    let loading = false;
    let disposed = false;
    const files: InteractiveFiles | undefined = options.files === undefined ? undefined : createInteractiveFiles(options.files);
    const sendBlock = (): string | null => {
      const blocked = options.replyBlock?.();
      if (blocked !== undefined) return get(t)(BLOCK_TEXT[blocked]);
      return options.reply() === undefined ? get(t)(BLOCK_TEXT['read-only']) : null;
    };
    const host: IntelligentUiHost = {
      // Read live on every use: the view may start or finish a turn, or close, while the answer stays on screen.
      send: async (text: string, payload: string | null) => {
        if (sendBlock() !== null) return false;
        const post = options.reply();
        const message = composeReply(text, payload);
        return post !== undefined && message !== undefined ? post(message) : false;
      },
      sendBlock,
      copy: async text => {
        try { await navigator.clipboard.writeText(text); return true; }
        catch { return false; }
      },
      label: (key, args) => get(t)(key, args ?? []),
      renderFormula: (formula, tex, display) => { void renderFormula(formula, tex, display); },
      ...(options.openLink === undefined ? {} : {
        // The host asks the person before it opens anything. When it cannot ask, the address is copied instead.
        openLink: async (url: string) => {
          let handled = false;
          try { handled = (await options.openLink?.(url)) === true; }
          catch { handled = false; }
          if (handled) return true;
          const copied = (await host.copy?.(url)) === true;
          if (copied) options.notify?.(get(t)('Link copied. Open it in your browser.'));
          return copied;
        },
      }),
      ...(options.app === undefined ? {} : {
        app: async (target: string) => {
          const run = options.app;
          return run !== undefined && isAppTarget(target) ? run(target) : false;
        },
      }),
      ...(files === undefined ? {} : { resolveFile: (name: string) => files.resolve(name) }),
      ...(options.notify === undefined ? {} : { notify: options.notify }),
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
    function refresh(): void {
      if (!disposed && !signal.aborted) scope?.refresh();
    }
    // The widgets' own text is built when they are drawn: a language change (or the Russian catalog
    // arriving after it) rebuilds them with their state kept.
    let first = true;
    const stopLanguage = t.subscribe(() => {
      if (first) { first = false; return; }
      if (disposed || signal.aborted || scope === undefined) return;
      scope.rebuild();
      enhance();
    });
    const observer = new MutationObserver(enhance);
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      live.delete(refresh);
      stopLanguage();
      observer.disconnect();
      scope?.dispose();
      files?.dispose();
      signal.removeEventListener('abort', dispose);
    }
    live.add(refresh);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    signal.addEventListener('abort', dispose, { once: true });
    enhance();
    return { update: enhance, dispose };
  };
  return Object.assign(decorate, {
    refresh(): void {
      for (const run of [...live]) run();
    },
  });
}
