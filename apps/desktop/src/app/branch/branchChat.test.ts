import { describe, expect, it, vi } from 'vitest';
import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
import type { SessionSnapshot } from '../../../../../contracts/workspace-v15';
import { CHAT_TITLE_LIMIT } from '../chat/chatTitle';
import { SessionToolError } from '../../host-api/sessionToolErrors';
import { BRANCH_POINT_COPY, blocksBefore, branchTitle, btwQuestion, startBranch, type BranchDeps, type BranchStore } from './branchChat';

const block = (id: string, kind: DesktopTimelineBlock['kind'], text: string): DesktopTimelineBlock => ({ id, kind, label: kind, text, status: 'complete' });
const BLOCKS = [block('u1', 'user', 'First question'), block('a1', 'assistant', 'First answer'), block('u2', 'user', 'Second question'), block('a2', 'assistant', 'Second answer')];

function snapshot(harness = 'claude-code', title = 'Cache sizing'): SessionSnapshot {
  return {
    session: { id: 'source', workspaceId: 'ws', harness, title, status: 'idle', updatedAt: '', model: { provider: 'anthropic', id: 'm', name: 'M' } },
    revision: 1,
    blocks: BLOCKS,
    approvals: [],
    capabilities: {},
    models: [],
  } as unknown as SessionSnapshot;
}

type CreateArgs = Parameters<BranchStore['createChat']>;

function fakeStore(create: (...args: CreateArgs) => Promise<{ sessionId: string; error?: string }>, safeMode = false) {
  const createChat = vi.fn(create);
  const updateDraft = vi.fn();
  const openSession = vi.fn(async () => undefined);
  const store = { createChat, updateDraft, openSession, safeMode } as unknown as BranchStore;
  return { store, createChat, updateDraft, openSession };
}

const deps = (overrides: Partial<BranchDeps> = {}): BranchDeps & { openBeside: ReturnType<typeof vi.fn> } =>
  ({
    openBeside: vi.fn(async () => 'opened' as const),
    worktreeReady: () => false,
    ...overrides,
  }) as BranchDeps & { openBeside: ReturnType<typeof vi.fn> };

const refusal = (code: string) => Object.assign(new SessionToolError('unknown', `copy for ${code}`), { code });
const unsupportedNatively = async (request: CreateArgs[0]) => {
  if (request.placement?.branch?.mode === 'native') throw refusal('BRANCH_UNSUPPORTED');
  return { sessionId: 'child' };
};

describe('branch title', () => {
  it('adds the suffix and keeps the whole name within the title limit', () => {
    expect(branchTitle('Cache sizing')).toBe('Cache sizing (branch)');
    const long = branchTitle('x'.repeat(200));
    expect([...long]).toHaveLength(CHAT_TITLE_LIMIT);
    expect(long.endsWith('… (branch)')).toBe(true);
    expect([...branchTitle('😀'.repeat(200))]).toHaveLength(CHAT_TITLE_LIMIT);
    expect(branchTitle('a\nb\tc')).toBe('a b c (branch)');
  });
});

