import { liveLabel } from './catalogFake';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import {
  COMPOSER_EVENT_CHANNEL, WORKSPACE_EVENT_CHANNEL, WORKSPACE_EXTENSION_UI_EVENT,
  type ApprovalDecision, type DesktopTimelineBlock, type SessionStatus, type WorkspaceEvent, type WorkspaceEventPayload,
  type WorkspaceExtensionUiAction, type WorkspaceExtensionUiEventV1,
} from './labContracts';
import { NativeRejection } from './labErrors';
import {
  newLiveState, queuePending, sessionSummary,
  type LabQueue, type LabSessionRecord, type LabState,
} from './labState';
import { chatTurn, compactionTurn, withImageMarkers, type ApprovalStep, type TurnContext, type TurnStep } from './turnScripts';
import { isAcpHarness } from '../../../../../contracts/harness-identity-v2';

/** `lost`: the runtime was disposed before a terminal outcome (the host records uncertainty). */
export type TurnOutcome = 'succeeded' | 'failed' | 'interrupted' | 'lost';
export type TurnEndListener = (outcome: TurnOutcome) => void;

interface ActiveTurn {
  queue: TurnStep[];
  cancel?: () => void;
  approval?: { readonly id: string; readonly step: ApprovalStep };
  onEnd?: TurnEndListener;
}

export interface StartTurnOptions {
  onEnd?: TurnEndListener;
  /** `false` registers the turn without starting its timers (ambient activity disabled). */
  start?: boolean;
}

/**
 * The fake native runtimes. Owns live session state, publishes
 * `piui://workspace-event` with strictly increasing per-session revisions and
 * interprets turn scripts with timers. Nothing here touches files or network.
 */
export class LabSessions {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly idleListeners = new Set<(record: LabSessionRecord) => void>();
  private approvalSerial = 0;

  constructor(readonly state: LabState, private readonly bus: LabEventBus, readonly clock: LabClock) {}

  record(sessionId: string): LabSessionRecord | undefined {
    return this.state.sessions.get(sessionId);
  }

  /** Called whenever a live session returns to idle (composer drain, follow-ups). */
  onIdle(listener: (record: LabSessionRecord) => void): void {
    this.idleListeners.add(listener);
  }

  publish(record: LabSessionRecord, event: WorkspaceEventPayload): void {
    record.revision += 1;
    const payload: WorkspaceEvent = { protocol: 15, sessionId: record.id, revision: record.revision, event };
    this.bus.emit(WORKSPACE_EVENT_CHANNEL, payload);
  }

  /** Extension UI surfaces are ephemeral: no revision, nothing stored on the record. */
  publishSurface(record: LabSessionRecord, action: WorkspaceExtensionUiAction): void {
    const event: WorkspaceExtensionUiEventV1 = { protocol: 1, sessionId: record.id, action };
    this.bus.emit(WORKSPACE_EXTENSION_UI_EVENT, event);
  }

  publishSession(record: LabSessionRecord): void {
    this.publish(record, { type: 'session', session: sessionSummary(record) });
  }

  touch(record: LabSessionRecord): void {
    record.updatedAt = this.clock.iso();
  }

  /** Allocates the next turn number; turn scripts derive ids and randomness from it. */
  nextContext(record: LabSessionRecord): TurnContext {
    record.turnSerial += 1;
    const cwd = this.state.projects.find((project) => project.id === record.workspaceId)?.displayPath ?? '~/lab';
    return { harness: record.harness, sessionId: record.id, turn: record.turnSerial, permissionMode: record.permissionMode, cwd };
  }

  /** Starts a native runtime. The caller snapshots first, then publishes the session event. */
  open(record: LabSessionRecord, status: SessionStatus = 'idle'): void {
    record.live = newLiveState(status);
    this.touch(record);
  }

  /** Disposes the runtime without further events; the watermark advances like `close_session`. */
  close(record: LabSessionRecord): void {
    this.pauseQueue(record);
    const turn = this.turns.get(record.id);
    this.turns.delete(record.id);
    turn?.cancel?.();
    record.live = undefined;
    record.revision += 1;
    this.touch(record);
    turn?.onEnd?.('lost');
  }

