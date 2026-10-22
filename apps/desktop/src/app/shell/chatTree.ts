import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';

/** A sidebar chat with the chats nested under it (a Fusion lead's sidekicks). */
export interface ChatTreeItem {
  session: WorkspaceSession;
  children: WorkspaceSession[];
}

/**
 * Nests every chat whose parent (`parentOf`) is in the same list under that
 * parent, keeping list order; a chat whose parent is not listed stays on top.
 */
export function chatTree(sessions: readonly WorkspaceSession[], parentOf: (sessionId: string) => string | undefined): ChatTreeItem[] {
  const listed = new Set(sessions.map((session) => session.id));
  const children = new Map<string, WorkspaceSession[]>();
  const top: WorkspaceSession[] = [];
  for (const session of sessions) {
    const parent = parentOf(session.id);
    if (parent !== undefined && parent !== session.id && listed.has(parent) && parentOf(parent) === undefined) {
      const list = children.get(parent) ?? [];
      list.push(session);
      children.set(parent, list);
    } else {
      top.push(session);
    }
  }
  return top.map((session) => ({ session, children: children.get(session.id) ?? [] }));
}
