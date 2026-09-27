import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/workspace-session-tools-v1.json';
import type { ReviewRequestV1 } from '../../../../contracts/workspace-review-v1';
import type { WorkspacePlacementCommandV1 } from '../../../../contracts/workspace-placement-v1';
import type { WorkspaceAdoptRequestV1 } from '../../../../contracts/workspace-adopt-v1';
import { createAdoptClient, decodeAdoptResult } from './adoptClient';
import { folderSlug, plainBranchName } from './branchNames';
import { createPlacementClient, decodePlacementResult } from './placementClient';
import { createReviewClient, decodeReviewResult } from './reviewClient';
import { SESSION_TOOL_ERROR_COPY, SessionToolError, sessionToolError } from './sessionToolErrors';
import { partPatch, splitHunk } from '../app/review/review';

describe('session tools v1 contracts', () => {
  it('keeps the review fixture in the TypeScript contract shape', () => {
    const requests: ReviewRequestV1[] = [
      fixture.review.statusRequest as ReviewRequestV1,
      fixture.review.diffRequest as ReviewRequestV1,
      fixture.review.stageHunkRequest as ReviewRequestV1,
      fixture.review.unstageRequest as ReviewRequestV1,
      fixture.review.trashRequest as ReviewRequestV1,
    ];
    expect(requests.map((request) => request.type)).toEqual(['status', 'diff', 'stage', 'unstage', 'revert']);
    const status = decodeReviewResult(fixture.review.status);
    expect(status?.type).toBe('status');
    expect(status?.type === 'status' && status.files.map((file) => `${file.area}:${file.path}`)).toEqual([
      'staged:src/f.txt', 'unstaged:src/f.txt', 'unstaged:image.bin', 'untracked:notes.md',
    ]);
    expect(decodeReviewResult(fixture.review.notRepository)?.type).toBe('status');
    const diff = decodeReviewResult(fixture.review.diff);
    expect(diff?.type === 'diff' && diff.content.kind).toBe('text');
    expect(decodeReviewResult(fixture.review.binaryDiff)?.type).toBe('diff');
    expect(sessionToolError(fixture.review.error).code).toBe('STALE');
  });

  it('rejects review results outside the contract', () => {
    const status = fixture.review.status;
    for (const change of [
      { protocol: 2 },
      { type: 'other' },
      { files: [{ path: 'x', area: 'elsewhere', change: 'modified' }] },
      { files: [{ path: 'x', area: 'unstaged', change: 'renamed' }] },
      { files: [{ path: 'x', area: 'unstaged', change: 'modified', added: -1 }] },
      { repository: { state: 'ready' } },
      { hidden: 1.5 },
      { readOnly: 'no' },
    ]) {
      expect(decodeReviewResult({ ...status, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    const diff = fixture.review.diff;
    for (const change of [
      { fingerprint: 'short' },
      { fingerprint: 'X'.repeat(64) },
      { content: { kind: 'text', text: 'x', hunks: 1 } },
      { content: { kind: 'video' } },
      { actions: { stage: true } },
    ]) {
      expect(decodeReviewResult({ ...diff, ...change }), JSON.stringify(change)).toBeUndefined();
    }
  });

  it('keeps the placement fixture in the TypeScript contract shape', () => {
    const commands: WorkspacePlacementCommandV1[] = [
      fixture.placement.listRequest as WorkspacePlacementCommandV1,
      fixture.placement.previewRequest as WorkspacePlacementCommandV1,
      fixture.placement.createRequest as WorkspacePlacementCommandV1,
      fixture.placement.sharedRequest as WorkspacePlacementCommandV1,
      fixture.placement.removeRequest as WorkspacePlacementCommandV1,
    ];
    expect(commands.map((command) => command.type)).toEqual(['list', 'previewWorktree', 'createChat', 'createChat', 'removeWorktree']);
    const listed = decodePlacementResult(fixture.placement.placements);
    expect(listed?.type === 'placements' && listed.placements.map((placement) => Boolean(placement.worktree))).toEqual([true, false, false]);
    expect(decodePlacementResult(fixture.placement.preview)?.type).toBe('preview');
    expect(decodePlacementResult(fixture.placement.dirty)?.type).toBe('dirty');
    const removed = decodePlacementResult(fixture.placement.removed);
    expect(removed?.type === 'removed' && removed.placement.worktree?.state).toBe('removed');
    for (const change of [
      { placements: [{ sessionId: 's', worktree: { branch: 'b', path: 'p', state: 'gone', base: 'x' } }] },
      { placements: [{ sessionId: 's', adopted: false }] },
      { protocol: 2 },
    ]) {
      expect(decodePlacementResult({ ...fixture.placement.placements, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    expect(decodePlacementResult({ ...fixture.placement.dirty, changes: -1 })).toBeUndefined();
  });

  it('decodes the additive v1.1 review fields: renames and hunk parts', () => {
    const request = fixture.review.stagePartRequest as ReviewRequestV1;
    expect(request.type === 'stage' && [request.hunk, request.part]).toEqual([0, 1]);
    const renamed = decodeReviewResult(fixture.review.renamedStatus);
    expect(renamed?.type === 'status' && renamed.files[0]?.renamedFrom).toBe('docs/old.md');
    const file = fixture.review.renamedStatus.files[0];
    for (const renamedFrom of ['', 7, null]) {
      expect(decodeReviewResult({ ...fixture.review.renamedStatus, files: [{ ...file, renamedFrom }] }), String(renamedFrom)).toBeUndefined();
    }
    // A v1.0 status without the field still decodes.
    expect(decodeReviewResult(fixture.review.status)?.type).toBe('status');
  });

  it('splits hunks exactly like the host (golden cases)', () => {
    expect(fixture.review.hunkSplit.length).toBeGreaterThanOrEqual(4);
    for (const item of fixture.review.hunkSplit) {
      const parts = splitHunk(item.text, item.hunk);
      expect(parts.map((_, index) => partPatch(item.text, item.hunk, index)), item.name).toEqual(item.parts);
      expect(partPatch(item.text, item.hunk, parts.length), item.name).toBeUndefined();
    }
  });

  it('decodes the additive v1.1 placement commands: managed and orphan worktrees', () => {
    const commands: WorkspacePlacementCommandV1[] = [
      fixture.placement.worktreesRequest as WorkspacePlacementCommandV1,
      fixture.placement.removeOrphanRequest as WorkspacePlacementCommandV1,
    ];
    expect(commands.map((command) => command.type)).toEqual(['worktrees', 'removeOrphanWorktree']);
    const listed = decodePlacementResult(fixture.placement.worktrees);
    expect(listed?.type === 'worktrees' && listed.worktrees.map((item) => [item.state, item.sessions.length])).toEqual([
      ['ready', 1],
      ['missing', 0],
    ]);
    const dirty = decodePlacementResult(fixture.placement.worktreeDirty);
    expect(dirty?.type === 'worktreeDirty' && dirty.files.map((item) => item.area)).toEqual(['unstaged', 'untracked']);
    expect(decodePlacementResult(fixture.placement.worktreeRemoved)?.type).toBe('worktreeRemoved');
    const managed = fixture.placement.worktrees.worktrees[0];
    for (const change of [{ id: '../x' }, { state: 'removed' }, { sessions: [1] }]) {
      expect(decodePlacementResult({ ...fixture.placement.worktrees, worktrees: [{ ...managed, ...change }] }), JSON.stringify(change)).toBeUndefined();
    }
    for (const change of [{ files: [{ path: 'x', area: 'elsewhere' }] }, { truncated: 'no' }, { changes: -1 }]) {
      expect(decodePlacementResult({ ...fixture.placement.worktreeDirty, ...change }), JSON.stringify(change)).toBeUndefined();
    }
  });

  it('keeps the adopt fixture in the TypeScript contract shape', () => {
    const request: WorkspaceAdoptRequestV1 = fixture.adopt.request;
    const personal: WorkspaceAdoptRequestV1 = fixture.adopt.personalRequest;
    expect(request.projectId).toBe('project-1');
    expect(personal.projectId).toBeUndefined();
    expect(decodeAdoptResult(fixture.adopt.result)?.created).toBe(true);
    expect(decodeAdoptResult({ ...fixture.adopt.result, created: 'yes' })).toBeUndefined();
    expect(decodeAdoptResult({ ...fixture.adopt.result, sessionId: '' })).toBeUndefined();
  });

  it('maps refusals to fixed copy and forwards only known next steps', () => {
    expect(sessionToolError({ code: 'NOT_TRUSTED', message: 'C:\\secret\\path' }).message).toBe(SESSION_TOOL_ERROR_COPY.NOT_TRUSTED);
    expect(sessionToolError('{"code":"GIT_BUSY"}').code).toBe('GIT_BUSY');
    expect(sessionToolError({ code: 'NOT_SUPPORTED', message: 'Unstage this new file first, then move it to the trash.' }).message)
      .toBe('Unstage this new file first, then move it to the trash.');
    expect(sessionToolError({ code: 'NOT_SUPPORTED', message: 'anything else' }).message).toBe(SESSION_TOOL_ERROR_COPY.NOT_SUPPORTED);
    expect(sessionToolError({ code: 'WHATEVER' }).code).toBe('unknown');
    expect(sessionToolError(new Error('boom')).code).toBe('unknown');
  });

  it('clients call their route and refuse malformed answers', async () => {
    const calls: [string, unknown][] = [];
    const answer = (value: unknown) => async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([command, args]);
      return value as T;
    };
    await expect(createReviewClient(answer(fixture.review.status)).request({ type: 'status', sessionId: 's' })).resolves.toMatchObject({ type: 'status' });
    await expect(createReviewClient(answer({ protocol: 1, type: 'status' })).request({ type: 'status', sessionId: 's' })).rejects.toBeInstanceOf(SessionToolError);
    await expect(createPlacementClient(answer(fixture.placement.placements)).request({ type: 'list' })).resolves.toMatchObject({ type: 'placements' });
    await expect(createAdoptClient(answer(fixture.adopt.result)).adopt({ sessionId: 'x' })).resolves.toMatchObject({ created: true });
    const failing = createReviewClient(async () => {
      throw { code: 'SAFE_MODE', message: 'Safe mode is on: PiUI does not change files, git or chats.', recoverable: true };
    });
    await expect(failing.request({ type: 'status', sessionId: 's' })).rejects.toMatchObject({ code: 'SAFE_MODE' });
    expect(calls.map(([command]) => command)).toEqual([
      'workspace_review_v1', 'workspace_review_v1', 'workspace_placement_v1', 'workspace_adopt_v1',
    ]);
    expect(calls[2]?.[1]).toEqual({ command: { type: 'list' } });
    expect(calls[3]?.[1]).toEqual({ request: { sessionId: 'x' } });
  });
});

describe('branch and folder names', () => {
  it('match the host rules', () => {
    for (const good of ['piui/feature-x', 'fix_1.2', 'a']) expect(plainBranchName(good), good).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a//b', '@{-1}', 'a b', 'x.lock', 'a/.hidden', 'end/', 'end.', '.start', 'a\\b', 'x'.repeat(101)]) {
      expect(plainBranchName(bad), bad).toBe(false);
    }
    expect(folderSlug('Fix the Login bug!')).toBe('fix-the-login-bug');
    expect(folderSlug('piui/feature-x')).toBe('piui-feature-x');
    expect(folderSlug('///')).toBe('chat');
    expect(folderSlug('x'.repeat(80))).toHaveLength(48);
  });
});
