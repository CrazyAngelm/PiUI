import { describe, expect, it } from 'vitest';
import { TEAMMATE_HANDLE_PATTERN, type TeammateV1 } from '../../host-api/teammatesClient';
import { activeHandleQuery, handleFromName, handleProblem, initials, insertHandle, mentionSpans, rankTeammates, transliterate, uniqueHandle } from './handle';

function teammate(id: string, handle: string, patch: Partial<TeammateV1> = {}): TeammateV1 {
  return {
    id, handle, name: handle, color: 'chaos', avatar: 'T', role: '', kind: { type: 'pipeline' }, launchCommandId: `cmd-${id}`,
    cardInput: { type: 'auto' }, board: { read: true, comment: true, create: false, move: false, claim: false, assign: false },
    maxConcurrentRuns: 1, wake: { onAssign: 'ask', onMention: true }, enabled: true, revision: 1, createdAt: '', updatedAt: '', ...patch,
  };
}

describe('teammate handles', () => {
  it('derives an ASCII handle from Latin and Cyrillic names', () => {
    expect(handleFromName('Code Reviewer')).toBe('code-reviewer');
    expect(handleFromName('Ревьюер кода')).toBe('revyuer-koda');
    expect(handleFromName('Юлия Щербакова')).toBe('yuliya-shcherbakova');
    expect(handleFromName('Йога-бот')).toBe('yoga-bot');
    expect(handleFromName('Crème brûlée')).toBe('creme-brulee');
    expect(transliterate('Ёж')).toBe('ezh');
  });

  it('always returns a valid handle', () => {
    for (const name of ['', '   ', '🚀', 'Q', '---', 'A'.repeat(80), 'Тест — релиз №2!']) {
      expect(handleFromName(name), name).toMatch(TEAMMATE_HANDLE_PATTERN);
    }
    expect(handleFromName('🚀')).toBe('teammate');
    expect(handleFromName('Q')).toBe('q-1');
    expect(handleFromName('A'.repeat(80))).toHaveLength(32);
  });

  it('makes handles unique in the project', () => {
    expect(uniqueHandle('coder', [])).toBe('coder');
    expect(uniqueHandle('coder', ['coder'])).toBe('coder-2');
    expect(uniqueHandle('coder', ['coder', 'coder-2'])).toBe('coder-3');
    const long = 'a'.repeat(32);
    expect(uniqueHandle(long, [long])).toMatch(TEAMMATE_HANDLE_PATTERN);
    expect(uniqueHandle(long, [long])).toHaveLength(32);
  });

  it('explains invalid handles', () => {
    expect(handleProblem('', [])).toBe('empty');
    expect(handleProblem('Coder', [])).toBe('pattern');
    expect(handleProblem('-coder', [])).toBe('pattern');
    expect(handleProblem('c', [])).toBe('pattern');
    expect(handleProblem('coder', ['coder'])).toBe('taken');
    expect(handleProblem('coder', [])).toBeUndefined();
  });

  it('builds initials', () => {
    expect(initials('Release team')).toBe('RT');
    expect(initials('coder')).toBe('CO');
    expect(initials('  ')).toBe('?');
  });
});

describe('@handle mentions', () => {
  const team = [teammate('t1', 'coder'), teammate('t2', 'release-team'), teammate('t3', 'reviewer', { enabled: false })];

  it('finds the query being typed and replaces it', () => {
    expect(activeHandleQuery('ask @co', 7)).toEqual({ start: 4, query: 'co' });
    expect(activeHandleQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeHandleQuery('mail a@b', 8)).toBeUndefined();
    expect(insertHandle('ask @co please', 7, 'coder')).toEqual({ text: 'ask @coder  please', caret: 11 });
  });

  it('ranks enabled teammates by handle prefix', () => {
    expect(rankTeammates(team, 're').map((item) => item.handle)).toEqual(['release-team']);
    expect(rankTeammates(team, '').map((item) => item.handle)).toEqual(['coder', 'release-team']);
  });

  it('stores known mentions as UTF-16 spans by teammate id', () => {
    const body = '@coder and (@release-team), not @nobody or mail@coder.';
    expect(mentionSpans(body, team)).toEqual([
      { teammateId: 't1', start: 0, length: 6 },
      { teammateId: 't2', start: 12, length: 13 },
    ]);
    const emoji = '🚀 @coder';
    expect(mentionSpans(emoji, team)).toEqual([{ teammateId: 't1', start: 3, length: 6 }]);
    expect(emoji.slice(3, 9)).toBe('@coder');
  });
});
