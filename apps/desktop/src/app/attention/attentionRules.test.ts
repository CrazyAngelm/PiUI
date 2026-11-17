import { describe, expect, it } from 'vitest';
import {
  evaluateAttention,
  snapshotOf,
  strongerKind,
  type AttentionContext,
  type AttentionKind,
  type RuleApproval,
  type RuleSession,
} from './attentionRules';

const chat = (id: string, status: RuleSession['status'], runId?: string): RuleSession => ({ id, status, runId });
const ask = (id: string, sessionId: string): RuleApproval => ({ id, sessionId });

function run(
  before: { sessions: RuleSession[]; approvals?: RuleApproval[] } | undefined,
  after: { sessions: RuleSession[]; approvals?: RuleApproval[] },
  context: Partial<AttentionContext> = {},
) {
  return evaluateAttention(
    before === undefined ? undefined : snapshotOf(before.sessions, before.approvals ?? []),
    snapshotOf(after.sessions, after.approvals ?? []),
    { sessions: after.sessions, visible: new Set(), focused: false, unseen: new Map(), isSidekick: () => false, ...context },
  );
}

describe('attention rules', () => {
  it('raises "finished" when a running chat becomes idle', () => {
    const verdict = run({ sessions: [chat('a', 'running')] }, { sessions: [chat('a', 'idle')] });
    expect(verdict.raised).toEqual([{ sessionId: 'a', kind: 'finished' }]);
    expect(verdict.cleared).toEqual([]);
  });

  it('raises "finished" when a stopping chat becomes idle', () => {
    expect(run({ sessions: [chat('a', 'stopping')] }, { sessions: [chat('a', 'idle')] }).raised).toEqual([{ sessionId: 'a', kind: 'finished' }]);
  });

  it('does not raise for a chat that was starting, idle or closed before', () => {
    for (const before of ['starting', 'idle', 'closed'] as const) {
      expect(run({ sessions: [chat('a', before)] }, { sessions: [chat('a', 'idle')] }).raised, before).toEqual([]);
    }
  });

  it('raises "failed" when a chat becomes failed, once', () => {
    const failed = [chat('a', 'failed')];
    expect(run({ sessions: [chat('a', 'running')] }, { sessions: failed }).raised).toEqual([{ sessionId: 'a', kind: 'failed' }]);
    expect(run({ sessions: failed }, { sessions: failed }).raised).toEqual([]);
  });

  it('raises "decision" for an approval id that was not there before', () => {
    const sessions = [chat('a', 'running')];
    const verdict = run({ sessions, approvals: [ask('p1', 'a')] }, { sessions, approvals: [ask('p1', 'a'), ask('p2', 'a')] });
    expect(verdict.raised).toEqual([{ sessionId: 'a', kind: 'decision' }]);
    expect(run({ sessions, approvals: [ask('p1', 'a')] }, { sessions, approvals: [ask('p1', 'a')] }).raised).toEqual([]);
  });

  it('keeps the strongest reason when several happen to one chat in one observation', () => {
    const verdict = run({ sessions: [chat('a', 'running')] }, { sessions: [chat('a', 'idle')], approvals: [ask('p', 'a')] });
    expect(verdict.raised).toEqual([{ sessionId: 'a', kind: 'decision' }]);
  });

  it('does not raise "decision" for a request that arrives with a chat whose approvals were not loaded before', () => {
    const sessions = [chat('a', 'running')];
    const context: AttentionContext = { sessions, visible: new Set(), focused: false, unseen: new Map(), isSidekick: () => false };
    const before = snapshotOf(sessions, [], []);
    const loaded = snapshotOf(sessions, [ask('p', 'a')], ['a']);
    expect(evaluateAttention(before, loaded, context).raised).toEqual([]);
    // Once the chat's approvals are known, a new request is news.
    const next = snapshotOf(sessions, [ask('p', 'a'), ask('q', 'a')], ['a']);
    expect(evaluateAttention(loaded, next, context).raised).toEqual([{ sessionId: 'a', kind: 'decision' }]);
  });

  it('ranks decision over failed over finished', () => {
    const kinds: AttentionKind[] = ['finished', 'failed', 'decision'];
    expect(strongerKind('finished', 'failed')).toBe('failed');
    expect(strongerKind('decision', 'failed')).toBe('decision');
    expect(strongerKind('failed', 'finished')).toBe('failed');
    expect(kinds.every((kind) => strongerKind(kind, kind) === kind)).toBe(true);
  });

  it('raises nothing on the first observation', () => {
    const verdict = run(undefined, { sessions: [chat('a', 'idle'), chat('b', 'failed')], approvals: [ask('p', 'a')] });
    expect(verdict).toEqual({ raised: [], cleared: [] });
  });

  it('raises nothing for a chat that is new in this observation', () => {
    expect(run({ sessions: [] }, { sessions: [chat('a', 'idle')] }).raised).toEqual([]);
  });

  it('skips pipeline members', () => {
    const verdict = run({ sessions: [chat('a', 'running', 'run-1')] }, { sessions: [chat('a', 'idle', 'run-1')], approvals: [ask('p', 'a')] });
    expect(verdict.raised).toEqual([]);
  });

  it('skips Fusion sidekick chats and not their lead', () => {
    const before = [chat('lead', 'running'), chat('side', 'running')];
    const after = [chat('lead', 'idle'), chat('side', 'idle')];
    const verdict = run({ sessions: before }, { sessions: after }, { isSidekick: (id) => id === 'side' });
    expect(verdict.raised).toEqual([{ sessionId: 'lead', kind: 'finished' }]);
  });

  it('raises a Fusion sidekick approval request and failure, never its normal finish', () => {
    const isSidekick = (id: string) => id === 'side';
    const asked = run(
      { sessions: [chat('side', 'running')], approvals: [] },
      { sessions: [chat('side', 'running')], approvals: [ask('p1', 'side')] },
      { isSidekick },
    );
    expect(asked.raised).toEqual([{ sessionId: 'side', kind: 'decision' }]);
    const failed = run({ sessions: [chat('side', 'running')] }, { sessions: [chat('side', 'failed')] }, { isSidekick });
    expect(failed.raised).toEqual([{ sessionId: 'side', kind: 'failed' }]);
    const finished = run({ sessions: [chat('side', 'running')] }, { sessions: [chat('side', 'idle')] }, { isSidekick });
    expect(finished.raised).toEqual([]);
  });

  it('never raises "finished" for a chat an agent started, but still raises "failed" and "decision"', () => {
    const agentChild = { isAgentChild: (id: string) => id === 'kid' };
    const done = run({ sessions: [chat('kid', 'running'), chat('main', 'running')] }, { sessions: [chat('kid', 'idle'), chat('main', 'idle')] }, agentChild);
    expect(done.raised).toEqual([{ sessionId: 'main', kind: 'finished' }]);
    const failed = run({ sessions: [chat('kid', 'running')] }, { sessions: [chat('kid', 'failed')] }, agentChild);
    expect(failed.raised).toEqual([{ sessionId: 'kid', kind: 'failed' }]);
    const asking = run({ sessions: [chat('kid', 'running')] }, { sessions: [chat('kid', 'idle')], approvals: [ask('p', 'kid')] }, agentChild);
    expect(asking.raised).toEqual([{ sessionId: 'kid', kind: 'decision' }]);
  });

  it('raises "finished" for every chat when no agent-child test is supplied', () => {
    expect(run({ sessions: [chat('kid', 'running')] }, { sessions: [chat('kid', 'idle')] }).raised).toEqual([{ sessionId: 'kid', kind: 'finished' }]);
  });

  it('raises nothing for a chat on screen in a focused window', () => {
    const verdict = run({ sessions: [chat('a', 'running')] }, { sessions: [chat('a', 'idle')], approvals: [ask('p', 'a')] }, { visible: new Set(['a']), focused: true });
    expect(verdict.raised).toEqual([]);
  });

  it('raises for a visible chat when the window is not focused, and for a focused window showing another chat', () => {
    const before = { sessions: [chat('a', 'running')] };
    const after = { sessions: [chat('a', 'idle')] };
    expect(run(before, after, { visible: new Set(['a']), focused: false }).raised).toHaveLength(1);
    expect(run(before, after, { visible: new Set(['b']), focused: true }).raised).toHaveLength(1);
  });

  describe('clearing', () => {
    const idle = [chat('a', 'idle')];

    it('clears a waiting chat when it is shown in a focused window', () => {
      const verdict = run({ sessions: idle }, { sessions: idle }, { unseen: new Map([['a', 'finished']]), visible: new Set(['a']), focused: true });
      expect(verdict.cleared).toEqual(['a']);
    });

    it('keeps it while the window is not focused or another chat is shown', () => {
      const unseen = new Map<string, AttentionKind>([['a', 'finished']]);
      expect(run({ sessions: idle }, { sessions: idle }, { unseen, visible: new Set(['a']), focused: false }).cleared).toEqual([]);
      expect(run({ sessions: idle }, { sessions: idle }, { unseen, visible: new Set(['b']), focused: true }).cleared).toEqual([]);
    });

    it('clears a finished or failed chat that starts working again', () => {
      for (const kind of ['finished', 'failed'] as const) {
        for (const status of ['running', 'starting'] as const) {
          const verdict = run({ sessions: idle }, { sessions: [chat('a', status)] }, { unseen: new Map([['a', kind]]) });
          expect(verdict.cleared, `${kind} ${status}`).toEqual(['a']);
        }
      }
    });

    it('keeps a decision while its approval waits, even though the chat runs', () => {
      const sessions = [chat('a', 'running')];
      const verdict = run({ sessions, approvals: [ask('p', 'a')] }, { sessions, approvals: [ask('p', 'a')] }, { unseen: new Map([['a', 'decision']]) });
      expect(verdict.cleared).toEqual([]);
    });

    it('clears a decision when no approval is left', () => {
      const verdict = run({ sessions: idle, approvals: [ask('p', 'a')] }, { sessions: idle }, { unseen: new Map([['a', 'decision']]) });
      expect(verdict.cleared).toEqual(['a']);
    });

    it('clears a chat that disappeared or closed', () => {
      const unseen = new Map<string, AttentionKind>([['a', 'finished'], ['b', 'failed']]);
      const verdict = run({ sessions: [chat('a', 'idle'), chat('b', 'failed')] }, { sessions: [chat('b', 'closed')] }, { unseen });
      expect([...verdict.cleared].sort()).toEqual(['a', 'b']);
    });

    it('clears and raises in one observation: a decision answered while the turn ended', () => {
      const verdict = run(
        { sessions: [chat('a', 'running')], approvals: [ask('p', 'a')] },
        { sessions: [chat('a', 'idle')] },
        { unseen: new Map([['a', 'decision']]) },
      );
      expect(verdict.cleared).toEqual(['a']);
      expect(verdict.raised).toEqual([{ sessionId: 'a', kind: 'finished' }]);
    });
  });
});
