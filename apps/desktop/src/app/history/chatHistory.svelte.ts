import type { HarnessKind, WorkspaceSession } from '../../../../../contracts/workspace-v15';
import { parseTimestamp } from '../../host-api/projectsClient';
import type { AgentKind, SessionSummary } from '../../host-api/types';
import type { readWorkspaceHistory } from '../../host-api/workspaceHistory';
import { filterSessions } from './piHistory';

/**
 * Session history across harnesses. The native index covers Pi and Prime
 * Agent; every other harness is listed from the chats Nano Desktop started
 * (the workspace store) and read through `workspace_history_v1`, which never
 * starts a runtime. Nothing here translates one history format into another.
 */

/** Harnesses whose native session folders the host index scans. */
export type IndexedKind = 'pi' | 'prime-agent';

export const ALL_HARNESSES = 'all';
export type HistoryFilter = typeof ALL_HARNESSES | HarnessKind;

export type HistoryRow =
  | { readonly kind: 'index'; readonly id: string; readonly harness: IndexedKind; readonly time: number; readonly session: SessionSummary }
  | { readonly kind: 'chat'; readonly id: string; readonly harness: HarnessKind; readonly time: number; readonly chat: WorkspaceSession };

export type ChatBlocks = Awaited<ReturnType<typeof readWorkspaceHistory>>;
export type ReadChatHistory = (sessionId: string) => Promise<ChatBlocks>;

/** Personal chats and projects that are not Prime Agent index Pi sessions. */
export function indexedKindOf(agentKind: AgentKind | undefined): IndexedKind {
  return agentKind === 'prime-agent' ? 'prime-agent' : 'pi';
}

/**
 * Chats the native index does not already list. A chat of the indexed harness
 * lives in the app-owned session directory, outside the index's discovery
 * roots, so it stays listed. Only a chat adopted from an indexed terminal
 * session (placement `adopted`) is bound to a file the index lists: hiding it
 * avoids a duplicate row. A session carries no native id the UI could match
 * on, so an adopted chat whose placement has not loaded yet shows twice for a
 * moment, which beats hiding a desktop chat.
 */
export function otherHarnessChats(
  sessions: readonly WorkspaceSession[],
  indexedKind: IndexedKind,
  isAdopted: (sessionId: string) => boolean = () => false,
): WorkspaceSession[] {
  return sessions.filter((session) => session.harness !== indexedKind || !isAdopted(session.id));
}

function sortTime(time: number): number {
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function chatMatches(chat: WorkspaceSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || chat.title.toLocaleLowerCase().includes(needle);
}

/** Harness filter choices: only harnesses that have rows, the indexed one first. */
export function filterOptions(
  indexSessions: readonly SessionSummary[],
  chats: readonly WorkspaceSession[],
  indexedKind: IndexedKind,
): HarnessKind[] {
  const others = [...new Set(chats.map((chat) => chat.harness))].filter((harness) => harness !== indexedKind).sort();
  const hasIndexed = indexSessions.length > 0 || chats.some((chat) => chat.harness === indexedKind);
  return hasIndexed ? [indexedKind, ...others] : others;
}

/** Whether a row or cross-folder result of `harness` passes the harness filter. */
export function matchesFilter(filter: HistoryFilter, harness: HarnessKind): boolean {
  return filter === ALL_HARNESSES || filter === harness;
}

/** A filter whose harness has no rows any more falls back to all harnesses. */
export function effectiveFilter(filter: HistoryFilter, options: readonly HarnessKind[]): HistoryFilter {
  return filter !== ALL_HARNESSES && !options.includes(filter) ? ALL_HARNESSES : filter;
}

/** Index sessions and other harnesses' chats as one list, newest first. */
export function mergeRows(
  indexSessions: readonly SessionSummary[],
  chats: readonly WorkspaceSession[],
  filter: HistoryFilter,
  query: string,
  indexedKind: IndexedKind = 'pi',
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  if (filter === ALL_HARNESSES || filter === indexedKind) {
    for (const session of filterSessions(indexSessions, query)) {
      rows.push({ kind: 'index', id: session.id, harness: indexedKind, time: parseTimestamp(session.updatedAt ?? session.createdAt), session });
    }
  }
  for (const chat of chats) {
    if (!matchesFilter(filter, chat.harness) || !chatMatches(chat, query)) continue;
    rows.push({ kind: 'chat', id: chat.id, harness: chat.harness, time: parseTimestamp(chat.updatedAt), chat });
  }
  return rows.sort((left, right) => sortTime(right.time) - sortTime(left.time));
}

/** Shown when the host gives no message of its own; the view translates it. */
export const CHAT_HISTORY_FALLBACK = 'The workspace operation could not be completed.';

/**
 * Read-only transcript of one chat. Every request carries an epoch so a slow
 * response never replaces the chat the reader has since moved to or closed.
 */
export class ChatHistoryReader {
  sessionId = $state<string | undefined>();
  blocks = $state.raw<ChatBlocks>([]);
  loading = $state(false);
  error = $state<string | undefined>();

  private epoch = 0;

  constructor(private readonly read: ReadChatHistory) {}

  async open(sessionId: string): Promise<void> {
    const epoch = ++this.epoch;
    this.sessionId = sessionId;
    this.blocks = [];
    this.error = undefined;
    this.loading = true;
    try {
      const blocks = await this.read(sessionId);
      if (epoch !== this.epoch) return;
      this.blocks = blocks;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error = error instanceof Error && error.message ? error.message : CHAT_HISTORY_FALLBACK;
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  clear(): void {
    this.epoch += 1;
    this.sessionId = undefined;
    this.blocks = [];
    this.error = undefined;
    this.loading = false;
  }
}
