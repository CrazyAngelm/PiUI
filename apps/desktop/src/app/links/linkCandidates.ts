import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';

/** The longest text a person sends to a linked chat. */
export const MAX_LINK_MESSAGE = 16000;

/** The message is 1 to 16000 characters (code points) and not blank. */
export function validLinkMessage(text: string): boolean {
  const length = [...text].length;
  return length > 0 && length <= MAX_LINK_MESSAGE && text.trim().length > 0;
}

export interface CandidateOptions {
  /** The chat that is linking: never offered. */
  current: string;
  /** Chats already linked to it: never offered again. */
  linked: ReadonlySet<string>;
  /** Chats that cannot be linked (a Fusion sidekick). */
  excluded?: (sessionId: string) => boolean;
  query: string;
}

/**
 * The chats a person can link to `current`: the other chats of its project that
 * are not linked yet, filtered by the search text (case-insensitive, any part of the title).
 */
export function linkCandidates(sessions: readonly WorkspaceSession[], options: CandidateOptions): WorkspaceSession[] {
  const needle = options.query.trim().toLowerCase();
  return sessions.filter(
    (session) =>
      session.id !== options.current &&
      session.runId === undefined &&
      !options.linked.has(session.id) &&
      !(options.excluded?.(session.id) ?? false) &&
      (needle === '' || session.title.toLowerCase().includes(needle)),
  );
}
