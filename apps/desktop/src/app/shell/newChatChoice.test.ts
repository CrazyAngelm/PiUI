import { describe, expect, it } from 'vitest';
import { choiceFor, reconcileSelection, restoredSelection, withChoice, type NewChatSelection } from './newChatChoice';

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
