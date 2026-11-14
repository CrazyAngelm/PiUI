import type {
  ConversationIdentity, ConversationOwner, ConversationSnapshot, ConversationMessageAction, ConversationBlock, ConversationDecoration,
} from '../../../../../contracts/conversation-presentation-v1';
import type { ApprovalDecision } from '../../../../../contracts/workspace-v15';

export const conversationKey = (identity: ConversationIdentity): string => JSON.stringify([identity.location, identity.scopeId, identity.sessionId]);
const stale = (): DOMException => new DOMException('Conversation owner changed.', 'AbortError');
const messageActions = new Set<ConversationMessageAction>(['copy', 'edit', 'branch', 'repeat', 'refresh']);
export const messageActionKey = (id: string, action: ConversationMessageAction): string => JSON.stringify([id, action]);

function validate(owner: ConversationOwner, snapshot: ConversationSnapshot): void {
  const { identity } = owner;
  if (!identity || !['native', 'cloud'].includes(identity.location) || typeof identity.scopeId !== 'string' || !identity.scopeId || typeof identity.sessionId !== 'string' || !identity.sessionId) throw new Error('A conversation needs an explicit owner.');
  const blocks = new Set(snapshot.blocks.map(block => block.id));
  if (blocks.size !== snapshot.blocks.length) throw new Error('Conversation block IDs must be unique.');
  if (snapshot.approvals.some(approval => approval.sessionId !== identity.sessionId)) throw new Error('An approval belongs to another conversation.');
  if (new Set(snapshot.approvals.map(approval => approval.id)).size !== snapshot.approvals.length) throw new Error('Conversation approval IDs must be unique.');
  if (new Set(snapshot.attachments.map(attachment => attachment.id)).size !== snapshot.attachments.length || snapshot.attachments.some(attachment => !blocks.has(attachment.blockId))) throw new Error('Attachments must identify a displayed message.');
  if (!['connected', 'reconnecting', 'disconnected'].includes(snapshot.connection)) throw new Error('Unsupported conversation connection state.');
  if (snapshot.attachments.some(file => file.presentation !== undefined && !['image', 'audio', 'video', 'file'].includes(file.presentation)
    || file.progress !== undefined && (!Number.isFinite(file.progress) || file.progress < 0 || file.progress > 100)))
    throw new Error('Unsupported attachment presentation.');
  if (snapshot.presentation && (new Set(snapshot.presentation.map(item => item.blockId)).size !== snapshot.presentation.length
    || snapshot.presentation.some(item => !blocks.has(item.blockId)))) throw new Error('Message presentation must identify displayed blocks.');
  if (snapshot.messageControls !== undefined) {
    const controls = snapshot.messageControls;
    if (!Array.isArray(controls) || new Set(controls.map(item => item.id)).size !== controls.length
      || new Set(controls.map(item => item.blockId)).size !== controls.length
      || controls.some(item => typeof item.id !== 'string' || !item.id || !blocks.has(item.blockId)
        || !Array.isArray(item.actions) || new Set(item.actions.map(action => action.kind)).size !== item.actions.length
        || item.actions.some(action => !messageActions.has(action.kind)
          || action.disabled !== undefined && typeof action.disabled !== 'boolean'
          || action.busy !== undefined && typeof action.busy !== 'boolean')
        || item.copied !== undefined && typeof item.copied !== 'boolean'
        || item.usage !== undefined && (typeof item.usage.label !== 'string'
          || item.usage.description !== undefined && typeof item.usage.description !== 'string')))
      throw new Error('Message controls must identify displayed messages and supported actions.');
  }
}

/** Display lifetime only. The owner retains history, networking, auth and execution. */
export class ConversationController {
  owner = $state.raw<ConversationOwner>();
  snapshot = $state.raw<ConversationSnapshot>();
  generation = $state(0);
  busyApproval = $state('');
  approvalErrors = $state<Record<string, string>>({});
  reconnecting = $state(false);
  error = $state('');
  busyMessageActions = $state<Record<string, boolean>>({});
  messageActionErrors = $state<Record<string, string>>({});
  retired = $state(false);
  olderLoading = $state(false);
  private pending = new Set<AbortController>();
  private revision = 0;

