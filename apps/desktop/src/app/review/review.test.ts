import { describe, expect, it } from 'vitest';
import type { ReviewFileV1, ReviewResultV1 } from '../../../../../contracts/workspace-review-v1';
import { parseDiff } from '../chat/transcript/diff';
import { ComposerInserts } from './composerInserts.svelte';
import {
  appendToDraft, changedPaths, commentReference, formatSize, groupFiles, hunkLines, hunkText, splitDisplay, splitHunk, splitPath,
} from './review';
import { busyKey, changedPathsFor, ReviewStore, reviewedPaths } from './reviewStore.svelte';

const TEXT = 'diff --git a/src/f.txt b/src/f.txt\n--- a/src/f.txt\n+++ b/src/f.txt\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n@@ -10,4 +10,4 @@ i\n j\n k\n l\n-m\n+M\n';

const file = (path: string, area: ReviewFileV1['area']): ReviewFileV1 => ({ path, area, change: area === 'untracked' ? 'added' : 'modified' });

describe('review helpers', () => {
  it('groups files by area in a fixed order and splits paths', () => {
    const groups = groupFiles([file('b.ts', 'untracked'), file('a.ts', 'unstaged'), file('a.ts', 'staged')]);
    expect(groups.map((group) => group.area)).toEqual(['staged', 'unstaged', 'untracked']);
    expect(splitPath('apps/desktop/x.ts')).toEqual({ directory: 'apps/desktop/', name: 'x.ts' });
    expect(splitPath('x.ts')).toEqual({ directory: '', name: 'x.ts' });
    expect(changedPaths([file('a.ts', 'staged'), file('a.ts', 'unstaged'), file('b.ts', 'untracked')])).toEqual(['a.ts', 'b.ts']);
  });

  it('extracts one hunk and its lines for comments and revert previews', () => {
    expect(hunkText(TEXT, 1)).toBe('diff --git a/src/f.txt b/src/f.txt\n--- a/src/f.txt\n+++ b/src/f.txt\n@@ -10,4 +10,4 @@ i\n j\n k\n l\n-m\n+M\n');
    const parsed = parseDiff(TEXT)[0];
    if (parsed === undefined) throw new Error('expected a file');
    const lines = hunkLines(parsed.lines, 1);
    expect(lines.map((line) => `${line.removed ? '-' : ''}${line.number}:${line.text}`)).toEqual(['10:j', '11:k', '12:l', '-13:m', '13:M']);
  });

  it('formats a line comment as a quoted reference and appends it to the draft', () => {
    const reference = commentReference('src/f.txt', { number: 13, removed: false, changed: true, text: '  return value + 1;  ' }, ' Why +1? ');
    expect(reference).toBe('`src/f.txt:13`\n>   return value + 1;\n\nWhy +1?');
    expect(commentReference('src/f.txt', { number: 12, removed: true, changed: true, text: '' }, '')).toBe('`src/f.txt` (removed line 12)\n> (empty line)');
    expect(commentReference('a', { number: 1, removed: false, changed: false, text: 'x'.repeat(300) }, '').length).toBeLessThan(260);
    expect(appendToDraft('', 'first')).toBe('first');
    expect(appendToDraft('Please fix:\n\n', 'first')).toBe('Please fix:\n\nfirst');
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(undefined)).toBe('');
  });

  it('shows a split hunk as its parts and maps each shown hunk back', () => {
    const three = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,6 +1,6 @@\n a\n-b\n+B\n c\n-d\n+D\n e\n f\n@@ -20,2 +20,2 @@\n x\n-y\n+Y\n';
    expect(splitHunk(three, 0)).toHaveLength(2);
    expect(splitHunk(three, 1)).toHaveLength(1);
    expect(splitHunk(three, 5)).toEqual([]);
    const whole = splitDisplay(three, new Set());
    expect(whole.text).toBe(three);
    expect(whole.targets).toEqual([{ hunk: 0 }, { hunk: 1 }]);
    const split = splitDisplay(three, new Set([0, 1]));
    expect(split.targets).toEqual([{ hunk: 0, part: 0 }, { hunk: 0, part: 1 }, { hunk: 1 }]);
    expect(split.text).toContain('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -3,4 +3,4 @@\n c\n-d\n+D\n e\n f\n@@ -20,2 +20,2 @@');
    // Comments and revert previews work on the shown text.
    expect(hunkText(split.text, 1)).toBe('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,4 +3,4 @@\n c\n-d\n+D\n e\n f\n');
    expect(busyKey('stage', 0, 1)).toBe('stage:0.1');
    expect(busyKey('revert', undefined, 1)).toBe('revert:file');
  });

  it('inserts into the chat draft and bumps the composer epoch without sending', () => {
    const drafts = new Map<string, string>([['chat', 'Existing text']]);
    const access = { draftFor: (key: string) => drafts.get(key) ?? '', updateDraft: (key: string, text: string) => void drafts.set(key, text) };
    const inserts = new ComposerInserts();
    inserts.insert(access, 'chat', '`a.ts:1`\n> x');
    expect(drafts.get('chat')).toBe('Existing text\n\n`a.ts:1`\n> x');
    expect(inserts.epoch('chat')).toBe(1);
    expect(inserts.epoch('other')).toBe(0);
  });
});