  isBusy(record: LabSessionRecord): boolean {
    return this.turns.has(record.id);
  }

  startTurn(record: LabSessionRecord, steps: readonly TurnStep[], options: StartTurnOptions = {}): void {
    const turn: ActiveTurn = { queue: [...steps], onEnd: options.onEnd };
    this.turns.set(record.id, turn);
    if (options.start !== false) this.advance(record, turn);
  }

  /** Seeds a turn that is already waiting on an approval (no events: they happened "earlier"). */
  registerPausedTurn(record: LabSessionRecord, approvalId: string, step: ApprovalStep, rest: readonly TurnStep[]): void {
    this.turns.set(record.id, { queue: [...rest], approval: { id: approvalId, step } });
  }

  /** Native prompt semantics: steer joins the active turn; others queue behind it as follow-ups. */
  prompt(record: LabSessionRecord, text: string, mode: 'prompt' | 'steer' | 'follow-up', onEnd?: TurnEndListener, images = 0): void {
    this.requireRunning(record);
    if (mode === 'steer') {
      this.steer(record, withImageMarkers(text, images));
      return;
    }
    if (this.turns.has(record.id)) {
      record.live?.pendingPrompts.push(text);
      return;
    }
    this.touch(record);
    this.startTurn(record, chatTurn(this.nextContext(record), text, images), { onEnd });
  }

  compact(record: LabSessionRecord): void {
    this.requireRunning(record);
    if (this.turns.has(record.id) || record.live?.status !== 'idle') throw new NativeRejection('turn-active');
    this.startTurn(record, compactionTurn(this.nextContext(record)));
  }

  interrupt(record: LabSessionRecord): void {
    this.requireRunning(record);
    const turn = this.turns.get(record.id);
    if (turn === undefined && record.live?.status !== 'running') return;
    this.turns.delete(record.id);
    turn?.cancel?.();
    for (const block of record.blocks.filter((candidate) => candidate.status === 'streaming')) {
      this.putBlock(record, { ...block, status: 'interrupted' });
    }
    this.resolveAllApprovals(record);
    if (record.live) record.live.pendingPrompts = [];
    this.setStatus(record, 'idle');
    turn?.onEnd?.('interrupted');
    this.notifyIdle(record);
  }

  respond(record: LabSessionRecord, requestId: string, decision: ApprovalDecision): void {
    this.requireRunning(record);
    if (record.live) record.live.approvals = record.live.approvals.filter((approval) => approval.id !== requestId);
    this.publish(record, { type: 'approvalResolved', requestId });
    const turn = this.turns.get(record.id);
    if (turn?.approval?.id !== requestId) return;
    const { step } = turn.approval;
    turn.approval = undefined;
    turn.queue = decision === 'approve-once' || decision === 'approve-session'
      ? [...step.approved, ...turn.queue]
      : [...step.declined];
    turn.cancel = this.clock.after(250, () => {
      turn.cancel = undefined;
      this.advance(record, turn);
    });
  }

  /** Runtime-level pause plus a durable pause when messages are waiting (`pause_queue`). */
  pauseQueue(record: LabSessionRecord): void {
    if (record.live) record.live.composerPaused = true;
    if (queuePending(record.composer)) {
      this.changeQueue(record, (queue) => {
        queue.paused = true;
      });
    }
  }

  /**
   * Transactional outbox update (`change_queue`): mutates a copy, bumps the
   * revision only on success and notifies an attached composer.
   */
  changeQueue<T>(record: LabSessionRecord, change: (queue: LabQueue) => T): T {
    const draft: LabQueue = structuredClone(record.composer);
    const result = change(draft);
    draft.revision = record.composer.revision + 1;
    record.composer = draft;
    if (record.live?.composerNotify) this.bus.emit(COMPOSER_EVENT_CHANNEL, record.id);
    return result;
  }

  private requireRunning(record: LabSessionRecord): void {
    if (record.live?.status === 'failed') throw new NativeRejection('exited');
  }

