import { describe, expect, it } from 'vitest';
import { reconcileSelection, restoredSelection, type NewChatSelection } from './newChatChoice';

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
    // The user picked Codex and a model while the project remembers Pi.
    const picked: NewChatSelection = { harness: 'codex', modelKey: MODEL, thinkingLevel: 'high', fast: false, permissionMode: 'workspace-write' };
    const remembered = { harness: 'pi' as const, modelKey: '', permissionMode: 'native' as const };
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
});
