import type {
  DesktopTimelineBlock, HarnessKind, HarnessSummary, PermissionMode, QueuedMessage, SessionStatus, UsageReceipt,
  WorkspaceApproval, WorkspaceModel,
} from '../labContracts';
import {
  newLiveState, newQueue,
  type LabOrchestrationWorkspace, type LabProject, type LabSessionRecord,
} from '../labState';
import type { ApprovalStep, TurnStep } from '../turnScripts';

/** Live activity a scenario starts once the runtime exists (timers only run when ambient). */
export type SeedActivity =
  | { readonly kind: 'ambient-stream'; readonly sessionId: string; readonly firstCycle: number }
  | { readonly kind: 'paused-approval'; readonly sessionId: string; readonly approvalId: string; readonly step: ApprovalStep }
  | {
    readonly kind: 'running-task';
    readonly workspaceId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly steps: readonly TurnStep[];
  };

export interface LabSeed {
  safeMode: boolean;
  projects: LabProject[];
  harnesses: HarnessSummary[];
  sessions: LabSessionRecord[];
  orchestration: LabOrchestrationWorkspace[];
  activity: SeedActivity[];
}

export interface SessionSeed {
  id: string;
  workspaceId: string;
  harness: HarnessKind;
  title: string;
  blocks: DesktopTimelineBlock[];
  updatedAt: string;
  model: WorkspaceModel;
  thinkingLevel?: string;
  serviceTier?: 'standard' | 'fast';
  permissionMode?: PermissionMode;
  /** Absent: the session is closed (history only). */
  live?: SessionStatus;
  approvals?: WorkspaceApproval[];
  usage?: UsageReceipt[];
  queue?: { paused: boolean; items: QueuedMessage[] };
  run?: { runId: string; memberId: string; profileId: string };
}

export function sessionRecord(seed: SessionSeed): LabSessionRecord {
  const record: LabSessionRecord = {
    id: seed.id,
    workspaceId: seed.workspaceId,
    harness: seed.harness,
    title: seed.title,
    updatedAt: seed.updatedAt,
    model: seed.model,
    ...(seed.thinkingLevel === undefined ? {} : { thinkingLevel: seed.thinkingLevel }),
    ...(seed.serviceTier === undefined ? {} : { serviceTier: seed.serviceTier }),
    permissionMode: seed.permissionMode ?? 'native',
    ...(seed.run === undefined ? {} : { runId: seed.run.runId, memberId: seed.run.memberId, profileId: seed.run.profileId }),
    // Seeded history counts as already-published events.
    revision: seed.blocks.length + 2,
    blocks: seed.blocks,
    usage: seed.usage ?? [],
    composer: seed.queue === undefined ? newQueue() : { revision: seed.queue.items.length + 1, ...seed.queue },
    turnSerial: 0,
  };
  if (seed.live !== undefined) {
    record.live = newLiveState(seed.live);
    record.live.approvals = seed.approvals ?? [];
  }
  return record;
}

/** Deterministic usage receipt for seeded sessions. */
export function seededUsage(id: string, inputTokens: number, outputTokens: number): UsageReceipt {
  return {
    id,
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.floor(inputTokens * 0.6),
    cacheWriteTokens: Math.floor(inputTokens * 0.05),
    totalTokens: inputTokens + outputTokens,
  };
}
