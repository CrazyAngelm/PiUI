import { describe, expect, it } from 'vitest';
import type { ManagedWorktreeV1 } from '../../../../../contracts/workspace-placement-v1';
import { WORKTREE_CHANGE_LABELS, worktreeRows } from './managedWorktrees';

const worktree = (branch: string, sessions: string[], workspaceId = 'p1'): ManagedWorktreeV1 => ({
  id: branch.replace(/[^a-z]/g, '').padEnd(32, '0').slice(0, 32),
  workspaceId,
  branch,
  path: `~/worktrees/${branch}`,
  state: 'ready',
  base: '0123456789ab',
  sessions,
});

describe('managed worktree rows', () => {
  it('puts orphans first and offers only chats the sidebar lists', () => {
    const rows = worktreeRows(
      [worktree('piui/used', ['chat-1', 'hidden-chat']), worktree('piui/zeta', []), worktree('piui/alpha', [], 'p2')],
      [{ id: 'chat-1', title: 'Try a denser layout' }],
      [{ id: 'p1', name: 'piui' }, { id: 'p2', name: 'api' }],
    );
    expect(rows.map((row) => [row.worktree.branch, row.projectName, row.orphan])).toEqual([
      ['piui/alpha', 'api', true],
      ['piui/zeta', 'piui', true],
      ['piui/used', 'piui', false],
    ]);
    expect(rows[2]?.chats).toEqual([{ id: 'chat-1', title: 'Try a denser layout' }]);
  });

  it('keeps a worktree used by an unlisted chat out of the orphans and names a forgotten project', () => {
    const [row] = worktreeRows([worktree('piui/x', ['gone-from-catalog'], 'removed-project')], [], []);
    expect(row).toMatchObject({ orphan: false, chats: [], projectName: '' });
    expect(Object.keys(WORKTREE_CHANGE_LABELS)).toEqual(['staged', 'unstaged', 'untracked', 'conflict']);
  });
});
