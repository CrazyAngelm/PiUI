import { mount, unmount, tick } from 'svelte';
import type { ConversationHandle, ConversationOptions } from '../../../contracts/conversation-presentation-v1';
import ConversationSurface from '../../../apps/desktop/src/shared/conversation/ConversationSurface.svelte';
import { ConversationController } from '../../../apps/desktop/src/shared/conversation/conversationController.svelte';
import { TRANSLATION_CONTEXT } from '../../../apps/desktop/src/features/locale/context';
import { createConversationTranslation } from './conversationLocale';
import '../../../apps/desktop/src/styles/tokens.css';
import './island.css';
import './conversation.css';
import '../../../apps/desktop/src/shared/composer/composer.css';

export { attachComposer, resizeComposer } from '../../../apps/desktop/src/shared/composer/composer';
export type { ComposerOptions, ComposerHandle, ComposerRows } from '../../../contracts/composer-presentation-v1';

export type { ConversationHandle, ConversationOptions, ConversationOwner, ConversationSnapshot, ConversationIdentity } from '../../../contracts/conversation-presentation-v1';
const mounted = new WeakSet<HTMLElement>();
const appearances = new Set(['light', 'dark', 'system']);

/** Display existing owner projections. This module owns neither history nor transport. */
export function mountConversation(target: HTMLElement, options: ConversationOptions): ConversationHandle {
  if (options.contractVersion !== 1 || !['en', 'ru'].includes(options.language) || !appearances.has(options.appearance ?? 'system') || !['interactive', 'print'].includes(options.mode ?? 'interactive')) throw new Error('Unsupported conversation presentation contract.');
  if (mounted.has(target) || target.childNodes.length) throw new Error('The conversation needs an empty, unmounted element.');
  const controller = new ConversationController(options.owner, options.snapshot);
  const root = target.ownerDocument.createElement('div');
  root.className = 'nano-conversation-root';
  root.dataset.nanoUi = 'conversation-v1';
  root.dataset.mode = options.mode ?? 'interactive';
  root.dataset.style = 'nano';
  root.dataset.theme = options.appearance ?? 'system';
  root.dataset.reducedMotion = 'system';
  root.lang = options.language;
  target.append(root);
  let component: ReturnType<typeof mount>;
  try { component = mount(ConversationSurface, { target: root, props: { controller, language: options.language, agentLabel: options.agentLabel, portalTarget: root, printMode: options.mode === 'print', announceMessages: options.announceMessages }, context: new Map([[TRANSLATION_CONTEXT, createConversationTranslation(options.language)]]) }); }
  catch (error) { controller.dispose(); root.remove(); throw error; }
  mounted.add(target);
  let disposed = false;
  return {
    async ready() { await tick(); if (disposed) throw new DOMException('Conversation disposed.', 'AbortError'); },
    async scrollToEnd(force, smooth) {
      if (disposed) return false;
      const generation = controller.generation;
      await tick();
      return !disposed && generation === controller.generation && await component.scrollToEnd(force, smooth);
    },
    update(identity, snapshot) { controller.update(identity, snapshot); },
    setOwner(owner, snapshot) { controller.setOwner(owner, snapshot); },
    setAppearance(value) {
      if (!appearances.has(value)) throw new Error('Unsupported conversation appearance.');
      if (!disposed) root.dataset.theme = value;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      await unmount(component);
      root.remove();
      mounted.delete(target);
    },
  };
}