describe('cuts and /btw', () => {
  it('keeps what precedes a user block, refuses anything else', () => {
    expect(blocksBefore(BLOCKS, { at: 'end' })).toBe(BLOCKS);
    expect(blocksBefore(BLOCKS, { at: 'before', blockId: 'u2' })?.map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(blocksBefore(BLOCKS, { at: 'before', blockId: 'a1' })).toBeUndefined();
    expect(blocksBefore(BLOCKS, { at: 'before', blockId: 'missing' })).toBeUndefined();
  });

  it('reads /btw with and without a question', () => {
    expect(btwQuestion('/btw')).toBe('');
    expect(btwQuestion('  /btw  why is it slow?  ')).toBe('why is it slow?');
    expect(btwQuestion('/btw first\nsecond')).toBe('first\nsecond');
    expect(btwQuestion('/btwx')).toBeUndefined();
    expect(btwQuestion('/compact')).toBeUndefined();
    expect(btwQuestion('hello /btw')).toBeUndefined();
  });
});

describe('startBranch', () => {
  it('branches natively on the same agent, model and project', async () => {
    const { store, createChat, updateDraft, openSession } = fakeStore(async () => ({ sessionId: 'child' }));
    const result = await startBranch(store, snapshot(), { at: 'before', blockId: 'u2' }, { open: 'here' }, deps());
    expect(result).toEqual({ ok: true, sessionId: 'child', title: 'Cache sizing (branch)', mode: 'native' });
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledWith(
      {
        workspaceId: 'ws',
        harness: 'claude-code',
        permissionMode: 'read-only',
        model: { provider: 'anthropic', id: 'm', name: 'M' },
        text: '',
        placement: { continuedFrom: 'source', branch: { mode: 'native', at: 'before', blockId: 'u2' } },
      },
      { open: false, title: 'Cache sizing (branch)' },
    );
    expect(updateDraft).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledWith('child');
  });

  it('fills the required permission mode with the adapter default, because the host uses the source chat mode', async () => {
    const { store, createChat } = fakeStore(async () => ({ sessionId: 'child' }));
    const other = { ...snapshot(), session: { ...snapshot().session, id: 'unrecorded' } } as SessionSnapshot;
    await startBranch(store, other, { at: 'end' }, { open: 'none' }, deps());
    expect(createChat.mock.calls[0]?.[0].permissionMode).toBe('read-only');
  });

  it('sends the prompt alone in native mode and puts a draft into the composer', async () => {
    const { store, createChat, updateDraft } = fakeStore(async () => ({ sessionId: 'child' }));
    await startBranch(store, snapshot(), { at: 'end' }, { prompt: 'a side question', draft: 'edited text', open: 'none' }, deps());
    expect(createChat.mock.calls[0]?.[0].text).toBe('a side question');
    expect(updateDraft).toHaveBeenCalledWith('child', 'edited text');
  });

  it('falls back to a linked branch with a digest when the agent cannot branch natively', async () => {
    const { store, createChat, updateDraft } = fakeStore(unsupportedNatively);
    const result = await startBranch(store, snapshot('pi'), { at: 'before', blockId: 'u2' }, { prompt: 'and now?', open: 'here' }, deps());
    expect(result).toEqual({ ok: true, sessionId: 'child', title: 'Cache sizing (branch)', mode: 'linked' });
    expect(createChat).toHaveBeenCalledTimes(2);
    const linked = createChat.mock.calls[1]?.[0];
    expect(linked?.placement).toEqual({ continuedFrom: 'source', branch: { mode: 'linked' } });
    expect(linked?.text).toContain('First question');
    expect(linked?.text).toContain('First answer');
    expect(linked?.text).not.toContain('Second question');
    expect(linked?.text.endsWith('\nand now?')).toBe(true);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it('skips the digest of a linked branch cut before the first message', async () => {
    const withPrompt = fakeStore(unsupportedNatively);
    const result = await startBranch(withPrompt.store, snapshot('pi'), { at: 'before', blockId: 'u1' }, { prompt: 'a fresh start', open: 'none' }, deps());
    expect(result).toMatchObject({ ok: true, mode: 'linked', empty: true });
    expect(withPrompt.createChat.mock.calls[1]?.[0].text).toBe('a fresh start');

    const withDraft = fakeStore(unsupportedNatively);
    await startBranch(withDraft.store, snapshot('pi'), { at: 'before', blockId: 'u1' }, { draft: 'First question', open: 'none' }, deps());
    expect(withDraft.createChat.mock.calls[1]?.[0].text).toBe('');
    expect(withDraft.updateDraft).toHaveBeenCalledWith('child', 'First question');

    const neither = fakeStore(unsupportedNatively);
    await startBranch(neither.store, snapshot('pi'), { at: 'before', blockId: 'u1' }, { open: 'none' }, deps());
    expect(neither.updateDraft).not.toHaveBeenCalled();
    const later = await startBranch(fakeStore(unsupportedNatively).store, snapshot('pi'), { at: 'before', blockId: 'u2' }, { open: 'none' }, deps());
    expect(later).not.toHaveProperty('empty');
  });

  it('shares the worktree of a source that has one ready, in linked mode only', async () => {
    const { store, createChat } = fakeStore(unsupportedNatively);
    await startBranch(store, snapshot('pi'), { at: 'end' }, { open: 'none' }, deps({ worktreeReady: () => true }));
    expect(createChat.mock.calls[0]?.[0].placement).not.toHaveProperty('worktree');
    expect(createChat.mock.calls[1]?.[0].placement?.worktree).toEqual({ type: 'shared', sessionId: 'source' });
  });

  it('leaves the digest in the composer for the person to finish when there is no prompt', async () => {
    const { store, createChat, updateDraft } = fakeStore(unsupportedNatively);
    await startBranch(store, snapshot('pi'), { at: 'before', blockId: 'u2' }, { draft: 'Second question', open: 'none' }, deps());
    expect(createChat.mock.calls[1]?.[0].text).toBe('');
    const draft = updateDraft.mock.calls[0]?.[1] as string;
    expect(draft).toContain('First answer');
    expect(draft.endsWith('Second question')).toBe(true);
  });

  it('reports a missing branch point without retrying', async () => {
    const { store, createChat, openSession } = fakeStore(async () => {
      throw refusal('BRANCH_POINT_NOT_FOUND');
    });
    const result = await startBranch(store, snapshot(), { at: 'before', blockId: 'gone' }, { open: 'here' }, deps());
    expect(result).toEqual({ ok: false, error: BRANCH_POINT_COPY });
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('returns other errors as copy and does not retry; a linked failure is returned too', async () => {
    const other = fakeStore(async () => {
      throw new SessionToolError('RUNTIME_FAILED', 'The harness could not start. Its saved history has not been removed.');
    });
    expect(await startBranch(other.store, snapshot(), { at: 'end' }, { open: 'here' }, deps())).toEqual({
      ok: false,
      error: 'The harness could not start. Its saved history has not been removed.',
    });
    expect(other.createChat).toHaveBeenCalledTimes(1);
    const odd = fakeStore(async () => {
      throw 'boom';
    });
    expect(await startBranch(odd.store, snapshot(), { at: 'end' }, { open: 'here' }, deps())).toEqual({ ok: false, error: 'The branch could not be created.' });
    const failing = fakeStore(async () => {
      throw refusal('BRANCH_UNSUPPORTED');
    });
    expect(await startBranch(failing.store, snapshot('pi'), { at: 'end' }, { open: 'here' }, deps())).toMatchObject({ ok: false });
    expect(failing.createChat).toHaveBeenCalledTimes(2);
  });

  it('refuses in safe mode before asking the host', async () => {
    const { store, createChat } = fakeStore(async () => ({ sessionId: 'child' }), true);
    const result = await startBranch(store, snapshot(), { at: 'end' }, { open: 'here' }, deps());
    expect(result.ok).toBe(false);
    expect(createChat).not.toHaveBeenCalled();
  });

  it('opens beside, falls back to in place, or leaves the screen alone', async () => {
    const beside = fakeStore(async () => ({ sessionId: 'child' }));
    const free = deps();
    await startBranch(beside.store, snapshot(), { at: 'end' }, { open: 'beside' }, free);
    expect(free.openBeside).toHaveBeenCalledWith('child');
    expect(beside.openSession).toHaveBeenCalledWith('child');

    const narrow = fakeStore(async () => ({ sessionId: 'child' }));
    const inPlace = await startBranch(narrow.store, snapshot(), { at: 'end' }, { open: 'beside' }, deps({ openBeside: vi.fn(async () => 'in-place' as const) }));
    expect(narrow.openSession).toHaveBeenCalledWith('child');
    expect(inPlace).not.toHaveProperty('noRoom');

    const none = fakeStore(async () => ({ sessionId: 'child' }));
    const untouched = deps();
    await startBranch(none.store, snapshot(), { at: 'end' }, { open: 'none' }, untouched);
    expect(none.openSession).not.toHaveBeenCalled();
    expect(untouched.openBeside).not.toHaveBeenCalled();
  });

  it('opens nothing and replaces no pane when four panes leave no room, but keeps the draft and says so', async () => {
    const { store, updateDraft, openSession } = fakeStore(async () => ({ sessionId: 'child' }));
    const result = await startBranch(store, snapshot(), { at: 'end' }, { draft: 'kept', open: 'beside' }, deps({ openBeside: vi.fn(async () => 'full' as const) }));
    expect(result).toEqual({ ok: true, sessionId: 'child', title: 'Cache sizing (branch)', mode: 'native', noRoom: true });
    expect(openSession).not.toHaveBeenCalled();
    expect(updateDraft).toHaveBeenCalledWith('child', 'kept');
  });

  it('keeps the chat and reports a first message that was refused', async () => {
    const { store, updateDraft } = fakeStore(async () => ({ sessionId: 'child', error: 'The message could not be sent.' }));
    const result = await startBranch(store, snapshot(), { at: 'end' }, { prompt: 'hello', draft: 'ignored', open: 'here' }, deps());
    expect(result).toEqual({ ok: true, sessionId: 'child', title: 'Cache sizing (branch)', mode: 'native', error: 'The message could not be sent.' });
    expect(updateDraft).not.toHaveBeenCalled();
  });
});
