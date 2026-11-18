import type { SessionStatus } from '../../../../../contracts/workspace-v15';

/** Why a chat is waiting to be seen. A decision outranks a failure, which outranks a finished turn. */
export type AttentionKind = 'finished' | 'decision' | 'failed';

const RANK: Record<AttentionKind, number> = { finished: 0, failed: 1, decision: 2 };

/** The stronger of two reasons. */
export function strongerKind(a: AttentionKind, b: AttentionKind): AttentionKind {
  return RANK[b] > RANK[a] ? b : a;
}

/** The part of a session the rules look at. */
export interface RuleSession {
  readonly id: string;
  readonly status: SessionStatus;
  /** Set for a pipeline member: it is not an ordinary chat. */
  readonly runId?: string | undefined;
}

/** The part of a pending approval the rules look at. */
export interface RuleApproval {
  readonly id: string;
  readonly sessionId: string;
}

/** One observation of the workspace. */
export interface AttentionSnapshot {
  readonly statuses: ReadonlyMap<string, SessionStatus>;
  /** Approval id -> the chat that asks. */
  readonly approvals: ReadonlyMap<string, string>;
  /** Chats whose approvals this observation knows. Absent: every chat counts as known. */
  readonly known?: ReadonlySet<string>;
}

export function snapshotOf(
  sessions: readonly RuleSession[],
  approvals: readonly RuleApproval[],
  known: readonly string[] | undefined = undefined,
): AttentionSnapshot {
  return {
    statuses: new Map(sessions.map((session) => [session.id, session.status])),
    approvals: new Map(approvals.map((approval) => [approval.id, approval.sessionId])),
    ...(known === undefined ? {} : { known: new Set(known) }),
  };
}

export interface AttentionContext {
  /** The sessions of the current observation. */
  readonly sessions: readonly RuleSession[];
  /** Chats on screen right now. */
  readonly visible: ReadonlySet<string>;
  /** The window is in front and focused. */
  readonly focused: boolean;
  /** Chats that are already waiting to be seen, with their reason. */
  readonly unseen: ReadonlyMap<string, AttentionKind>;
  /** A Fusion sidekick chat: the lead's chat is the one that speaks. */
  readonly isSidekick: (sessionId: string) => boolean;
  /** A chat an agent started (linked chats): its report goes to the parent chat, so it never raises "finished". */
  readonly isAgentChild?: (sessionId: string) => boolean;
}

export interface AttentionRaise {
  readonly sessionId: string;
  readonly kind: AttentionKind;
}

export interface AttentionVerdict {
  /** Chats that became unseen in this observation (the strongest reason per chat). */
  readonly raised: readonly AttentionRaise[];
  /** Waiting chats that no longer are. */
  readonly cleared: readonly string[];
}

const WORKING: readonly SessionStatus[] = ['starting', 'running'];

function endsTurn(before: SessionStatus | undefined, now: SessionStatus): boolean {
  return (before === 'running' || before === 'stopping') && now === 'idle';
}

/**
 * Compares two observations and says which chats need a person and which no
 * longer do. Pure: the caller keeps the previous observation and the waiting set.
 *
 * - A turn ended: `running` or `stopping` became `idle`. It failed: the status became `failed`.
 *   It asks: an approval id appeared that the previous observation did not have, in a chat whose
 *   approvals that observation already knew. A chat loaded at start-up brings its old requests with it.
 * - Pipeline members and Fusion sidekick chats never count. A chat an agent started (`isAgentChild`) never
 *   raises "finished" (its report goes to the parent chat) but still asks and fails.
 * - A chat that is on screen in a focused window raises nothing.
 * - A waiting chat is cleared when it is on screen in a focused window, when it vanished or closed, when a
 *   finished or failed chat works again, and when a chat that asked has no approval left.
 * - Without a previous observation (the first one after start-up) nothing is raised.
 */
export function evaluateAttention(previous: AttentionSnapshot | undefined, current: AttentionSnapshot, context: AttentionContext): AttentionVerdict {
  const byId = new Map(context.sessions.map((session) => [session.id, session]));
  const asking = new Set(current.approvals.values());
  const watching = (id: string): boolean => context.focused && context.visible.has(id);

  const cleared: string[] = [];
  for (const [id, kind] of context.unseen) {
    const session = byId.get(id);
    const gone = session === undefined || session.status === 'closed';
    const working = session !== undefined && WORKING.includes(session.status);
    const answered = kind === 'decision' && !asking.has(id);
    if (gone || watching(id) || answered || (kind !== 'decision' && working)) cleared.push(id);
  }

  const raised = new Map<string, AttentionKind>();
  const raise = (id: string, kind: AttentionKind): void => {
    const session = byId.get(id);
    if (session === undefined || session.runId !== undefined || watching(id)) return;
    // A Fusion sidekick's normal finish is the lead's business; its approval requests and
    // failures need the person, and the raised chat is where that request is (ADR-076).
    if (kind === 'finished' && (context.isSidekick(id) || context.isAgentChild?.(id) === true)) return;
    const known = raised.get(id);
    raised.set(id, known === undefined ? kind : strongerKind(known, kind));
  };

  if (previous !== undefined) {
    for (const session of context.sessions) {
      const before = previous.statuses.get(session.id);
      if (endsTurn(before, session.status)) raise(session.id, 'finished');
      else if (session.status === 'failed' && before !== undefined && before !== 'failed') raise(session.id, 'failed');
    }
    for (const [approvalId, sessionId] of current.approvals) {
      if (previous.approvals.has(approvalId)) continue;
      // The chat's approvals were not loaded before: this request is as old as that load, not news.
      if (previous.known !== undefined && !previous.known.has(sessionId)) continue;
      raise(sessionId, 'decision');
    }
  }

  return { raised: [...raised].map(([sessionId, kind]) => ({ sessionId, kind })), cleared };
}
