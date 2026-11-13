import type { TimelineBlock } from '../apps/desktop/src/host-api/types';
import type { ApprovalDecision, WorkspaceApproval } from './workspace-v15';

/** An ephemeral projection, never a new history or persistence format. */
export type ConversationBlock = TimelineBlock;
export type ConversationApproval = WorkspaceApproval;

export interface ConversationIdentity {
  location: 'native' | 'cloud';
  /** Account/workspace scope chosen by the owner, not a filesystem path. */
  scopeId: string;
  sessionId: string;
}

export interface ConversationAttachment {
  id: string;
  blockId: string;
  label: string;
  /** Informational only. The owner resolves an opaque ID; no URL is rendered. */
  mediaType?: string;
}

export interface ConversationSnapshot {
  blocks: TimelineBlock[];
  approvals: WorkspaceApproval[];
  attachments: ConversationAttachment[];
  connection: 'connected' | 'reconnecting' | 'disconnected';
  loading: boolean;
}

/** Every operation belongs to this exact identity. No implicit HTTP/Lab/native fallback. */
export interface ConversationOwner {
  identity: ConversationIdentity;
  readHistory?: (signal: AbortSignal) => Promise<TimelineBlock[]>;
  respond?: (requestId: string, decision: ApprovalDecision, answer: string | undefined, signal: AbortSignal) => Promise<void>;
  openAttachment?: (attachmentId: string, signal: AbortSignal) => Promise<void>;
  reconnect?: (signal: AbortSignal) => Promise<ConversationSnapshot>;
}

export interface ConversationOptions {
  contractVersion: 1;
  language: 'en' | 'ru';
  appearance?: 'light' | 'dark' | 'system';
  agentLabel: string;
  owner: ConversationOwner;
  snapshot: ConversationSnapshot;
}

export interface ConversationHandle {
  /** Owner-projected streaming snapshots replace the display; they are not saved here. */
  update(identity: ConversationIdentity, snapshot: ConversationSnapshot): void;
  /** Retires the prior owner's pending operations before displaying the new owner. */
  setOwner(owner: ConversationOwner, snapshot: ConversationSnapshot): void;
  setAppearance(value: 'light' | 'dark' | 'system'): void;
  dispose(): Promise<void>;
}
