import { vi } from 'vitest';
import type { SessionSnapshot, WorkspaceEvent, WorkspaceResult } from './labContracts';
import { createLabHost, type LabHost, type LabHostOptions } from './labHost';
import type { LabScenarioName } from './labState';

/** Test helpers shared by the lab suites (never imported by production code). */
export interface Recorded<T> {
  readonly items: T[];
  stop(): void;
}

export async function record<T>(host: LabHost, channel: string): Promise<Recorded<T>> {
  const items: T[] = [];
  const stop = await host.listen<T>(channel, (payload) => items.push(payload));
  return { items, stop };
}

export function labHost(scenario: LabScenarioName = 'demo', options: Omit<LabHostOptions, 'scenario'> = {}): LabHost {
  return createLabHost({ scenario, ambient: false, ...options });
}

/** Revisions of one session's events must be strictly consecutive, starting after `from`. */
export function consecutive(events: readonly WorkspaceEvent[], sessionId: string, from: number): boolean {
  return events
    .filter((event) => event.sessionId === sessionId)
    .every((event, index) => event.revision === from + index + 1);
}

export async function snapshotOf(host: LabHost, sessionId: string): Promise<SessionSnapshot> {
  const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'snapshot', sessionId } });
  if (result.type !== 'session') throw new Error('Expected a session snapshot.');
  return result.snapshot;
}

/** Advances fake time, approving any request, until the session is idle again. */
export async function settle(host: LabHost, sessionId: string, maxSeconds = 120): Promise<SessionSnapshot> {
  for (let second = 0; second < maxSeconds; second += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    const current = await snapshotOf(host, sessionId);
    const [approval] = current.approvals;
    if (approval !== undefined) {
      await host.invoke('workspace_command_v15', {
        command: { type: 'respond', sessionId, requestId: approval.id, decision: approval.decisions[0] },
      });
    } else if (current.session.status === 'idle') {
      return current;
    }
  }
  throw new Error('The session did not settle.');
}

/** Advances fake time in small steps until a block is streaming. */
export async function untilStreaming(host: LabHost, sessionId: string): Promise<SessionSnapshot> {
  for (let step = 0; step < 200; step += 1) {
    const current = await snapshotOf(host, sessionId);
    if (current.blocks.some((block) => block.status === 'streaming')) return current;
    await vi.advanceTimersByTimeAsync(40);
  }
  throw new Error('No block started streaming.');
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the lab host to reject.');
}
