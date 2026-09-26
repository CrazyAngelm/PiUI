import { composerCapabilities } from './catalogFake';
import { claimLabImages, labImageSupport, releaseLabImages } from './composerInputsFake';
import type { ComposerCommand, ComposerSnapshot, Delivery, QueuedAttachment } from './labContracts';
import { NativeRejection, workspaceFailure, type NativeRejectionCode } from './labErrors';
import { authorizeLive, requireLive, validText } from './labGuards';
import type { LabHandlers } from './labHandlers';
import { isUuid } from './labRandom';
import { decodeArgument } from './labSchema';
import { composerCommandSchema } from './labSchemas';
import { queuePending, type LabQueue, type LabSessionRecord } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * The durable user outbox (`workspace_composer_v19`). Follow-ups queue and
 * drain one at a time when the session is idle; steer joins the active turn.
 * Every queue change bumps the revision and notifies `piui://composer-v19`.
 * Images (composer inputs v1) move from the pending store to a message when
 * it is queued and are released once it is delivered or removed.
 */
type Capabilities = { steer: boolean; compact: boolean; images: boolean };

/** Outbox text of a message whose images the session can no longer accept (host `IMAGES_REFUSED`). */
const IMAGES_REFUSED =
  'The harness or its current model does not accept images. Your message is still queued; remove it or switch to a model that accepts images.';

function rejectedAsQueued(code: NativeRejectionCode): boolean {
  return code !== 'exited';
}

/** `delivery_error`: the outbox text shown on a message the harness did not accept. */
function deliveryError(code: NativeRejectionCode): string {
  switch (code) {
    case 'no-active-turn': return 'The turn finished before Steer was accepted. Your message is still queued.';
    case 'turn-active': return 'The harness is still busy. Your message is still queued.';
    case 'unsupported': return 'This harness does not support the requested operation. Your message is still queued.';
    case 'invalid': return 'The harness declined the message. Edit it or resume the queue to try again.';
    case 'exited': return 'Delivery could not be confirmed. Check native history before dismissing this message.';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** `native_error`: the composer reports specific codes for native refusals. */
function composerNative(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof NativeRejection)) throw error;
    if (error.code === 'turn-active') throw workspaceFailure('TURN_ACTIVE');
    if (error.code === 'no-active-turn') throw workspaceFailure('NO_ACTIVE_TURN');
    if (error.code === 'unsupported') throw workspaceFailure('NOT_SUPPORTED');
    throw workspaceFailure('RUNTIME_FAILED');
  }
}

function enqueue(queue: LabQueue, id: string, text: string, attachments: readonly QueuedAttachment[] = []): void {
  // Request ids stay reserved after delivery, including across reloads.
  if (!queue.items.some((item) => item.id === id)) {
    queue.items.push({ id, text, status: 'queued', ...(attachments.length ? { attachments: [...attachments] } : {}) });
  }
}

/** `enqueue_message`: pending images move to the message only with it; a retried id claims nothing. */
function enqueueMessage(
  runtime: LabSessions,
  record: LabSessionRecord,
  requestId: string,
  text: string,
  attachmentIds: readonly string[],
): void {
  if (record.composer.items.some((item) => item.id === requestId)) return;
  const images = claimLabImages(runtime.state, attachmentIds);
  runtime.changeQueue(record, (queue) => enqueue(queue, requestId, text, images));
}

/** `hold_message`: nothing was sent; the message waits for the user. */
function hold(runtime: LabSessions, record: LabSessionRecord, id: string, reason: string): void {
  runtime.changeQueue(record, (queue) => {
    const item = queue.items.find((candidate) => candidate.id === id);
    if (item === undefined) throw workspaceFailure('CONFLICT');
    item.status = 'queued';
    item.error = reason;
    queue.paused = true;
  });
}

function settle(runtime: LabSessions, record: LabSessionRecord, id: string, rejection: NativeRejection | undefined): void {
  const delivered = runtime.changeQueue(record, (queue): QueuedAttachment[] => {
    const item = queue.items.find((candidate) => candidate.id === id);
    if (item === undefined) throw workspaceFailure('CONFLICT');
    if (rejection === undefined) {
      item.status = 'sent';
      item.text = '';
      const images = item.attachments ?? [];
      delete item.attachments;
      return images;
    }
    item.status = rejectedAsQueued(rejection.code) ? 'queued' : 'uncertain';
    item.error = deliveryError(rejection.code);
    queue.paused = true;
    return [];
  });
  releaseLabImages(runtime.state, delivered);
}

function attempt(operation: () => void): NativeRejection | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    if (error instanceof NativeRejection) return error;
    throw error;
  }
}

/** `drain`: deliver the oldest queued message once the session is idle and unpaused. */
export function drain(runtime: LabSessions, record: LabSessionRecord): void {
  const live = record.live;
  if (live === undefined || runtime.state.sessions.get(record.id) !== record) return;
  const queue = record.composer;
  const blocked = queue.items.some((item) => item.status === 'sending' || item.status === 'uncertain');
  if (live.composerPaused || queue.paused || blocked || live.composerWaiting) return;
  const next = queue.items.find((item) => item.status === 'queued');
  if (next === undefined || live.status !== 'idle' || runtime.isBusy(record)) return;
  const { text, images } = runtime.changeQueue(record, (draft) => {
    const item = draft.items.find((candidate) => candidate.id === next.id && candidate.status === 'queued');
    if (item === undefined) throw workspaceFailure('CONFLICT');
    item.status = 'sending';
    delete item.error;
    return { text: item.text, images: item.attachments?.length ?? 0 };
  });
  // The model may have changed since the message was queued.
  if (images > 0 && !labImageSupport(record.harness, record.model)) {
    hold(runtime, record, next.id, IMAGES_REFUSED);
    return;
  }
  live.composerWaiting = true;
  const rejection = attempt(() => runtime.prompt(record, text, 'prompt', () => {
    live.composerWaiting = false;
  }, images));
  if (rejection !== undefined) live.composerWaiting = false;
  settle(runtime, record, next.id, rejection);
}