  constructor(owner: ConversationOwner, snapshot: ConversationSnapshot) { this.setOwner(owner, snapshot); }

  private active(): ConversationOwner {
    if (this.retired || !this.owner) throw stale();
    return this.owner;
  }

  setOwner(owner: ConversationOwner, snapshot: ConversationSnapshot): void {
    if (this.retired) throw stale();
    // A rejected owner transition must not leave the previous account's
    // operations active while its host believes navigation already happened.
    try { validate(owner, snapshot); }
    catch (error) { this.dispose(); throw error; }
    for (const request of this.pending) request.abort();
    this.pending.clear();
    this.owner = { ...owner, identity: { ...owner.identity } };
    this.snapshot = snapshot;
    this.generation += 1;
    this.revision += 1;
    this.busyApproval = '';
    this.approvalErrors = {};
    this.reconnecting = false;
    this.error = '';
    this.busyMessageActions = {};
    this.messageActionErrors = {};
    this.olderLoading = false;
  }

  update(identity: ConversationIdentity, snapshot: ConversationSnapshot): void {
    const owner = this.active();
    if (conversationKey(identity) !== conversationKey(owner.identity)) throw new Error('A snapshot belongs to another conversation.');
    validate(owner, snapshot);
    this.snapshot = snapshot;
    this.revision += 1;
  }