describe('review store', () => {
  const status: ReviewResultV1 = {
    protocol: 1, type: 'status', sessionId: 's', repository: { state: 'ready', branch: 'main', worktree: false, folder: 'repo' },
    files: [file('src/f.txt', 'unstaged'), file('new.md', 'untracked')], truncated: false, hidden: 0, readOnly: false,
  };
  const diff = (fingerprint: string): ReviewResultV1 => ({
    protocol: 1, type: 'diff', sessionId: 's', path: 'src/f.txt', area: 'unstaged', fingerprint,
    content: { kind: 'text', text: TEXT, hunks: 2, hunkActions: true }, actions: { stage: true, unstage: false, revert: true },
  });

  it('selects the first file, acts on a hunk with the reviewed fingerprint and remembers the paths', async () => {
    const requests: unknown[] = [];
    const store = new ReviewStore('s', async (request) => {
      requests.push(request);
      return request.type === 'diff' ? diff('f'.repeat(64)) : status;
    });
    await store.refresh();
    await store.loadDiff();
    expect(store.selected).toEqual({ path: 'src/f.txt', area: 'unstaged' });
    expect(store.diff?.fingerprint).toBe('f'.repeat(64));
    expect(reviewedPaths('s')).toEqual(['src/f.txt', 'new.md']);
    expect(await store.act('stage', 1)).toBe(true);
    expect(requests).toContainEqual({ type: 'stage', area: 'unstaged', sessionId: 's', path: 'src/f.txt', fingerprint: 'f'.repeat(64), hunk: 1 });
  });

  it('sends one part of a split hunk and never a part without its hunk', async () => {
    const requests: unknown[] = [];
    const store = new ReviewStore('s', async (request) => {
      requests.push(request);
      return request.type === 'diff' ? diff('a'.repeat(64)) : status;
    });
    await store.refresh();
    await store.loadDiff();
    expect(await store.act('revert', 0, 1)).toBe(true);
    expect(await store.act('stage', undefined, 1)).toBe(true);
    expect(requests).toContainEqual({ type: 'revert', area: 'unstaged', sessionId: 's', path: 'src/f.txt', fingerprint: 'a'.repeat(64), hunk: 0, part: 1 });
    expect(requests).toContainEqual({ type: 'stage', area: 'unstaged', sessionId: 's', path: 'src/f.txt', fingerprint: 'a'.repeat(64) });
  });

  it('reads the changed paths for a handoff without the panel, and falls back when git cannot answer', async () => {
    expect(await changedPathsFor('fresh', async () => status)).toEqual(['src/f.txt', 'new.md']);
    expect(reviewedPaths('fresh')).toEqual(['src/f.txt', 'new.md']);
    // A refusal keeps the last listed paths.
    expect(await changedPathsFor('fresh', async () => {
      throw Object.assign(new Error('Trust this project folder first.'), { code: 'NOT_TRUSTED' });
    })).toEqual(['src/f.txt', 'new.md']);
    expect(await changedPathsFor('never-listed', async () => {
      throw new Error('no');
    })).toBeUndefined();
    // A slow answer does not hold the handoff.
    const slow = changedPathsFor('slow', () => new Promise(() => undefined), 10);
    await expect(slow).resolves.toBeUndefined();
  });

  it('reloads after a stale refusal and keeps the error for the person', async () => {
    let calls = 0;
    const store = new ReviewStore('s', async (request) => {
      if (request.type === 'revert') throw Object.assign(new Error('This changed since you reviewed it. Check it again before continuing.'), { code: 'STALE' });
      if (request.type === 'status') calls += 1;
      return request.type === 'diff' ? diff('e'.repeat(64)) : status;
    });
    await store.refresh();
    await store.loadDiff();
    expect(await store.act('revert')).toBe(false);
    expect(store.actionError).toContain('changed since you reviewed');
    expect(calls).toBe(2);
    expect(store.busy).toBe('');
  });

  it('reports a status failure and its code', async () => {
    const store = new ReviewStore('s', async () => {
      throw Object.assign(new Error('Trust this project folder first.'), { code: 'NOT_TRUSTED' });
    });
    await store.refresh();
    expect(store.errorCode).toBe('NOT_TRUSTED');
    expect(store.status).toBeUndefined();
  });
});
