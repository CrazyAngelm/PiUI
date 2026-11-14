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
  /** Informational only. Resource URLs are absent from this descriptor. */
  mediaType?: string;
  presentation?: 'image' | 'audio' | 'video' | 'file';
  detail?: string;
  unavailable?: boolean;
  /** A pending local preview can be displayed before an openable resource exists. */
  openable?: boolean;
  downloadable?: boolean;
  /** Upload percent already supplied by the owning upload operation. */
  progress?: number;
}

/** An approved, ephemeral display resource resolved by the current owner. */
export interface ConversationMedia { src: string; mediaType?: string }
export interface ConversationMessagePresentation {
  blockId: string;
  literal?: boolean;
  author?: string;
  note?: string;
}
/** Trusted application code only, never a renderer supplied by a message/plugin. */
export interface ConversationDecoration {
  update(block: ConversationBlock): void;
  dispose(): void;
}

/** The owner supplies existing message operations, never executable callbacks or URLs. */
export type ConversationMessageAction = 'copy' | 'edit' | 'branch' | 'repeat' | 'refresh';

export interface ConversationMessageControls {
  /** Opaque, bound to the message contents/native reference; never reused for another target. */
  id: string;
  blockId: string;
  actions: { kind: ConversationMessageAction; disabled?: boolean; busy?: boolean }[];
  copied?: boolean;
  /** Already formatted by the account owner, not a second billing calculation. */
  usage?: { label: string; description?: string };
}

export interface ConversationSnapshot {
  blocks: TimelineBlock[];
  approvals: WorkspaceApproval[];
  attachments: ConversationAttachment[];
  connection: 'connected' | 'reconnecting' | 'disconnected';
  loading: boolean;
  /** Optional additive v1 capability. Omitted owners keep the existing native copy display. */
  messageControls?: ConversationMessageControls[];
  presentation?: ConversationMessagePresentation[];
  olderAvailable?: boolean;
  olderLoading?: boolean;
}

/** Every operation belongs to this exact identity. No implicit HTTP/Lab/native fallback. */
export interface ConversationOwner {
  identity: ConversationIdentity;
  readHistory?: (signal: AbortSignal) => Promise<TimelineBlock[]>;
  respond?: (requestId: string, decision: ApprovalDecision, answer: string | undefined, signal: AbortSignal) => Promise<void>;
  openAttachment?: (attachmentId: string, signal: AbortSignal) => Promise<void>;
  resolveAttachment?: (attachmentId: string, signal: AbortSignal) => Promise<ConversationMedia>;
  downloadAttachment?: (attachmentId: string, signal: AbortSignal) => Promise<void>;
  loadOlder?: (signal: AbortSignal) => Promise<void>;
  /** A trusted hosting application may enhance its message subtree with existing safe renderers. */
  decorateMessage?: (element: HTMLElement, block: ConversationBlock, signal: AbortSignal) => ConversationDecoration | void;
  reconnect?: (signal: AbortSignal) => Promise<ConversationSnapshot>;
  actOnMessage?: (controlId: string, action: ConversationMessageAction, signal: AbortSignal) => Promise<void>;
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
