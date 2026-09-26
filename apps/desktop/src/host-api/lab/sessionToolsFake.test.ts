import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDiffV1, ReviewResultV1, ReviewStatusV1 } from '../../../../../contracts/workspace-review-v1';
import type { WorkspacePlacementResultV1 } from '../../../../../contracts/workspace-placement-v1';
import type { WorkspaceAdoptResultV1 } from '../../../../../contracts/workspace-adopt-v1';
import { decodePlacementResult } from '../placementClient';
import { decodeReviewResult } from '../reviewClient';
import type { LabHost } from './labHost';
import { labHost, rejection } from './labTestKit';
import { DEMO_PROJECTS, demoSessionId } from './scenarios/demoChats';
import { DEMO_WORKTREE_SESSION } from './sessionToolsFake';

const TRANSPORT_CHAT = demoSessionId('transport');

async function review<T extends ReviewResultV1>(host: LabHost, request: Record<string, unknown>): Promise<T> {
  const result = await host.invoke<unknown>('workspace_review_v1', { request });
  const decoded = decodeReviewResult(result);
  if (decoded === undefined) throw new Error(`invalid review result ${JSON.stringify(result)}`);
  return decoded as T;
}

async function placement(host: LabHost, command: Record<string, unknown>): Promise<WorkspacePlacementResultV1> {
  const result = await host.invoke<unknown>('workspace_placement_v1', { command });
  const decoded = decodePlacementResult(result);
  if (decoded === undefined) throw new Error(`invalid placement result ${JSON.stringify(result)}`);
  return decoded;
}

