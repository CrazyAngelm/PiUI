import { describe, expect, it } from 'vitest';
import { choiceFor, executorOf, reconcileSelection, restoredSelection, startingExecutor, withChoice, type ExecutorFacts, type NewChatSelection } from './newChatChoice';

const MODEL = JSON.stringify(['openai-lab', 'gpt-lab-5-codex']);

describe('new-chat choice restore', () => {
  it('restores the remembered harness with its model settings', () => {
    expect(restoredSelection({ harness: 'codex', modelKey: MODEL, thinkingLevel: 'high', fast: true, permissionMode: 'read-only' }, ['pi', 'codex'])).toEqual({
      harness: 'codex', modelKey: MODEL, thinkingLevel: 'high', fast: true, permissionMode: 'read-only',
    });
  });

  it('falls back to the first available harness without another harness model', () => {
    expect(restoredSelection({ harness: 'hermes', modelKey: MODEL, thinkingLevel: 'high', fast: true }, ['pi', 'codex'])).toEqual({
      harness: 'pi', modelKey: '', thinkingLevel: '', fast: false, permissionMode: 'native',
    });
    expect(restoredSelection(undefined, [])).toEqual({ harness: '', modelKey: '', thinkingLevel: '', fast: false, permissionMode: 'native' });
  });

  it('keeps the user pick when the harness catalog refreshes (regression)', () => {
    // The user picked Codex and a model; every pick is remembered at once.
    const picked: NewChatSelection = { harness: 'codex', modelKey: MODEL, thinkingLevel: 'high', fast: false, permissionMode: 'workspace-write' };
    const remembered = { harness: 'codex' as const, modelKey: MODEL, thinkingLevel: 'high', permissionMode: 'workspace-write' as const };
    for (let refresh = 0; refresh < 3; refresh += 1) {
      expect(reconcileSelection(picked, ['pi', 'codex', 'claude-code'], remembered)).toBe(picked);
    }
  });

  it('restores once the first catalog arrives and replaces only a harness that disappeared', () => {
    const empty = restoredSelection({ harness: 'codex', modelKey: MODEL }, []);
    expect(empty.harness).toBe('');
    expect(reconcileSelection(empty, ['pi', 'codex'], { harness: 'codex', modelKey: MODEL })).toMatchObject({ harness: 'codex', modelKey: MODEL });
    const picked: NewChatSelection = { harness: 'hermes', modelKey: 'x', thinkingLevel: '', fast: false, permissionMode: 'read-only' };
    expect(reconcileSelection(picked, ['pi', 'codex'], { harness: 'codex', modelKey: MODEL })).toEqual({
      harness: 'codex', modelKey: MODEL, thinkingLevel: '', fast: false, permissionMode: 'read-only',
    });
  });

  it('a remembered harness that becomes available later replaces the startup fallback', () => {
    // An ACP agent is still being checked at startup: the first available harness stands in for it.
    const remembered = { harness: 'acp:opencode' as const, modelKey: MODEL, thinkingLevel: 'high' };
    const current = restoredSelection(remembered, ['pi']);
    expect(current).toMatchObject({ harness: 'pi', modelKey: '' });
    expect(reconcileSelection(current, ['pi', 'acp:opencode'], remembered)).toMatchObject({
      harness: 'acp:opencode', modelKey: MODEL, thinkingLevel: 'high',
    });
  });
});

describe('remembered choices', () => {
  const first = { harness: 'codex' as const, modelKey: MODEL, thinkingLevel: 'high' };
  const second = { harness: 'pi' as const, modelKey: '', permissionMode: 'read-only' as const };

  it('a project has its own choice, else the latest one, else nothing', () => {
    expect(choiceFor({ projects: {} }, 'a')).toBeUndefined();
    expect(choiceFor({ projects: { a: first }, last: second }, 'a')).toBe(first);
    expect(choiceFor({ projects: { a: first }, last: second }, 'b')).toBe(second);
    expect(choiceFor({ projects: { a: first } }, 'b')).toBeUndefined();
  });

  it('remembering a pick sets the project and the latest choice and keeps other projects', () => {
    const one = withChoice({ projects: {} }, 'a', first);
    expect(one).toEqual({ projects: { a: first }, last: first });
    const two = withChoice(one, 'b', second);
    expect(two).toEqual({ projects: { a: first, b: second }, last: second });
    expect(one, 'the earlier value is not mutated').toEqual({ projects: { a: first }, last: first });
  });
});

describe('remembered executor', () => {
  const pipeline = { pipeline: 'cmd-review', chatDefault: '' };

  it('belongs to its project: another project carries the harness and model, not the pipeline', () => {
    const own = { harness: 'codex' as const, modelKey: MODEL, executor: pipeline };
    const choices = { projects: { a: own }, last: own };
    expect(choiceFor(choices, 'a')).toBe(own);
    expect(choiceFor(choices, 'b')).toEqual({ harness: 'codex', modelKey: MODEL });
    expect(choiceFor(choices, 'b')).not.toHaveProperty('executor');
    expect(choices.last.executor, 'the stored latest choice is not changed').toBe(pipeline);
  });

  it('is kept when a pick is remembered, and a choice without one stays as before', () => {
    const next = withChoice({ projects: {} }, 'a', { harness: 'pi', executor: { pipeline: '' } });
    expect(next.projects.a?.executor).toEqual({ pipeline: '' });
    expect(next.last?.executor).toEqual({ pipeline: '' });
    expect(choiceFor({ projects: {}, last: { harness: 'pi' } }, 'a')).toEqual({ harness: 'pi' });
  });

  it('reads a stored value defensively', () => {
    expect(executorOf(undefined)).toBeUndefined();
    expect(executorOf({ harness: 'pi' })).toBeUndefined();
    expect(executorOf({ executor: pipeline })).toEqual(pipeline);
    expect(executorOf({ executor: { pipeline: '' } })).toEqual({ pipeline: '' });
    // The storage is editable text: anything but a pipeline id string is no memory.
    for (const bad of [null, 'review', 7, [], { pipeline: 3 }, { chatDefault: 'x' }]) {
      expect(executorOf({ executor: bad as never }), JSON.stringify(bad)).toBeUndefined();
    }
    expect(executorOf({ executor: { pipeline: 'p', chatDefault: 5 as never } })).toEqual({ pipeline: 'p' });
  });
});