  private async request<T>(operation: (owner: ConversationOwner, signal: AbortSignal) => Promise<T>): Promise<T> {
    const owner = this.active();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending.add(controller);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(stale()); });
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      // Owners such as a Blazor callback may not be able to cancel their
      // underlying request. Retire the presentation wait immediately anyway.
      const value = await Promise.race([operation(owner, controller.signal), cancelled]);
      if (this.retired || this.generation !== generation || controller.signal.aborted) throw stale();
      return value;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      this.pending.delete(controller);
    }
  }

  readHistory = async () => this.request((owner, signal) => {
    if (!owner.readHistory) throw new Error('History reading is not available.');
    return owner.readHistory(signal);
  });

  openAttachment = async (id: string): Promise<void> => {
    if (!this.snapshot?.attachments.some(attachment => attachment.id === id)) throw new Error('Unknown attachment.');
    await this.request((owner, signal) => {
      if (!owner.openAttachment) throw new Error('Opening attachments is not available.');
      return owner.openAttachment(id, signal);
    });
  };

  bindAttachments() {
    const generation = this.generation;
    const current = (id: string) => {
      if (generation !== this.generation || this.retired) throw stale();
      const attachment = this.snapshot?.attachments.find(item => item.id === id);
      if (!attachment || attachment.unavailable) throw new Error('Attachment is no longer available.');
      return attachment;
    };
    return {
      open: async (id: string) => {
        if (current(id).openable === false) throw new Error('Attachment cannot be opened yet.');
        await this.openAttachment(id);
      },
      download: async (id: string) => {
        if (!current(id).downloadable) throw new Error('Download is not available.');
        await this.request((owner, signal) => {
          if (!owner.downloadAttachment) throw new Error('Download is not available.');
          return owner.downloadAttachment(id, signal);
        });
      },
      resolve: async (id: string) => {
        current(id);
        const media = await this.request((owner, signal) => {
          if (!owner.resolveAttachment) throw new Error('Media is not available.');
          return owner.resolveAttachment(id, signal);
        });
        current(id);
        return media;
      },
    };
  }

  bindLoadOlder(): () => Promise<void> {
    const generation = this.generation;
    return async () => {
      if (generation !== this.generation || this.retired || this.olderLoading || this.snapshot?.olderLoading || !this.snapshot?.olderAvailable) return;
      this.olderLoading = true;
      this.error = '';
      try {
        await this.request((owner, signal) => {
          if (!owner.loadOlder) throw new Error('History paging is not available.');
          return owner.loadOlder(signal);
        });
      } catch {
        if (generation === this.generation && !this.retired) this.error = 'Could not load history. Try again.';
      } finally { if (generation === this.generation && !this.retired) this.olderLoading = false; }
    };
  }

  bindMessageDecoration(kind: 'message' | 'header' = 'message'): NonNullable<ConversationOwner['decorateMessage']> {
    const generation = this.generation;
    const owner = this.active();
    return (element, block, parentSignal) => {
      if (parentSignal.aborted || this.retired || generation !== this.generation || !this.snapshot?.blocks.some(item => item.id === block.id)) return;
      const controller = new AbortController();
      this.pending.add(controller);
      let decoration: ConversationDecoration | void;
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        this.pending.delete(controller);
        parentSignal.removeEventListener('abort', dispose);
        controller.abort();
        try { decoration?.dispose(); } catch { /* Keep the generic message readable. */ }
      };
      controller.signal.addEventListener('abort', dispose, { once: true });
      parentSignal.addEventListener('abort', dispose, { once: true });
      try { decoration = (kind === 'header' ? owner.decorateMessageHeader : owner.decorateMessage)?.(element, block, controller.signal); }
      catch { dispose(); return; }
      if (disposed || parentSignal.aborted) { decoration?.dispose(); dispose(); return; }
      return {
        update: (next: ConversationBlock) => {
          if (disposed || generation !== this.generation || next.id !== block.id) return;
          try { decoration?.update(next); } catch { dispose(); }
        },
        dispose,
      };
    };
  }

  /** A rendered control keeps its originating owner even before the DOM flushes. */
  bindMessageActions(): (id: string, action: ConversationMessageAction) => Promise<void> {
    const generation = this.generation;
    return (id, action) => this.actOnMessage(id, action, generation);
  }

  actOnMessage = async (id: string, action: ConversationMessageAction, originGeneration: number = this.generation): Promise<void> => {
    if (originGeneration !== this.generation) throw stale();
    const controls = this.snapshot?.messageControls?.find(item => item.id === id);
    const offered = controls?.actions.find(item => item.kind === action);
    const key = messageActionKey(id, action);
    if (!offered || offered.disabled || offered.busy || this.busyMessageActions[key]
      || !this.active().actOnMessage) throw new Error('Message action is not available.');
    const generation = this.generation;
    this.busyMessageActions = { ...this.busyMessageActions, [key]: true };
    this.messageActionErrors = { ...this.messageActionErrors, [JSON.stringify(id)]: '' };
    try {
      await this.request((owner, signal) => owner.actOnMessage!(id, action, signal));
    } catch {
      if (!this.retired && generation === this.generation
        && this.snapshot?.messageControls?.some(item => item.id === id))
        this.messageActionErrors = { ...this.messageActionErrors, [JSON.stringify(id)]: 'Could not complete the message action.' };
    } finally {
      if (!this.retired && generation === this.generation) {
        const { [key]: _finished, ...pending } = this.busyMessageActions;
        this.busyMessageActions = pending;
      }
    }
  };

  async respond(id: string, decision: ApprovalDecision, answer: string | undefined): Promise<void> {
    const request = this.snapshot?.approvals.find(approval => approval.id === id);
    if (this.busyApproval || this.snapshot?.connection !== 'connected' || !request?.decisions.includes(decision)) return;
    const generation = this.generation;
    this.busyApproval = id;
    this.approvalErrors = { ...this.approvalErrors, [id]: '' };
    try {
      await this.request((owner, signal) => {
        if (!owner.respond) throw new Error('Approval responses are not available.');
        return owner.respond(id, decision, answer, signal);
      });
      // Only a new owner snapshot can remove an approval. An acknowledgement is
      // not evidence that a reconnecting native/cloud history has advanced.
    } catch {
      if (!this.retired && generation === this.generation) this.approvalErrors = { ...this.approvalErrors, [id]: 'Could not send the decision' };
    } finally {
      if (!this.retired && generation === this.generation) this.busyApproval = '';
    }
  }

  async reconnect(): Promise<void> {
    if (this.reconnecting || !this.active().reconnect) return;
    const generation = this.generation;
    const revision = this.revision;
    this.reconnecting = true;
    this.error = '';
    try {
      const snapshot = await this.request((owner, signal) => owner.reconnect!(signal));
      // A concurrent live snapshot is newer than the reconnect's starting point.
      if (this.revision === revision) this.update(this.active().identity, snapshot);
    } catch {
      if (!this.retired && generation === this.generation) this.error = 'Could not reconnect.';
    } finally {
      if (!this.retired && generation === this.generation) this.reconnecting = false;
    }
  }

  dispose(): void {
    if (this.retired) return;
    this.retired = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