  private steer(record: LabSessionRecord, text: string): void {
    if (record.harness === 'hermes' || isAcpHarness(record.harness)) throw new NativeRejection('unsupported');
    if (!this.turns.has(record.id) || record.live?.status !== 'running') throw new NativeRejection('no-active-turn');
    const serial = record.blocks.filter((block) => block.id.includes('-steer-')).length + 1;
    this.putBlock(record, {
      id: `live-${record.id.slice(0, 8)}-steer-${serial}`,
      kind: 'user',
      label: liveLabel(record.harness, 'user'),
      text,
      status: 'complete',
    });
  }

  private advance(record: LabSessionRecord, turn: ActiveTurn): void {
    while (this.turns.get(record.id) === turn) {
      const step = turn.queue.shift();
      if (step === undefined) {
        this.finish(record, turn, 'succeeded');
        return;
      }
      switch (step.kind) {
        case 'wait':
          turn.cancel = this.clock.after(step.ms, () => {
            turn.cancel = undefined;
            this.advance(record, turn);
          });
          return;
        case 'status':
          this.setStatus(record, step.status);
          break;
        case 'block':
          this.putBlock(record, step.block);
          break;
        case 'delta':
          this.appendText(record, step.blockId, step.text);
          break;
        case 'usage':
          record.usage.push(step.receipt);
          this.publishSession(record);
          break;
        case 'approval':
          this.requestApproval(record, turn, step);
          return;
        case 'extensionUi':
          this.publishSurface(record, step.action);
          break;
        case 'continue':
          turn.queue.unshift(...step.next());
          break;
        case 'end':
          this.finish(record, turn, step.outcome);
          return;
        default: {
          const exhaustive: never = step;
          return exhaustive;
        }
      }
    }
  }

  private finish(record: LabSessionRecord, turn: ActiveTurn, outcome: TurnOutcome): void {
    this.turns.delete(record.id);
    this.touch(record);
    // A turn that did not succeed pauses the outbox before the final idle, as the host does.
    if (outcome !== 'succeeded') this.pauseQueue(record);
    this.setStatus(record, 'idle');
    turn.onEnd?.(outcome);
    const next = record.live?.pendingPrompts.shift();
    if (next !== undefined) {
      this.startTurn(record, chatTurn(this.nextContext(record), next));
      return;
    }
    this.notifyIdle(record);
  }

  private notifyIdle(record: LabSessionRecord): void {
    for (const listener of this.idleListeners) listener(record);
  }

  private setStatus(record: LabSessionRecord, status: SessionStatus): void {
    if (record.live === undefined || record.live.status === status) return;
    record.live.status = status;
    this.touch(record);
    this.publishSession(record);
  }

  private putBlock(record: LabSessionRecord, block: DesktopTimelineBlock): void {
    const index = record.blocks.findIndex((candidate) => candidate.id === block.id);
    const createdAt = index >= 0 ? record.blocks[index]?.createdAt : block.createdAt ?? this.clock.iso();
    const stored: DesktopTimelineBlock = { ...block, ...(createdAt === undefined ? {} : { createdAt }) };
    if (index >= 0) record.blocks[index] = stored;
    else record.blocks.push(stored);
    this.publish(record, { type: 'block', block: stored });
  }

  private appendText(record: LabSessionRecord, blockId: string, text: string): void {
    const block = record.blocks.find((candidate) => candidate.id === blockId);
    if (block === undefined) return;
    block.text = `${block.text ?? ''}${text}`;
    this.publish(record, { type: 'textDelta', blockId, text });
  }

  private requestApproval(record: LabSessionRecord, turn: ActiveTurn, step: ApprovalStep): void {
    if (record.live === undefined) return;
    this.approvalSerial += 1;
    const id = `lab-approval-${record.id.slice(0, 8)}-${this.approvalSerial}`;
    const approval = { ...step.approval, id, sessionId: record.id };
    record.live.approvals.push(approval);
    turn.approval = { id, step };
    this.publish(record, { type: 'approval', approval });
  }

  private resolveAllApprovals(record: LabSessionRecord): void {
    const pending = record.live?.approvals ?? [];
    if (record.live) record.live.approvals = [];
    for (const approval of pending) this.publish(record, { type: 'approvalResolved', requestId: approval.id });
  }
}
