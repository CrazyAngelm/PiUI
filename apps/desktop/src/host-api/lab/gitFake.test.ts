import { describe, expect, it } from 'vitest';
import { applyChange, applyHunk, changeOf, changes, diffText, hunksOf, type LabRepository } from './gitFake';

const lines = (values: readonly string[]): string => `${values.join('\n')}\n`;
const ORIGINAL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];

function repository(worktree: string): LabRepository {
  return {
    branch: 'main',
    head: '0'.repeat(40),
    folder: 'repo',
    worktree: false,
    files: new Map([['f.txt', { head: lines(ORIGINAL), index: lines(ORIGINAL), worktree }]]),
    trash: [],
  };
}

describe('lab git fake', () => {
  it('splits distant edits into hunks with three context lines like git', () => {
    const changed = [...ORIGINAL];
    changed[0] = 'A';
    changed[12] = 'M';
    const hunks = hunksOf(lines(ORIGINAL), lines(changed));
    expect(hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([[1, 4, 1, 4], [10, 4, 10, 4]]);
    expect(diffText('f.txt', lines(ORIGINAL), lines(changed))).toContain('@@ -10,4 +10,4 @@\n j\n k\n l\n-m\n+M\n');
    expect(diffText('n.txt', undefined, 'x\n')).toContain('new file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+x\n');
  });

  it('stages, unstages and reverts a single hunk exactly', () => {
    const changed = [...ORIGINAL];
    changed[0] = 'A';
    changed[12] = 'M';
    const repo = repository(lines(changed));
    const unstaged = changeOf(repo, 'f.txt', 'unstaged');
    if (unstaged === undefined) throw new Error('expected a change');
    applyChange(repo, unstaged, 'stage', 1);
    expect(changes(repo).map((change) => change.area)).toEqual(['staged', 'unstaged']);
    const staged = changeOf(repo, 'f.txt', 'staged');
    if (staged === undefined) throw new Error('expected a staged change');
    expect(hunksOf(staged.before, staged.after)).toHaveLength(1);
    applyChange(repo, staged, 'unstage', 0);
    expect(changes(repo).map((change) => change.area)).toEqual(['unstaged']);
    const current = changeOf(repo, 'f.txt', 'unstaged');
    if (current === undefined) throw new Error('expected a change');
    applyChange(repo, current, 'revert', 0);
    const expected = [...ORIGINAL];
    expected[12] = 'M';
    expect(repo.files.get('f.txt')?.worktree).toBe(lines(expected));
  });

  it('refuses a hunk whose context changed', () => {
    const changed = [...ORIGINAL];
    changed[0] = 'A';
    const [hunk] = hunksOf(lines(ORIGINAL), lines(changed));
    if (hunk === undefined) throw new Error('expected a hunk');
    const moved = [...ORIGINAL];
    moved[1] = 'B';
    expect(() => applyHunk(lines(moved), hunk, false)).toThrow();
  });

  it('moves untracked files to the trash and stages new files whole', () => {
    const repo = repository(lines(ORIGINAL));
    repo.files.set('new.md', { worktree: 'draft\n' });
    repo.files.set('keep.md', { worktree: 'keep\n' });
    const untracked = changeOf(repo, 'new.md', 'untracked');
    if (untracked === undefined) throw new Error('expected an untracked file');
    applyChange(repo, untracked, 'revert', undefined);
    expect(repo.trash).toEqual(['new.md']);
    expect(repo.files.has('new.md')).toBe(false);
    const keep = changeOf(repo, 'keep.md', 'untracked');
    if (keep === undefined) throw new Error('expected an untracked file');
    applyChange(repo, keep, 'stage', undefined);
    expect(changeOf(repo, 'keep.md', 'staged')?.change).toBe('added');
  });
});
