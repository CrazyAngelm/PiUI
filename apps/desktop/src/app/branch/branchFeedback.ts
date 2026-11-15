import { toasts } from '../../lib/ui/toast.svelte';
import type { BranchResult } from './branchChat';

type Created = Extract<BranchResult, { ok: true }>;

export interface BranchFeedbackSink {
  show(input: { tone: 'neutral' | 'warning'; title: string; duration?: number; action?: { label: string; run: () => void } }): unknown;
}

/** What a person learns about the branch that was made, beyond the chat appearing: its kind, and that it was not opened for lack of room. */
export function announceBranch(
  result: Created,
  translate: (value: string, values?: readonly (string | number)[]) => string,
  open: (sessionId: string) => void,
  sink: BranchFeedbackSink = toasts,
): void {
  if (result.noRoom) {
    sink.show({
      tone: 'warning',
      title: translate('Four chats are on screen. The branch "{0}" was created but not opened.', [result.title]),
      duration: 10_000,
      action: { label: translate('Open'), run: () => open(result.sessionId) },
    });
  }
  if (result.mode === 'linked') {
    sink.show({
      tone: 'neutral',
      title: translate(
        result.empty
          ? 'Linked branch: it starts empty. The history was not copied.'
          : 'Linked branch: it starts from a summary. The history was not copied.',
      ),
    });
  }
}
