/** Additive composer IPC. v15 navigation and native history are unchanged. */
import type { ComposerImageType } from './workspace-composer-inputs-v1';
export type Delivery = 'queued' | 'sending' | 'uncertain' | 'sent' | 'cancelled';
/**
 * Additive within v19: an image sent with a queued message. Its bytes stay in
 * PiUI's app data until the message is delivered or removed.
 */
export interface QueuedAttachment { id: string; name: string; mimeType: ComposerImageType; size: number }
export interface QueuedMessage {
  id: string; text: string; status: Delivery; error?: string;
  /** Additive within v19; absent when the message has no images. */
  attachments?: QueuedAttachment[];
}
export interface ComposerSnapshot {
  protocol: 19; sessionId: string;
  /**
   * `images` is additive within v19: the live session accepts images natively
   * (harness protocol and current model). Absent means no.
   */
  capabilities: { steer: boolean; compact: boolean; images?: boolean };
  queue: { revision: number; paused: boolean; items: QueuedMessage[] };
}
export type ComposerCommand =
  | { type: 'snapshot' | 'resume' | 'compact'; sessionId: string }
  | {
    type: 'send'; sessionId: string; requestId: string; text: string; mode: 'prompt' | 'follow-up' | 'steer';
    /**
     * Additive within v19: pending image ids from composer inputs v1 (at most
     * 6). A host that cannot deliver them rejects the send instead of
     * dropping them; older hosts reject the unknown field.
     */
    attachments?: string[];
  }
  | { type: 'edit'; sessionId: string; requestId: string; text: string }
  | { type: 'promote' | 'remove'; sessionId: string; requestId: string };
