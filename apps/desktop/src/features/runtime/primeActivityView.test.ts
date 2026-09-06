import { describe, expect, it } from 'vitest';
import type { PrimeActivity } from '../../host-api/types';
import {
  MAX_RETAINED_PRIME_ACTIVITIES,
  primeActivityDetail,
  primeActivityStatus,
  primeActivityStatusClass,
  primeActivityTitle,
  upsertPrimeActivity,
} from './primeActivityView';

function bashActivity(index: number): PrimeActivity {
  return { type: 'bash', id: `bash-${index}`, status: 'complete', exitCode: 0 };
}

describe('Prime activity presentation', () => {
  it('renders a bounded RLM child projection without requiring a raw event payload', () => {
    const activity: PrimeActivity = {
      type: 'rlmChild',
      id: 'opaque-child',
      label: 'Subagent',
      status: 'running',
      model: 'review-model',
      activity: 'executing',
      toolName: 'read',
      toolUseCount: 2,
      tokenCount: 1200,
    };

    expect(primeActivityTitle(activity)).toBe('Subagent');
    expect(primeActivityStatus(activity)).toBe('running');
    expect(primeActivityDetail(activity)).toContain('review-model');
    expect(primeActivityDetail(activity)).toContain('2 tool calls');
    expect(primeActivityStatusClass(primeActivityStatus(activity))).toBe('activity-status--active');
    expect(Object.keys(activity)).not.toContain('payload');
  });

  it('distinguishes active, queued, and idle session actions', () => {
    expect(primeActivityStatus({ type: 'sessionActions', id: 'actions', activeCount: 1, queuedCount: 0 })).toBe('active');
    expect(primeActivityStatus({ type: 'sessionActions', id: 'actions', activeCount: 0, queuedCount: 2 })).toBe('queued');
    expect(primeActivityStatus({ type: 'sessionActions', id: 'actions', activeCount: 0, queuedCount: 0 })).toBe('idle');
  });

  it('reconciles singleton goal state and resets cleanly at a runtime boundary', () => {
    const idle: PrimeActivity = {
      type: 'goal', id: 'opaque-idle', status: 'idle', tokensUsed: 0,
      timeUsedSeconds: 0, continuationsUsed: 0,
    };
    const active: PrimeActivity = {
      type: 'goal', id: 'opaque-active', status: 'active', objective: 'Ship safely',
      tokensUsed: 10, timeUsedSeconds: 2, continuationsUsed: 1,
    };
    const reconciled = upsertPrimeActivity(upsertPrimeActivity([], idle), active);
    expect(reconciled).toEqual([active]);
    expect(upsertPrimeActivity([], active)).toEqual([active]);
  });

  it('caps adversarial unique activity state and evicts only the oldest rows', () => {
    const overfull = Array.from(
      { length: MAX_RETAINED_PRIME_ACTIVITIES + 5 },
      (_, index) => bashActivity(index),
    );
    const fallback: PrimeActivity = { type: 'unknown', id: 'future-event', wireType: 'future_event' };

    const retained = upsertPrimeActivity(overfull, fallback);

    expect(retained).toHaveLength(MAX_RETAINED_PRIME_ACTIVITIES);
    expect(retained[0]?.id).toBe('bash-6');
    expect(retained.at(-1)).toEqual(fallback);
    expect(retained.some((activity) => activity.id === 'bash-0')).toBe(false);
  });

  it('keeps unknown and stale-auth events readable through safe generic fallbacks', () => {
    const unknown: PrimeActivity = { type: 'unknown', id: 'opaque', wireType: 'future_event' };
    const stale: PrimeActivity = { type: 'authentication', id: 'auth', provider: 'provider', status: 'stale' };

    expect(primeActivityTitle(unknown)).toBe('Prime compatibility event');
    expect(primeActivityDetail(unknown)).toBe('Unsupported Prime event: future_event');
    expect(primeActivityStatusClass(primeActivityStatus(stale))).toBe('activity-status--failed');
    expect(primeActivityDetail(stale)).not.toContain('token');
  });
});
