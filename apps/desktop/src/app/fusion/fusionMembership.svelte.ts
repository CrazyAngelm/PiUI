import { SvelteMap } from 'svelte/reactivity';
import { fusionHost, type FusionRoleNameV1 } from '../../host-api/fusionClient';

/** Whether a chat is a Fusion lead, the sidekick of a lead, or neither. */
export interface FusionMember {
  role: FusionRoleNameV1 | null;
  leadSessionId?: string;
}

const NOT_MEMBER: FusionMember = { role: null };

/**
 * Per-chat cache of `fusion_command_v1` `find`. The answer of a chat that is
 * neither lead nor sidekick never changes (a Fusion chat is created as one),
 * so every chat asks once. A failed lookup is not cached: the chat is shown
 * as an ordinary one and the next open asks again.
 */
class FusionMembership {
  private entries = new SvelteMap<string, FusionMember>();
  private pending = new Map<string, Promise<void>>();

  /** The known membership; `undefined` until the host answered. */
  peek(sessionId: string): FusionMember | undefined {
    return this.entries.get(sessionId);
  }

  /** A lead created by this window is known without asking. */
  remember(leadSessionId: string): void {
    this.entries.set(leadSessionId, { role: 'lead', leadSessionId });
  }

  load(sessionId: string): Promise<void> {
    if (this.entries.has(sessionId)) return Promise.resolve();
    const running = this.pending.get(sessionId);
    if (running) return running;
    const request = fusionHost
      .request({ type: 'find', sessionId })
      .then((result) => {
        if (result.type !== 'membership') return;
        this.entries.set(sessionId, result.role === null ? NOT_MEMBER : { role: result.role, ...(result.leadSessionId ? { leadSessionId: result.leadSessionId } : {}) });
      })
      .catch(() => {
        // An older host without Fusion, or a failed lookup: an ordinary chat.
      })
      .finally(() => {
        this.pending.delete(sessionId);
      });
    this.pending.set(sessionId, request);
    return request;
  }
}

export const fusionMembership = new FusionMembership();