function scheduleDrain(runtime: LabSessions, record: LabSessionRecord): void {
  runtime.clock.after(0, () => drain(runtime, record));
}

function steer(
  runtime: LabSessions,
  record: LabSessionRecord,
  capabilities: Capabilities,
  requestId: string,
  message: { text: string; attachments: readonly string[] } | undefined,
): void {
  if (!capabilities.steer) throw workspaceFailure('NOT_SUPPORTED');
  const settled: readonly Delivery[] = ['sent', 'cancelled', 'uncertain'];
  if (record.composer.items.some((item) => item.id === requestId && settled.includes(item.status))) return;
  if (record.live?.status !== 'running') throw workspaceFailure('NO_ACTIVE_TURN');
  if (message !== undefined) enqueueMessage(runtime, record, requestId, message.text, message.attachments);
  const { body, images } = runtime.changeQueue(record, (queue) => {
    const item = queue.items.find((candidate) => candidate.id === requestId && candidate.status === 'queued');
    if (item === undefined) throw workspaceFailure('CONFLICT');
    item.status = 'sending';
    delete item.error;
    return { body: item.text, images: item.attachments?.length ?? 0 };
  });
  if (images > 0 && !capabilities.images) {
    hold(runtime, record, requestId, IMAGES_REFUSED);
    return;
  }
  settle(runtime, record, requestId, attempt(() => runtime.prompt(record, body, 'steer', undefined, images)));
}

function composer(runtime: LabSessions, command: ComposerCommand): ComposerSnapshot {
  const { state } = runtime;
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  if (!isUuid(command.sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
  const record = authorizeLive(state, command.sessionId);
  if (record.runId !== undefined) throw workspaceFailure('NOT_SUPPORTED');
  const live = requireLive(record);
  live.composerNotify = true;
  if (live.status === 'failed') throw workspaceFailure('RUNTIME_FAILED');
  const capabilities: Capabilities = { ...composerCapabilities(record.harness), images: labImageSupport(record.harness, record.model) };
  switch (command.type) {
    case 'snapshot':
      break;
    case 'send': {
      if (!isUuid(command.requestId) || !validText(command.text)) throw workspaceFailure('INVALID_ARGUMENT');
      const attachments = command.attachments ?? [];
      if (attachments.length > 6 || !attachments.every(isUuid)) throw workspaceFailure('INVALID_ARGUMENT');
      // Images the session cannot take are refused before anything is queued.
      if (attachments.length > 0 && !capabilities.images) throw workspaceFailure('IMAGES_UNSUPPORTED');
      if (command.mode === 'steer') {
        steer(runtime, record, capabilities, command.requestId, { text: command.text, attachments });
        break;
      }
      enqueueMessage(runtime, record, command.requestId, command.text, attachments);
      if (!record.composer.paused) live.composerPaused = false;
      scheduleDrain(runtime, record);
      break;
    }
    case 'edit':
      if (!validText(command.text)) throw workspaceFailure('INVALID_ARGUMENT');
      runtime.changeQueue(record, (queue) => {
        const item = queue.items.find((candidate) => candidate.id === command.requestId && candidate.status === 'queued');
        if (item === undefined) throw workspaceFailure('CONFLICT');
        item.text = command.text;
      });
      break;
    case 'promote':
      steer(runtime, record, capabilities, command.requestId, undefined);
      break;
    case 'remove': {
      const removed = runtime.changeQueue(record, (queue): QueuedAttachment[] => {
        const item = queue.items.find((candidate) => candidate.id === command.requestId
          && (candidate.status === 'queued' || candidate.status === 'uncertain'));
        if (item === undefined) throw workspaceFailure('CONFLICT');
        item.status = 'cancelled';
        item.text = '';
        const images = item.attachments ?? [];
        delete item.attachments;
        return images;
      });
      releaseLabImages(state, removed);
      break;
    }
    case 'resume':
      runtime.changeQueue(record, (queue) => {
        if (queue.items.some((item) => item.status === 'sending' || item.status === 'uncertain')) {
          throw workspaceFailure('DELIVERY_UNCERTAIN');
        }
        queue.paused = false;
      });
      live.composerPaused = false;
      scheduleDrain(runtime, record);
      break;
    case 'compact':
      if (!capabilities.compact) throw workspaceFailure('NOT_SUPPORTED');
      if (queuePending(record.composer)) throw workspaceFailure('QUEUE_PENDING');
      composerNative(() => runtime.compact(record));
      break;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
  const { revision, paused, items } = record.composer;
  return {
    protocol: 19,
    sessionId: command.sessionId,
    capabilities,
    queue: { revision, paused, items: items.filter((item) => item.status !== 'sent' && item.status !== 'cancelled') },
  };
}

export function composerHandlers(runtime: LabSessions): LabHandlers {
  runtime.onIdle((record) => drain(runtime, record));
  return {
    workspace_composer_v19: (args) => composer(runtime, decodeArgument<ComposerCommand>(args, 'command', composerCommandSchema)),
  };
}
