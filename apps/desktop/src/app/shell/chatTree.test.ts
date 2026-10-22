import { describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';
import { chatTree } from './chatTree';

const chat = (id: string): WorkspaceSession => ({ id, workspaceId: 'w', harness: 'codex', title: id, status: 'idle', updatedAt: '2026-10-22T00:00:00Z' });

describe('chatTree', () => {
  it('nests sidekicks under their listed lead in list order', () => {
    const parents: Record<string, string> = { s1: 'lead', s2: 'lead' };
    const tree = chatTree([chat('s1'), chat('a'), chat('lead'), chat('s2')], (id) => parents[id]);
    expect(tree.map((item) => [item.session.id, item.children.map((child) => child.id)])).toEqual([
      ['a', []],
      ['lead', ['s1', 's2']],
    ]);
  });

  it('keeps a chat on top when its parent is not listed or is itself nested', () => {
    const parents: Record<string, string> = { orphan: 'gone', b: 'a', c: 'b' };
    const tree = chatTree([chat('orphan'), chat('a'), chat('b'), chat('c')], (id) => parents[id]);
    expect(tree.map((item) => [item.session.id, item.children.map((child) => child.id)])).toEqual([
      ['orphan', []],
      ['a', ['b']],
      ['c', []],
    ]);
  });
});
