import { describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';
import { linkCandidates, validLinkMessage } from './linkCandidates';

const session = (id: string, title: string, runId?: string): WorkspaceSession => ({ id, title, ...(runId === undefined ? {} : { runId }) }) as WorkspaceSession;
const sessions = [session('a', 'Plan a trip'), session('b', 'Cache sizing'), session('c', 'Cache audit'), session('d', 'Member', 'run-1'), session('e', 'Sidekick')];

describe('link candidates', () => {
  it('excludes the current chat, linked chats, pipeline members and excluded chats', () => {
    const ids = linkCandidates(sessions, { current: 'a', linked: new Set(['c']), excluded: (id) => id === 'e', query: '' }).map((item) => item.id);
    expect(ids).toEqual(['b']);
  });

  it('filters by any part of the title, ignoring case and outer spaces', () => {
    const options = { current: 'a', linked: new Set<string>(), query: '  CACHE ' };
    expect(linkCandidates(sessions, options).map((item) => item.id)).toEqual(['b', 'c']);
    expect(linkCandidates(sessions, { ...options, query: 'audit' }).map((item) => item.id)).toEqual(['c']);
    expect(linkCandidates(sessions, { ...options, query: 'nothing' })).toEqual([]);
  });
});

describe('message length', () => {
  it('accepts 1 to 16000 characters and refuses blank text', () => {
    expect(validLinkMessage('')).toBe(false);
    expect(validLinkMessage('  \n ')).toBe(false);
    expect(validLinkMessage('x')).toBe(true);
    expect(validLinkMessage('x'.repeat(16000))).toBe(true);
    expect(validLinkMessage('x'.repeat(16001))).toBe(false);
    expect(validLinkMessage('😀'.repeat(16000))).toBe(true);
  });
});
