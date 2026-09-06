import type { PrimeActivity } from '../../host-api/types';

// Matches the host's fixed 256-event live-runtime queue, so activity state
// cannot retain more rows than one bounded host delivery window.
export const MAX_RETAINED_PRIME_ACTIVITIES = 256;

function primeActivitySlot(activity: PrimeActivity): string {
  switch (activity.type) {
    case 'goal': return 'singleton:goal';
    case 'sessionActions': return 'singleton:session-actions';
    case 'recap': return 'singleton:recap';
    case 'refinement': return 'singleton:refinement';
    case 'heartbeat': return 'singleton:heartbeat';
    default: return `id:${activity.id}`;
  }
}

export function upsertPrimeActivity(
  current: readonly PrimeActivity[],
  activity: PrimeActivity,
): PrimeActivity[] {
  // Defend this boundary too: callers may supply stale state created before
  // retention existed. Every allocation and scan below stays within the same
  // fixed window as the host event queue.
  const retained = current.length > MAX_RETAINED_PRIME_ACTIVITIES
    ? current.slice(-MAX_RETAINED_PRIME_ACTIVITIES)
    : current;
  const slot = primeActivitySlot(activity);
  const withoutSlot = retained.filter((candidate) => primeActivitySlot(candidate) !== slot);
  const next = [...withoutSlot, activity];
  return next.length > MAX_RETAINED_PRIME_ACTIVITIES
    ? next.slice(-MAX_RETAINED_PRIME_ACTIVITIES)
    : next;
}

export function primeActivityTitle(activity: PrimeActivity): string {
  switch (activity.type) {
    case 'rlmChild': return activity.label;
    case 'goal': return activity.objective ?? 'Thread goal';
    case 'sessionActions': return 'Session actions';
    case 'recap': return 'Session recap';
    case 'authentication': return `Authentication · ${activity.provider}`;
    case 'refinement': return 'Harness refinement';
    case 'bash': return 'Background command';
    case 'heartbeat': return 'Heartbeat';
    case 'schedule': return `${activity.source.replace('_', ' ')} schedule`;
    case 'unknown': return 'Prime compatibility event';
  }
}

export function primeActivityStatus(activity: PrimeActivity): string {
  switch (activity.type) {
    case 'sessionActions': return activity.activeCount > 0 ? 'active' : activity.queuedCount > 0 ? 'queued' : 'idle';
    case 'recap': return activity.summary ? 'updated' : 'available';
    case 'authentication': return activity.status;
    case 'unknown': return 'unsupported';
    default: return activity.status;
  }
}

export function primeActivityDetail(activity: PrimeActivity): string | undefined {
  switch (activity.type) {
    case 'rlmChild': {
      const parts: string[] = [activity.model, activity.activity, activity.toolName]
        .filter((part): part is string => part !== undefined);
      if (activity.tokenCount !== undefined) parts.push(`${activity.tokenCount.toLocaleString()} tokens`);
      if (activity.toolUseCount !== undefined) parts.push(`${activity.toolUseCount} tool ${activity.toolUseCount === 1 ? 'call' : 'calls'}`);
      if (activity.durationMs !== undefined) parts.push(`${Math.round(activity.durationMs / 1000)}s`);
      return parts.join(' · ') || undefined;
    }
    case 'goal': {
      const usage = activity.tokenBudget === undefined
        ? `${activity.tokensUsed.toLocaleString()} tokens`
        : `${activity.tokensUsed.toLocaleString()} / ${activity.tokenBudget.toLocaleString()} tokens`;
      return `${usage} · ${activity.timeUsedSeconds}s · ${activity.continuationsUsed} continuations`;
    }
    case 'sessionActions': return `${activity.activeCount} active · ${activity.queuedCount} queued`;
    case 'recap': return activity.summary;
    case 'authentication': return 'Credentials need attention in the Prime Agent runtime.';
    case 'refinement': return activity.status === 'complete' ? 'Refinement completed.' : 'Refinement failed.';
    case 'bash': return activity.exitCode === undefined ? undefined : `Exit code ${activity.exitCode}${activity.truncated ? ' · output truncated' : ''}`;
    case 'heartbeat': return [activity.schedule, activity.deliveryMode?.replace('_', ' ')].filter(Boolean).join(' · ') || undefined;
    case 'schedule': return activity.schedule;
    case 'unknown': return `Unsupported Prime event: ${activity.wireType}`;
  }
}

export function primeActivityStatusClass(value: string): string {
  if (['failed', 'error', 'stale'].includes(value)) return 'activity-status--failed';
  if (['running', 'active', 'executing', 'writing'].includes(value)) return 'activity-status--active';
  return '';
}
