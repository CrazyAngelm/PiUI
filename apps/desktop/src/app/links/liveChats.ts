import type { SessionStatus } from '../../../../../contracts/workspace-v15';
import type { LinkedChatStateV1, LinkedChatV1 } from '../../host-api/sessionLinksClient';

const STATE: Readonly<Record<SessionStatus, LinkedChatStateV1>> = {
  starting: 'starting',
  idle: 'idle',
  running: 'running',
  stopping: 'running',
  closed: 'closed',
  failed: 'failed',
};

type CatalogSession = { id: string; title: string; status: SessionStatus };

/**
 * The linked chats with the state and title the workspace catalog has now. The links cache refreshes only when a link
 * or a queue changes, so a peer that finished, failed or was renamed would keep its old row. A chat the catalog does
 * not list keeps the cached values.
 */
export function liveChats(chats: readonly LinkedChatV1[], sessions: readonly CatalogSession[]): LinkedChatV1[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return chats.map((chat) => {
    const live = byId.get(chat.sessionId);
    return live === undefined ? chat : { ...chat, title: live.title || chat.title, state: STATE[live.status] };
  });
}
