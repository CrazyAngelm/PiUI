import { getContext, setContext, type Component } from 'svelte';
import type { TimelineBlock } from '../../host-api/types';

export interface ConversationRenderer {
  key: string;
  title: string;
  source: string;
  component: Component<{ block: TimelineBlock; onFailure: () => void }>;
}

export interface ConversationPresentation {
  notify: (level: 'success' | 'error', message: string) => void;
  /** Only the native wrapper supplies trusted native plugin frames. */
  renderer?: (block: TimelineBlock) => ConversationRenderer | undefined;
}

const PRESENTATION_CONTEXT = Symbol('piui.conversation.presentation');
const plain: ConversationPresentation = { notify() {} };
export function setConversationPresentation(value: ConversationPresentation): void { setContext(PRESENTATION_CONTEXT, value); }
export function useConversationPresentation(): ConversationPresentation { return getContext<ConversationPresentation | undefined>(PRESENTATION_CONTEXT) ?? plain; }