describe('how a new chat starts', () => {
  const facts = (over: Partial<ExecutorFacts> = {}): ExecutorFacts => ({
    allowed: true,
    chatDefault: '',
    libraryFailed: false,
    rememberedUsable: undefined,
    ...over,
  });
  const direct = { ready: true, pipeline: '' } as const;

  it('starts directly when nothing is remembered and the project names no default', () => {
    expect(startingExecutor(undefined, facts())).toEqual(direct);
  });

  it('starts through the default pipeline when nothing is remembered', () => {
    expect(startingExecutor(undefined, facts({ chatDefault: 'cmd-default' }))).toEqual({ ready: true, pipeline: 'cmd-default' });
  });

  it('starts like the last chat: the remembered pipeline, once it is known to work', () => {
    const remembered = { pipeline: 'cmd-review', chatDefault: '' };
    expect(startingExecutor(remembered, facts())).toEqual({ ready: false });
    expect(startingExecutor(remembered, facts({ rememberedUsable: true }))).toEqual({ ready: true, pipeline: 'cmd-review' });
  });

  it('starts directly when the last chat was direct, though the project has a default pipeline it already had', () => {
    expect(startingExecutor({ pipeline: '', chatDefault: 'cmd-default' }, facts({ chatDefault: 'cmd-default' }))).toEqual(direct);
  });

  it('a deleted pipeline, or one without a message input, falls back to the default without an error', () => {
    const remembered = { pipeline: 'cmd-gone', chatDefault: 'cmd-default' };
    expect(startingExecutor(remembered, facts({ chatDefault: 'cmd-default', rememberedUsable: false }))).toEqual({ ready: true, pipeline: 'cmd-default' });
    expect(startingExecutor({ pipeline: 'cmd-gone', chatDefault: '' }, facts({ chatDefault: '', rememberedUsable: false }))).toEqual(direct);
    // A default that changed meanwhile decides without asking about the pipeline at all.
    expect(startingExecutor({ pipeline: 'cmd-gone', chatDefault: '' }, facts({ chatDefault: 'cmd-new' }))).toEqual({ ready: true, pipeline: 'cmd-new' });
  });

  it('a default the project set after the last chat wins over the memory, and so does a removed one', () => {
    expect(startingExecutor({ pipeline: '', chatDefault: '' }, facts({ chatDefault: 'cmd-new' }))).toEqual({ ready: true, pipeline: 'cmd-new' });
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: 'cmd-old' }, facts({ chatDefault: 'cmd-new', rememberedUsable: true }))).toEqual({ ready: true, pipeline: 'cmd-new' });
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: 'cmd-old' }, facts({ chatDefault: '', rememberedUsable: true }))).toEqual(direct);
  });

  it('a memory without a snapshot of the default stands as it is', () => {
    expect(startingExecutor({ pipeline: 'cmd-review' }, facts({ chatDefault: 'cmd-default', rememberedUsable: true }))).toEqual({ ready: true, pipeline: 'cmd-review' });
    expect(startingExecutor({ pipeline: '' }, facts({ chatDefault: 'cmd-default' }))).toEqual(direct);
  });

  it('waits for the library only where the decision needs it', () => {
    const pending = facts({ chatDefault: undefined });
    expect(startingExecutor(undefined, pending)).toEqual({ ready: false });
    expect(startingExecutor({ pipeline: '', chatDefault: '' }, pending)).toEqual({ ready: false });
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: '' }, { ...pending, rememberedUsable: true })).toEqual({ ready: false });
    // No snapshot to compare: a direct memory needs nothing, a pipeline needs only its own check.
    expect(startingExecutor({ pipeline: '' }, pending)).toEqual(direct);
    expect(startingExecutor({ pipeline: 'cmd-review' }, { ...pending, rememberedUsable: true })).toEqual({ ready: true, pipeline: 'cmd-review' });
    expect(startingExecutor({ pipeline: 'cmd-review' }, { ...pending, rememberedUsable: false })).toEqual({ ready: false });
  });

  it('a library that cannot be read leaves the memory in charge and the default out', () => {
    const failed = facts({ chatDefault: undefined, libraryFailed: true });
    expect(startingExecutor(undefined, failed)).toEqual(direct);
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: 'cmd-default' }, { ...failed, rememberedUsable: true })).toEqual({ ready: true, pipeline: 'cmd-review' });
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: 'cmd-default' }, { ...failed, rememberedUsable: false })).toEqual(direct);
    expect(startingExecutor({ pipeline: '', chatDefault: 'cmd-default' }, failed)).toEqual(direct);
  });

  it('safe mode and a restricted project always start directly', () => {
    const blocked = facts({ allowed: false, chatDefault: 'cmd-default', rememberedUsable: true });
    expect(startingExecutor({ pipeline: 'cmd-review', chatDefault: 'cmd-default' }, blocked)).toEqual(direct);
    expect(startingExecutor(undefined, blocked)).toEqual(direct);
  });
});
