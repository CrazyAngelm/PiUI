import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WorkspaceApproval, WorkspaceEvent } from '../../../../../contracts/workspace-v15';
import { acceptWorkspaceSnapshot, applyWorkspaceEvent, harnessLabel, mergeCatalogSession, protectClosedCatalogSessions, resolveCloseAfterCatalog, retainSnapshotWithCatalogSession, sortedSessions } from './workspaceState';

function snapshot(revision = 4): SessionSnapshot {
  return {
    revision,
    session: {
      id: 'session-a', workspaceId: 'project-a', harness: 'codex', title: 'Review',
      status: 'running', updatedAt: '2026-03-01T10:00:00Z',
    },
    blocks: [{ id: 'assistant-1', kind: 'assistant', label: 'Codex', text: 'Start', status: 'streaming' }],
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
  };
}

function event(revision: number, value: WorkspaceEvent['event']): WorkspaceEvent {
  return { protocol: 15, sessionId: 'session-a', revision, event: value };
}

describe('workspace event revision handling', () => {
  it('discards stale or duplicate events without changing the snapshot', () => {
    const current = snapshot();
    const result = applyWorkspaceEvent(current, event(4, { type: 'textDelta', blockId: 'assistant-1', text: ' old' }));
    expect(result.type).toBe('stale');
    expect(result.snapshot).toBe(current);
  });

  it('requires a host snapshot when an event revision has a gap', () => {
    const current = snapshot();
    const result = applyWorkspaceEvent(current, event(7, { type: 'textDelta', blockId: 'assistant-1', text: ' skipped' }));
    expect(result).toMatchObject({ type: 'gap', expectedRevision: 5, receivedRevision: 7 });
    expect(result.snapshot.blocks[0]?.text).toBe('Start');
  });

  it('requests a snapshot when a delta references a block that was not observed', () => {
    const result = applyWorkspaceEvent(snapshot(), event(5, { type: 'textDelta', blockId: 'missing-block', text: 'orphan' }));
    expect(result).toMatchObject({ type: 'gap', reason: 'missing-block' });
    expect(result.snapshot.revision).toBe(4);
  });

  it('applies a contiguous delta once and advances the revision', () => {
    const result = applyWorkspaceEvent(snapshot(), event(5, { type: 'textDelta', blockId: 'assistant-1', text: ' here' }));
    expect(result.type).toBe('applied');
    expect(result.snapshot.revision).toBe(5);
    expect(result.snapshot.blocks[0]?.text).toBe('Start here');
  });

  it('keeps approval identity exact and removes only the resolved request', () => {
    const approval: WorkspaceApproval = {
      id: 'request-1', sessionId: 'session-a', kind: 'file-change' as const,
      title: 'Change file', description: 'Change one workspace file.', decisions: ['approve-once', 'deny'],
    };
    const added = applyWorkspaceEvent(snapshot(), event(5, { type: 'approval', approval }));
    expect(added.snapshot.approvals).toEqual([approval]);
    const resolved = applyWorkspaceEvent(added.snapshot, event(6, { type: 'approvalResolved', requestId: 'request-1' }));
    expect(resolved.snapshot.approvals).toEqual([]);
  });
});

describe('workspace catalog projections', () => {
  it('updates one session without dropping unrelated native sessions', () => {
    const first = snapshot().session;
    const other = { ...first, id: 'session-b', harness: 'pi' as const };
    const catalog = {
      protocol: 15 as const, safeMode: false, workspaces: [], harnesses: [], sessions: [first, other],
    };
    const merged = mergeCatalogSession(catalog, { ...first, status: 'idle' });
    expect(merged.sessions).toHaveLength(2);
    expect(merged.sessions[0]?.status).toBe('idle');
    expect(merged.sessions[1]).toBe(other);
  });

  it('keeps the authoritative close watermark against late idle and approval events until an explicit reopen snapshot', () => {
    const approval = {
      id: 'request-before-close', sessionId: 'session-a', kind: 'permission' as const,
      title: 'Old permission', description: 'From the disposed runtime generation.', decisions: ['deny'] as const,
    };
    const current: SessionSnapshot = { ...snapshot(), approvals: [{ ...approval, decisions: [...approval.decisions] }] };
    const closedRow = { ...current.session, status: 'closed' as const, updatedAt: '2026-03-03T10:00:00Z' };
    const closed = retainSnapshotWithCatalogSession(current, closedRow);

    expect(closed.session.status).toBe('closed');
    expect(closed.approvals).toEqual([]);
    expect(closed.blocks).toBe(current.blocks);
    expect(closed.capabilities).toBe(current.capabilities);
    expect(closed.revision).toBe(current.revision);

    const lateIdle = applyWorkspaceEvent(closed, event(5, { type: 'session', session: { ...closedRow, status: 'idle' } }));
    expect(lateIdle.type).toBe('stale');
    expect(lateIdle.snapshot.session.status).toBe('closed');

    const lateApproval = applyWorkspaceEvent(closed, event(5, { type: 'approval', approval: { ...approval, decisions: [...approval.decisions] } }));
    expect(lateApproval.type).toBe('stale');
    expect(lateApproval.snapshot.approvals).toEqual([]);

    const staleCatalog = { protocol: 15 as const, safeMode: false, workspaces: [], harnesses: [], sessions: [{ ...closedRow, status: 'idle' as const }] };
    expect(protectClosedCatalogSessions(staleCatalog, { 'session-a': closed }).sessions[0]?.status).toBe('closed');

    const reopened: SessionSnapshot = { ...closed, revision: 5, session: { ...closedRow, status: 'idle' } };
    expect(acceptWorkspaceSnapshot(closed, reopened).session.status).toBe('closed');
    expect(acceptWorkspaceSnapshot(closed, reopened, true)).toBe(reopened);
  });

  it('adopts catalog Closed after a command error while preserving the honest error and readable transcript', () => {
    const current: SessionSnapshot = {
      ...snapshot(),
      approvals: [{ id: 'disposed-request', sessionId: 'session-a', kind: 'input', title: 'Old input', description: 'Disposed request', decisions: ['cancel'] }],
    };
    const closedRow = { ...current.session, status: 'closed' as const };
    const resolution = resolveCloseAfterCatalog(current, closedRow, 'The harness failed after closing.');
    expect(resolution.error).toBe('The harness failed after closing.');
    expect(resolution.snapshot.session.status).toBe('closed');
    expect(resolution.snapshot.blocks).toBe(current.blocks);
    expect(resolution.snapshot.approvals).toEqual([]);
  });

  it('keeps a non-closed catalog status after a command error instead of guessing Closed', () => {
    const current = snapshot();
    const runningRow = { ...current.session, status: 'running' as const };
    const resolution = resolveCloseAfterCatalog(current, runningRow, 'Close failed.');
    expect(resolution.error).toBe('Close failed.');
    expect(resolution.snapshot.session.status).toBe('running');
    expect(resolution.snapshot.blocks).toBe(current.blocks);
  });

  it('sorts by host timestamp and exposes full accessible harness names', () => {
    const first = snapshot().session;
    const newer = { ...first, id: 'session-new', title: 'Newer', updatedAt: '2026-03-02T10:00:00Z' };
    expect(sortedSessions([first, newer]).map((item) => item.id)).toEqual(['session-new', 'session-a']);
    expect(harnessLabel('prime-agent')).toBe('Prime Agent');
  });
});
