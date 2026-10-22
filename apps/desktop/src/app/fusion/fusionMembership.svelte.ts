import { SvelteMap } from 'svelte/reactivity';
import { FusionError, fusionHost, type FusionRoleNameV1, type FusionStateV1 } from '../../host-api/fusionClient';

/** Whether a chat is a Fusion lead, the sidekick of a lead, or neither. */
export interface FusionMember {
  role: FusionRoleNameV1 | null;
  leadSessionId?: string;
}

const NOT_MEMBER: FusionMember = { role: null };

/**
 * Per-chat cache of `fusion_command_v1` `find`. A chat that is neither lead nor
 * sidekick stays so while its lead exists (a Fusion chat is created as one), so
 * every chat asks once. The cache is dropped for a deleted lead (`forgetLead`)
 * and for chats whose lead left the catalog (`prune`): the host removes the
 * membership with the pair, and the next open asks again. A failed lookup is
 * not cached: the chat is shown as an ordinary one and the next open asks again.
 *
 * A sidekick is `current` while the lead's state lists it as not retired and
 * `retired` after a reset. Only a retired sidekick's chat may be deleted
 * (docs/FUSION.md); until the lead's state answers, a sidekick counts as current.
 */
class FusionMembership {
  private entries = new SvelteMap<string, FusionMember>();
  /** Retired flag of every sidekick session the lead's last answered `state` listed. */
  private retired = new SvelteMap<string, boolean>();
  private pending = new Map<string, { generation: number; request: Promise<void> }>();
  private leadLoads = new Map<string, Promise<void>>();
  private generation = 0;
  private listening = false;

  /** The known membership; `undefined` until the host answered. */
  peek(sessionId: string): FusionMember | undefined {
    return this.entries.get(sessionId);
  }

  /** A lead created by this window is known without asking. */
  remember(leadSessionId: string): void {
    this.entries.set(leadSessionId, { role: 'lead', leadSessionId });
  }

  /** A sidekick whose lead is known (a pair created or observed by this window). */
  rememberSidekick(sessionId: string, leadSessionId: string): void {
    this.entries.set(sessionId, { role: 'sidekick', leadSessionId });
  }

  /** Whether the chat is known to be a Fusion sidekick (its turns belong to the broker). */
  isSidekick(sessionId: string): boolean {
    return this.entries.get(sessionId)?.role === 'sidekick';
  }

  /** Whether the chat is a lead of a Fusion pair. */
  isLead(sessionId: string): boolean {
    return this.entries.get(sessionId)?.role === 'lead';
  }

  /**
   * Whether the chat is the sidekick in use: the broker owns its lifecycle, so
   * it cannot be deleted and closing it goes through the broker. A sidekick
   * whose retirement is not known yet counts as current.
   */
  isCurrentSidekick(sessionId: string): boolean {
    return this.isSidekick(sessionId) && this.retired.get(sessionId) !== true;
  }

  /** Forgets the chat and every chat that belongs to it as its lead; the next open asks the host again. */
  forgetLead(leadSessionId: string): void {
    this.generation += 1;
    this.pending.clear();
    this.leadLoads.delete(leadSessionId);
    for (const [sessionId, member] of [...this.entries]) {
      if (sessionId === leadSessionId || member.leadSessionId === leadSessionId) {
        this.entries.delete(sessionId);
        this.retired.delete(sessionId);
      }
    }
  }

  /**
   * Drops what is known about chats whose lead is no longer among `sessionIds`
   * (deleted elsewhere, or by a lifecycle event this window did not issue).
   */
  prune(sessionIds: ReadonlySet<string>): void {
    const gone = new Set<string>();
    for (const member of this.entries.values()) {
      if (member.leadSessionId !== undefined && !sessionIds.has(member.leadSessionId)) gone.add(member.leadSessionId);
    }
    for (const leadSessionId of gone) this.forgetLead(leadSessionId);
  }

  load(sessionId: string): Promise<void> {
    const known = this.entries.get(sessionId);
    if (known !== undefined) return known.role === 'sidekick' && known.leadSessionId && !this.retired.has(sessionId) ? this.loadLead(known.leadSessionId) : Promise.resolve();
    const running = this.pending.get(sessionId);
    if (running) return running.request;
    const generation = this.generation;
    const request = fusionHost
      .request({ type: 'find', sessionId })
      .then(async (result) => {
        // The membership was invalidated while the host answered: ask again next time.
        if (generation !== this.generation) return;
        if (result.type !== 'membership') return;
        const member: FusionMember = result.role === null ? NOT_MEMBER : { role: result.role, ...(result.leadSessionId ? { leadSessionId: result.leadSessionId } : {}) };
        this.entries.set(sessionId, member);
        if (member.role === 'sidekick' && member.leadSessionId) await this.loadLead(member.leadSessionId);
      })
      .catch(() => {
        // An older host without Fusion, or a failed lookup: an ordinary chat.
      })
      .finally(() => {
        if (this.pending.get(sessionId)?.request === request) this.pending.delete(sessionId);
      });
    this.pending.set(sessionId, { generation, request });
    return request;
  }

  /** Reads which of the lead's sidekick chats are retired (`state`), and follows later changes. */
  private loadLead(leadSessionId: string, again = false): Promise<void> {
    this.listen();
    const running = this.leadLoads.get(leadSessionId);
    // An event that arrives while a read is in flight needs a read that starts after it.
    if (running && !again) return running;
    const request = (running ? running.then(() => this.refreshLead(leadSessionId)) : this.refreshLead(leadSessionId)).finally(() => {
      if (this.leadLoads.get(leadSessionId) === request) this.leadLoads.delete(leadSessionId);
    });
    this.leadLoads.set(leadSessionId, request);
    return request;
  }

  private async refreshLead(leadSessionId: string): Promise<void> {
    const generation = this.generation;
    try {
      const result = await fusionHost.request({ type: 'state', leadSessionId });
      if (generation !== this.generation || result.type !== 'state') return;
      this.applyState(result.state);
    } catch (cause) {
      // The lead no longer has a pair: its sidekick chats are ordinary again.
      if (cause instanceof FusionError && cause.code === 'NOT_FOUND') this.forgetLead(leadSessionId);
      // Any other failure keeps the sidekick counted as current, which is the safe side.
    }
  }

  private applyState(state: FusionStateV1): void {
    for (const session of state.sessions) this.retired.set(session.sessionId, session.retired);
  }

  /** One listener for the app's life: a reset retires the sidekick and a new one takes over. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    fusionHost
      .onChanged((event) => {
        for (const member of this.entries.values()) {
          if (member.role === 'sidekick' && member.leadSessionId === event.leadSessionId) {
            void this.loadLead(event.leadSessionId, true);
            return;
          }
        }
      })
      .catch(() => {
        // Without events the status is read again on the next open.
        this.listening = false;
      });
  }
}

export const fusionMembership = new FusionMembership();
