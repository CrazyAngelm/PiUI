import { describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';
import type { SessionSummary } from '../../host-api/types';
import {
  ALL_HARNESSES,
  CHAT_HISTORY_FALLBACK,
  ChatHistoryReader,
  effectiveFilter,
  filterOptions,
  indexedKindOf,
  matchesFilter,
  mergeRows,
  otherHarnessChats,
  type ChatBlocks,
} from './chatHistory.svelte';

function chat(id: string, harness: WorkspaceSession['harness'], title: string, updatedAt: string): WorkspaceSession {
  return { id, workspaceId: 'w', harness, title, status: 'idle', updatedAt } as WorkspaceSession;
}

function indexed(id: string, title: string, updatedAt: string | undefined, preview?: string): SessionSummary {
  return { id, title, titleSource: 'pi-name', updatedAt, preview, entryCount: 3, parseState: 'healthy' } as SessionSummary;
}

const sessions = [
  chat('a', 'codex', 'Route host calls', '2026-11-10T10:00:00Z'),
  chat('b', 'pi', 'A Pi chat already in the index', '2026-11-10T12:00:00Z'),
  chat('c', 'claude-code', 'Map shortcuts', '2026-11-10T09:00:00Z'),
  chat('d', 'prime-agent', 'Prime chat', '2026-11-10T08:00:00Z'),
];
const index = [
  indexed('i1', 'Index old', '2026-11-10T07:00:00Z'),
  indexed('i2', 'Index new', '2026-11-10T11:00:00Z', 'mentions codex plans'),
  indexed('i3', 'Index undated', undefined),
];

const adoptedIds = new Set(['b']);
const isAdopted = (id: string) => adoptedIds.has(id);

describe('other harness chats', () => {
  it('keeps chats of the indexed harness, which live outside the native index', () => {
    expect(otherHarnessChats(sessions, 'pi').map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(otherHarnessChats(sessions, 'prime-agent').map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hides only a chat adopted from an indexed terminal session', () => {
    expect(otherHarnessChats(sessions, 'pi', isAdopted).map((item) => item.id)).toEqual(['a', 'c', 'd']);
    // An adopted flag on a chat of another harness than the indexed one changes nothing.
    expect(otherHarnessChats(sessions, 'prime-agent', isAdopted).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lists a desktop Pi chat of a project without indexed sessions', () => {
    const only = [chat('p', 'pi', 'Desktop Pi chat', '2026-11-10T10:00:00Z')];
    const chats = otherHarnessChats(only, 'pi', isAdopted);
    expect(mergeRows([], chats, ALL_HARNESSES, '').map((row) => [row.kind, row.id])).toEqual([['chat', 'p']]);
    expect(filterOptions([], chats, 'pi')).toEqual(['pi']);
  });

  it('maps a project agent to its indexed kind, defaulting to Pi', () => {
    expect(indexedKindOf('prime-agent')).toBe('prime-agent');
    expect(indexedKindOf('pi')).toBe('pi');
    expect(indexedKindOf(undefined)).toBe('pi');
  });
});

describe('merged rows', () => {
  const chats = otherHarnessChats(sessions, 'pi', isAdopted);

  it('merges both sources newest first with undated rows last', () => {
    const rows = mergeRows(index, chats, ALL_HARNESSES, '');
    expect(rows.map((row) => row.id)).toEqual(['i2', 'a', 'c', 'd', 'i1', 'i3']);
    expect(rows.map((row) => row.kind)).toEqual(['index', 'chat', 'chat', 'chat', 'index', 'index']);
    expect(rows[0]?.harness).toBe('pi');
  });

  it('keeps a desktop chat of the indexed harness next to its index rows', () => {
    const rows = mergeRows(index, otherHarnessChats(sessions, 'pi'), ALL_HARNESSES, '');
    expect(rows.map((row) => row.id)).toEqual(['b', 'i2', 'a', 'c', 'd', 'i1', 'i3']);
    expect(rows.find((row) => row.id === 'b')?.kind).toBe('chat');
  });

  it('keeps the indexed harness on index rows of a Prime project', () => {
    const rows = mergeRows(index, otherHarnessChats(sessions, 'prime-agent'), ALL_HARNESSES, '', 'prime-agent');
    expect(rows.filter((row) => row.kind === 'index').every((row) => row.harness === 'prime-agent')).toBe(true);
    expect(rows.find((row) => row.id === 'd')?.kind).toBe('chat');
  });

  it('narrows to one harness', () => {
    expect(mergeRows(index, chats, 'codex', '').map((row) => row.id)).toEqual(['a']);
    expect(mergeRows(index, chats, 'pi', '').map((row) => row.id)).toEqual(['i2', 'i1', 'i3']);
    expect(mergeRows(index, otherHarnessChats(sessions, 'pi'), 'pi', '').map((row) => row.id)).toEqual(['b', 'i2', 'i1', 'i3']);
    expect(mergeRows(index, chats, 'hermes', '')).toEqual([]);
  });

  it('matches a row to the harness filter', () => {
    expect(matchesFilter(ALL_HARNESSES, 'codex')).toBe(true);
    expect(matchesFilter('pi', 'pi')).toBe(true);
    expect(matchesFilter('pi', 'prime-agent')).toBe(false);
  });

  it('filters by title for chats and by title or preview for index rows', () => {
    expect(mergeRows(index, chats, ALL_HARNESSES, 'ROUTE').map((row) => row.id)).toEqual(['a']);
    expect(mergeRows(index, chats, ALL_HARNESSES, 'codex plans').map((row) => row.id)).toEqual(['i2']);
    expect(mergeRows(index, chats, ALL_HARNESSES, 'nothing like this')).toEqual([]);
  });

  it('accepts index sessions with unparsable times without throwing', () => {
    const rows = mergeRows([indexed('x', 'Bad time', 'not a date')], chats, ALL_HARNESSES, '');
    expect(rows.at(-1)?.id).toBe('x');
  });
});

describe('harness filter options', () => {
  it('lists only harnesses that have rows, the indexed one first', () => {
    expect(filterOptions(index, otherHarnessChats(sessions, 'pi', isAdopted), 'pi')).toEqual(['pi', 'claude-code', 'codex', 'prime-agent']);
    expect(filterOptions([], otherHarnessChats(sessions, 'pi', isAdopted), 'pi')).toEqual(['claude-code', 'codex', 'prime-agent']);
    expect(filterOptions([], otherHarnessChats(sessions, 'pi'), 'pi')).toEqual(['pi', 'claude-code', 'codex', 'prime-agent']);
    expect(filterOptions(index, [], 'pi')).toEqual(['pi']);
  });

  it('falls back to all harnesses when the chosen one has no rows left', () => {
    const options = filterOptions(index, otherHarnessChats(sessions, 'pi', isAdopted), 'pi');
    expect(effectiveFilter('codex', options)).toBe('codex');
    expect(effectiveFilter('hermes', options)).toBe(ALL_HARNESSES);
    expect(effectiveFilter(ALL_HARNESSES, options)).toBe(ALL_HARNESSES);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const block = (id: string) => ({ id }) as unknown as ChatBlocks[number];

describe('chat history reader', () => {
  it('reads a transcript through the injected host call', async () => {
    const reader = new ChatHistoryReader(async (id) => [block(`${id}-1`)]);
    const opening = reader.open('s1');
    expect(reader.sessionId).toBe('s1');
    expect(reader.loading).toBe(true);
    await opening;
    expect(reader.loading).toBe(false);
    expect(reader.error).toBeUndefined();
    expect(reader.blocks.map((item) => item.id)).toEqual(['s1-1']);
  });

  it('reports the host message, or a generic one', async () => {
    const reader = new ChatHistoryReader(async () => {
      throw new Error('This workspace or session is no longer available.');
    });
    await reader.open('s1');
    expect(reader.error).toBe('This workspace or session is no longer available.');
    expect(reader.blocks).toEqual([]);
    expect(reader.loading).toBe(false);
    const opaque = new ChatHistoryReader(async () => {
      throw 'boom';
    });
    await opaque.open('s2');
    expect(opaque.error).toBe(CHAT_HISTORY_FALLBACK);
  });

  it('ignores a stale response after another chat was opened', async () => {
    const first = deferred<ChatBlocks>();
    const second = deferred<ChatBlocks>();
    const reader = new ChatHistoryReader((id) => (id === 's1' ? first.promise : second.promise));
    const one = reader.open('s1');
    const two = reader.open('s2');
    second.resolve([block('two')]);
    await two;
    first.resolve([block('one')]);
    await one;
    expect(reader.sessionId).toBe('s2');
    expect(reader.blocks.map((item) => item.id)).toEqual(['two']);
    expect(reader.loading).toBe(false);
  });

  it('ignores a stale error and a response that arrives after clear', async () => {
    const slow = deferred<ChatBlocks>();
    const reader = new ChatHistoryReader(() => slow.promise);
    const opening = reader.open('s1');
    reader.clear();
    slow.reject(new Error('late'));
    await opening;
    expect(reader.sessionId).toBeUndefined();
    expect(reader.error).toBeUndefined();
    expect(reader.blocks).toEqual([]);
    expect(reader.loading).toBe(false);
  });
});