describe('session tools lab fake', () => {
  let host: LabHost;
  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost('demo');
  });
  afterEach(() => vi.useRealTimers());

  it('reviews the demo project with staged, unstaged, binary and untracked files', async () => {
    const status = await review<ReviewStatusV1>(host, { type: 'status', sessionId: TRANSPORT_CHAT });
    expect(status.repository).toMatchObject({ state: 'ready', branch: 'main', worktree: false, folder: 'piui' });
    expect(status.files.map((file) => `${file.area}:${file.change}:${file.path}`)).toEqual([
      'unstaged:modified:apps/desktop/icons/badge.png',
      'staged:modified:apps/desktop/src/app/shell/Sidebar.svelte',
      'unstaged:modified:apps/desktop/src/host-api/transport.ts',
      'unstaged:deleted:docs/OLD_NOTES.md',
      'untracked:added:docs/notes/review-panel.md',
    ]);
    const personal = await review<ReviewStatusV1>(host, { type: 'status', sessionId: demoSessionId('lisbon') });
    expect(personal.repository.state).toBe('not-repository');
  });

  it('stages one hunk with the reviewed fingerprint and refuses a stale one', async () => {
    const path = 'apps/desktop/src/host-api/transport.ts';
    const diff = await review<ReviewDiffV1>(host, { type: 'diff', sessionId: TRANSPORT_CHAT, path, area: 'unstaged' });
    expect(diff.content).toMatchObject({ kind: 'text', hunks: 2, hunkActions: true });
    const after = await review<ReviewStatusV1>(host, {
      type: 'stage', sessionId: TRANSPORT_CHAT, path, area: 'unstaged', fingerprint: diff.fingerprint, hunk: 0,
    });
    expect(after.files.filter((file) => file.path === path).map((file) => file.area)).toEqual(['staged', 'unstaged']);
    await expect(host.invoke('workspace_review_v1', {
      request: { type: 'stage', sessionId: TRANSPORT_CHAT, path, area: 'unstaged', fingerprint: diff.fingerprint, hunk: 1 },
    })).rejects.toMatchObject({ code: 'STALE' });
    await expect(host.invoke('workspace_review_v1', {
      request: { type: 'diff', sessionId: TRANSPORT_CHAT, path: '../outside', area: 'unstaged' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(host.invoke('workspace_review_v1', { request: { type: 'status', sessionId: TRANSPORT_CHAT, extra: 1 } })))
      .toContain('unknown field `extra`');
  });

  it('moves an untracked file to the trash after review', async () => {
    const path = 'docs/notes/review-panel.md';
    const diff = await review<ReviewDiffV1>(host, { type: 'diff', sessionId: TRANSPORT_CHAT, path, area: 'untracked' });
    expect(diff.actions).toEqual({ stage: true, unstage: false, revert: true });
    const after = await review<ReviewStatusV1>(host, {
      type: 'revert', sessionId: TRANSPORT_CHAT, path, area: 'untracked', fingerprint: diff.fingerprint,
    });
    expect(after.files.some((file) => file.path === path)).toBe(false);
  });

  it('creates a worktree chat exactly as previewed and removes it after confirmation', async () => {
    const preview = await placement(host, { type: 'previewWorktree', workspaceId: DEMO_PROJECTS.piui, branch: 'piui/lab-test' });
    if (preview.type !== 'preview') throw new Error('expected a preview');
    expect(preview.preview).toMatchObject({ branch: 'piui/lab-test', folder: 'piui-lab-test', projectChanges: true });
    await expect(host.invoke('workspace_placement_v1', {
      command: { type: 'previewWorktree', workspaceId: DEMO_PROJECTS.piui, branch: 'main' },
    })).rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
    const created = await placement(host, {
      type: 'createChat', workspaceId: DEMO_PROJECTS.piui, harness: 'codex', permissionMode: 'native',
      worktree: { type: 'new', branch: 'piui/lab-test', folder: preview.preview.folder, expectedBase: preview.preview.base.commit },
    });
    if (created.type !== 'created') throw new Error('expected a created chat');
    expect(created.placement.worktree).toMatchObject({ branch: 'piui/lab-test', state: 'ready' });
    const status = await review<ReviewStatusV1>(host, { type: 'status', sessionId: created.snapshot.session.id });
    expect(status.repository).toMatchObject({ state: 'ready', worktree: true, branch: 'piui/lab-test' });
    expect(status.files).toEqual([]);

    const dirty = await placement(host, { type: 'removeWorktree', sessionId: DEMO_WORKTREE_SESSION, discardChanges: false });
    if (dirty.type !== 'dirty') throw new Error('expected changes');
    expect(dirty.changes).toBe(2);
    await expect(host.invoke('workspace_placement_v1', {
      command: { type: 'removeWorktree', sessionId: DEMO_WORKTREE_SESSION, discardChanges: true, expectedChanges: 'f'.repeat(64) },
    })).rejects.toMatchObject({ code: 'STALE' });
    const removed = await placement(host, {
      type: 'removeWorktree', sessionId: DEMO_WORKTREE_SESSION, discardChanges: true, expectedChanges: dirty.fingerprint,
    });
    expect(removed.type === 'removed' && removed.placement.worktree?.state).toBe('removed');
    await expect(host.invoke('workspace_review_v1', { request: { type: 'status', sessionId: DEMO_WORKTREE_SESSION } }))
      .rejects.toMatchObject({ code: 'WORKTREE_REMOVED' });
  });

  it('links a handoff back to its source', async () => {
    const created = await placement(host, {
      type: 'createChat', workspaceId: DEMO_PROJECTS.piui, harness: 'pi', permissionMode: 'native', continuedFrom: TRANSPORT_CHAT,
    });
    if (created.type !== 'created') throw new Error('expected a created chat');
    expect(created.placement.continuedFrom).toBe(TRANSPORT_CHAT);
    const listed = await placement(host, { type: 'list' });
    expect(listed.type === 'placements' && listed.placements.map((item) => item.sessionId)).toContain(created.snapshot.session.id);
  });

  it('adopts a terminal Pi session once and refuses one still open in the terminal', async () => {
    const catalog = await host.invoke<{ sessions: { id: string; title: string }[] }>('get_session_catalog', { projectId: DEMO_PROJECTS.piui });
    const target = catalog.sessions.find((session) => session.title === 'Make the session index incremental');
    const busy = catalog.sessions.find((session) => session.title === 'Draft release notes for 0.2.0');
    if (target === undefined || busy === undefined) throw new Error('demo history changed');
    const first = await host.invoke<WorkspaceAdoptResultV1>('workspace_adopt_v1', { request: { projectId: DEMO_PROJECTS.piui, sessionId: target.id } });
    expect(first.created).toBe(true);
    const again = await host.invoke<WorkspaceAdoptResultV1>('workspace_adopt_v1', { request: { projectId: DEMO_PROJECTS.piui, sessionId: target.id } });
    expect(again).toEqual({ ...first, created: false });
    await expect(host.invoke('workspace_adopt_v1', { request: { projectId: DEMO_PROJECTS.piui, sessionId: busy.id } }))
      .rejects.toMatchObject({ code: 'SESSION_ALREADY_ACTIVE' });
    await expect(host.invoke('workspace_adopt_v1', { request: { projectId: DEMO_PROJECTS.video, sessionId: target.id } }))
      .rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('reads in safe mode and refuses every change', async () => {
    const safe = labHost('safe');
    const status = await review<ReviewStatusV1>(safe, { type: 'status', sessionId: TRANSPORT_CHAT });
    expect(status.readOnly).toBe(true);
    const path = 'apps/desktop/src/host-api/transport.ts';
    const diff = await review<ReviewDiffV1>(safe, { type: 'diff', sessionId: TRANSPORT_CHAT, path, area: 'unstaged' });
    await expect(safe.invoke('workspace_review_v1', {
      request: { type: 'revert', sessionId: TRANSPORT_CHAT, path, area: 'unstaged', fingerprint: diff.fingerprint },
    })).rejects.toMatchObject({ code: 'SAFE_MODE' });
    await expect(safe.invoke('workspace_placement_v1', { command: { type: 'previewWorktree', workspaceId: DEMO_PROJECTS.piui } }))
      .rejects.toMatchObject({ code: 'SAFE_MODE' });
  });
});
