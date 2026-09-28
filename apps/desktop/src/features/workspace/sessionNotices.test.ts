import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WorkspaceEvent } from '../../../../../contracts/workspace-v15';
import { boardToolNotice, sessionNotices, withNotice } from './sessionNotices';
import { applyWorkspaceEvent } from './workspaceState';

function snapshot(extra: Record<string, unknown> = {}): SessionSnapshot {
  return {
    revision: 4,
    session: { id: 'session-a', workspaceId: 'project-a', harness: 'codex', title: 'Review', status: 'idle', updatedAt: '2026-09-28T10:00:00Z' },
    blocks: [],
    approvals: [],
    capabilities: {
      prompt: { supported: true, enforcement: 'native' },
      resume: { supported: true, enforcement: 'native' },
      models: { supported: true, enforcement: 'native' },
      approvals: { supported: true, enforcement: 'native' },
      instructions: { supported: false, enforcement: 'unsupported' },
      toolPolicy: { supported: false, enforcement: 'unsupported' },
      nativeSubagents: { supported: false, enforcement: 'unsupported' },
    },
    models: [],
    ...extra,
  } as SessionSnapshot;
}

describe('session notices', () => {
  it('reads known codes from a snapshot and ignores unknown or malformed ones', () => {
    expect(sessionNotices(undefined)).toEqual([]);
    expect(sessionNotices(snapshot())).toEqual([]);
    expect(sessionNotices(snapshot({ notices: 'unsupported-board-tool' }))).toEqual([]);
    expect(sessionNotices(snapshot({ notices: ['unsupported-board-tool-resume', 'future-code', 7, 'unsupported-board-tool-resume'] })))
      .toEqual(['unsupported-board-tool-resume']);
  });

  it('applies a notice event without touching the transcript', () => {
    const current = snapshot();
    const incoming = { protocol: 15, sessionId: 'session-a', revision: 5, event: { type: 'notice', code: 'unsupported-board-tool' } } as unknown as WorkspaceEvent;
    const result = applyWorkspaceEvent(current, incoming);
    expect(result.type).toBe('applied');
    expect(result.snapshot.revision).toBe(5);
    expect(result.snapshot.blocks).toBe(current.blocks);
    expect(sessionNotices(result.snapshot)).toEqual(['unsupported-board-tool']);
    // The same notice twice is kept once.
    expect(withNotice(result.snapshot, 'unsupported-board-tool')).toBe(result.snapshot);
  });

  it('shows the board-tool notice for reported codes and for Pi chats', () => {
    expect(boardToolNotice('codex', [])).toBeUndefined();
    expect(boardToolNotice('claude-code', ['unsupported-board-tool'])).toBe('unsupported-board-tool');
    expect(boardToolNotice('codex', ['unsupported-board-tool', 'unsupported-board-tool-resume'])).toBe('unsupported-board-tool-resume');
    expect(boardToolNotice('pi', [])).toBe('unsupported-board-tool');
  });
});
