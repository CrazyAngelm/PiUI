import { describe, expect, it } from 'vitest';
import type { ChatPlacementV1, WorkspacePlacementResultV1 } from '../../../../../contracts/workspace-placement-v1';
import { confirmedWorktree, NewChatPlacement } from './newChatPlacement.svelte';
import { Placements } from './placements.svelte';

const worktree = (sessionId: string, path: string): ChatPlacementV1 => ({
  sessionId,
  worktree: { branch: 'piui/x', path, state: 'ready', base: 'abc' },
});

describe('placements', () => {
  it('loads once per change of the chat list and coalesces overlapping loads', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const store = new Placements(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      const result: WorkspacePlacementResultV1 = {
        protocol: 1,
        type: 'placements',
        placements: [worktree('a', '~/w/1'), worktree('b', '~/w/1'), { sessionId: 'c', continuedFrom: 'a' }],
      };
      return result;
    });
    store.sync(['a', 'b']);
    store.sync(['b', 'a']);
    const second = store.refresh();
    release?.();
    await second;
    expect(calls).toBe(2);
    expect(store.get('c')?.continuedFrom).toBe('a');
    expect(store.sharingWorktree('a').sort()).toEqual(['a', 'b']);
    expect(store.sharingWorktree('c')).toEqual([]);
    store.put({ sessionId: 'a', worktree: { branch: 'piui/x', path: '~/w/1', state: 'removed', base: 'abc' } });
    expect(store.get('a')?.worktree?.state).toBe('removed');
  });

  it('keeps chats usable when the list cannot be read', async () => {
    const store = new Placements(async () => {
      throw new Error('offline');
    });
    await store.refresh();
    expect(store.get('a')).toBeUndefined();
  });
});

describe('new chat placement', () => {
  const preview = {
    workspaceId: 'p',
    branch: 'piui/login',
    folder: 'piui-login',
    path: '~/w/piui-login',
    base: { commit: 'c'.repeat(40), short: 'c'.repeat(12) },
    projectChanges: false,
  };

  it('applies a confirmed worktree and a handoff only to their project', () => {
    const choice = new NewChatPlacement();
    expect(choice.requestFor('p')).toBeUndefined();
    choice.chooseWorktree(confirmedWorktree(preview));
    expect(choice.requestFor('p')).toEqual({ worktree: { type: 'new', branch: 'piui/login', folder: 'piui-login', expectedBase: 'c'.repeat(40) } });
    expect(choice.requestFor('other')).toBeUndefined();
    choice.started('p');
    expect(choice.requestFor('p')).toBeUndefined();
  });

  it('continues a worktree chat in the same worktree unless the person picks otherwise', () => {
    const choice = new NewChatPlacement();
    choice.startHandoff({
      sourceSessionId: 's', sourceTitle: 'Source', sourceHarness: 'Codex', workspaceId: 'p',
      worktreeBranch: 'piui/x', shareWorktree: true, stashedDraft: 'my draft',
    });
    expect(choice.epoch).toBe(1);
    expect(choice.requestFor('p')).toEqual({ continuedFrom: 's', worktree: { type: 'shared', sessionId: 's' } });
    choice.setShareWorktree(false);
    expect(choice.requestFor('p')).toEqual({ continuedFrom: 's' });
    choice.chooseWorktree(confirmedWorktree(preview));
    expect(choice.requestFor('p')?.worktree?.type).toBe('new');
    expect(choice.endHandoff()).toBe('my draft');
    expect(choice.handoff).toBeUndefined();
    expect(choice.epoch).toBe(2);
  });
});
