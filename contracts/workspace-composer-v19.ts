/** Additive composer IPC. v15 navigation and native history are unchanged. */
export type Delivery = 'queued' | 'sending' | 'uncertain' | 'sent' | 'cancelled';
export interface QueuedMessage { id: string; text: string; status: Delivery; error?: string }
export interface ComposerSnapshot {
  protocol: 19; sessionId: string;
  capabilities: { steer: boolean; compact: boolean };
  queue: { revision: number; paused: boolean; items: QueuedMessage[] };
}
export type ComposerCommand =
  | { type: 'snapshot' | 'resume' | 'compact'; sessionId: string }
  | { type: 'send'; sessionId: string; requestId: string; text: string; mode: 'prompt' | 'follow-up' | 'steer' }
  | { type: 'edit'; sessionId: string; requestId: string; text: string }
  | { type: 'promote' | 'remove'; sessionId: string; requestId: string };
