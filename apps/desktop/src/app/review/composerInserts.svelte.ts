import { appendToDraft } from './review';

/** The draft the workspace store keeps for each chat. */
export interface Drafts {
  draftFor(key: string): string;
  updateDraft(key: string, text: string): void;
}

/**
 * Text PiUI adds to a chat's draft (a line comment from the review panel).
 * It is appended to what the person already typed and never sent; the epoch
 * change remounts the chat composer with the new draft.
 */
export class ComposerInserts {
  epochs = $state.raw<Readonly<Record<string, number>>>({});

  epoch(sessionId: string): number {
    return this.epochs[sessionId] ?? 0;
  }

  insert(drafts: Drafts, sessionId: string, text: string): void {
    drafts.updateDraft(sessionId, appendToDraft(drafts.draftFor(sessionId), text));
    this.epochs = { ...this.epochs, [sessionId]: this.epoch(sessionId) + 1 };
  }
}

export const composerInserts = new ComposerInserts();
