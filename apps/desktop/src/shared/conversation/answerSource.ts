import { getContext, setContext } from 'svelte';
import type { TimelineBlock } from '../../host-api/types';
import { stripServiceMarkup } from './serviceMarkup';

/**
 * Where the full text of a shortened answer comes from. The transcript owns the
 * saved-history read and the loaded answers; a reply folded into a turn's process
 * reads the same source, so it shows the same notice and the same button.
 */
export interface AnswerSource {
  /** The full text once it was loaded. */
  full(blockId: string): string | undefined;
  busy(blockId: string): boolean;
  /** Whether the owner can read the saved history at all. */
  canLoad(): boolean;
  load(block: TimelineBlock): Promise<void>;
  /** The harness of the chat (`'codex'`, ...): service markup is removed only from the answers of the one that writes it. */
  harness?: string | undefined;
}

const ANSWER_CONTEXT = Symbol('piui.conversation.answers');
const none: AnswerSource = { full: () => undefined, busy: () => false, canLoad: () => false, load: async () => {} };

export function setAnswerSource(value: AnswerSource): void {
  setContext(ANSWER_CONTEXT, value);
}

export function useAnswerSource(): AnswerSource {
  return getContext<AnswerSource | undefined>(ANSWER_CONTEXT) ?? none;
}

/** The text of an assistant block as shown: the loaded full answer when there is one, without the harness's service markup. */
export function answerText(block: Pick<TimelineBlock, 'text' | 'status'>, full: string | undefined = undefined, harness: string | undefined = undefined): string {
  return stripServiceMarkup(full ?? block.text ?? '', block.status === 'streaming', harness);
}
