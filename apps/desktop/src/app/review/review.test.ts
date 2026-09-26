import { describe, expect, it } from 'vitest';
import type { ReviewFileV1, ReviewResultV1 } from '../../../../../contracts/workspace-review-v1';
import { parseDiff } from '../chat/transcript/diff';
import { ComposerInserts } from './composerInserts.svelte';
import {
  appendToDraft, changedPaths, commentReference, formatSize, groupFiles, hunkLines, hunkText, splitPath,
} from './review';
import { ReviewStore, reviewedPaths } from './reviewStore.svelte';

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
