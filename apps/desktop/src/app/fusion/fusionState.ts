import type { Status } from '../../lib/ui';
import type {
  BriefOutcomeV1,
  BriefStateV1,
  FusionBriefV1,
  FusionDeliveryV1,
  FusionRoundV1,
  FusionStateV1,
  ReportStatusV1,
  RoundOutcomeV1,
  RoundStateV1,
  SidekickStateV1,
} from '../../host-api/fusionClient';

/**
 * Presentation of the Fusion journal (ADR-043). Every label is an English
 * locale key; the host owns the facts, this module only words them.
 */

export function sidekickStateLabel(state: SidekickStateV1): string {
  switch (state) {
    case 'none':
      return 'not started';
    case 'idle':
      return 'idle';
    case 'working':
      return 'working';
    case 'waitingApproval':
      return 'waiting for approval';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'unavailable';
    default:
      return assertNever(state);
  }
}

export function sidekickStateDot(state: SidekickStateV1): Status {
  switch (state) {
    case 'none':
      return 'offline';
    case 'idle':
      return 'idle';
    case 'working':
      return 'running';
    case 'waitingApproval':
      return 'waiting';
    case 'stopping':
      return 'waiting';
    case 'unavailable':
      return 'failed';
    default:
      return assertNever(state);
  }
}

export function roundStateLabel(state: RoundStateV1): string {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waitingApproval':
      return 'waiting for approval';
    case 'stopping':
      return 'stopping';
    case 'finished':
      return 'finished';
    case 'uncertain':
      return 'uncertain';
    default:
      return assertNever(state);
  }
}

export function roundOutcomeLabel(outcome: RoundOutcomeV1): string {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'no-answer':
      return 'no answer';
    case 'uncertain':
      return 'uncertain';
    default:
      return assertNever(outcome);
  }
}

export function reportStatusLabel(status: ReportStatusV1): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'partial':
      return 'partial';
    case 'blocked':
      return 'blocked';
    case 'needs-decision':
      return 'needs a decision';
    case 'unknown':
      return 'status unknown';
    default:
      return assertNever(status);
  }
}

export function briefStateLabel(state: BriefStateV1): string {
  switch (state) {
    case 'active':
      return 'active';
    case 'reported':
      return 'reported';
    case 'closed':
      return 'closed';
    case 'stopped':
      return 'stopped';
    default:
      return assertNever(state);
  }
}

export function briefOutcomeLabel(outcome: BriefOutcomeV1): string {
  switch (outcome) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'superseded':
      return 'superseded';
    default:
      return assertNever(outcome);
  }
}

export function deliveryLabel(state: FusionDeliveryV1['state']): string {
  switch (state) {
    case 'queued':
      return 'report queued';
    case 'sending':
      return 'report being delivered';
    case 'sent':
      return 'report delivered';
    case 'uncertain':
      return 'delivery uncertain';
    case 'withdrawn':
      return 'report withdrawn';
    default:
      return assertNever(state);
  }
}

/** The dot of a round: live work is running, a lost or failed round needs the person. */
export function roundDot(round: FusionRoundV1): Status {
  switch (round.state) {
    case 'queued':
    case 'stopping':
    case 'waitingApproval':
      return 'waiting';
    case 'running':
      return 'running';
    case 'uncertain':
      return 'failed';
    case 'finished':
      if (round.outcome === 'failed' || round.outcome === 'uncertain') return 'failed';
      if (round.outcome === 'interrupted' || round.outcome === 'no-answer') return 'waiting';
      return round.status === 'blocked' || round.status === 'needs-decision' ? 'waiting' : 'done';
    default:
      return assertNever(round.state);
  }
}

/** Rounds whose fate the host cannot know after a restart; only the person decides them. */
export function uncertainRounds(brief: FusionBriefV1): FusionRoundV1[] {
  return brief.rounds.filter((round) => round.state === 'uncertain');
}

export function hasUncertainRound(state: FusionStateV1): boolean {
  return state.briefs.some((brief) => uncertainRounds(brief).length > 0);
}

/** The sidekick session that is current (not retired), if any. */
export function currentSidekickSession(state: FusionStateV1): FusionStateV1['sessions'][number] | undefined {
  for (let index = state.sessions.length - 1; index >= 0; index -= 1) {
    const session = state.sessions[index];
    if (session && !session.retired) return session;
  }
  return undefined;
}

/** Newest brief first: the person cares about what is happening now. */
export function briefsNewestFirst(state: FusionStateV1): FusionBriefV1[] {
  return [...state.briefs].reverse();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Fusion value: ${String(value)}`);
}
