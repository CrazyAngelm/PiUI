/** PiUI workspace protocol v15. Frozen v1-v10 routes retain their original semantics.
 * Native ids, session paths, process handles and credentials never cross this boundary.
 */
import type { DesktopTimelineBlock } from './runtime-protocol';
export const WORKSPACE_PROTOCOL = 15 as const;
/** `claude-code` is additive within v15 (ADR-028); no command or event shape changed. */
export type HarnessKind = 'pi' | 'prime-agent' | 'codex' | 'hermes' | 'claude-code';
export type SessionStatus = 'starting' | 'idle' | 'running' | 'stopping' | 'closed' | 'failed';
export type PermissionMode = 'native' | 'read-only' | 'workspace-write' | 'full-access';
export type Enforcement = 'native' | 'coordinator' | 'advisory' | 'unsupported';
export interface Capability { supported: boolean; enforcement: Enforcement; reason?: string }
export interface HarnessCapabilities {
  prompt: Capability; resume: Capability; models: Capability; approvals: Capability;
  instructions: Capability; toolPolicy: Capability; nativeSubagents: Capability;
}
export interface HarnessSummary {
  kind: HarnessKind; name: string; installed: boolean; version?: string;
  status: 'available' | 'unavailable' | 'unverified'; reason?: string;
}
export interface WorkspaceSummary {
  id: string; name: string; trust: 'trusted' | 'restricted'; missing: boolean; personal: boolean;
}
export interface WorkspaceModel { id: string; provider?: string; name: string; thinkingLevels?: string[] }
export interface WorkspaceSession {
  id: string; workspaceId: string; harness: HarnessKind; title: string;
  status: SessionStatus; updatedAt: string; model?: WorkspaceModel;
  profileId?: string; runId?: string; memberId?: string;
}
export type ApprovalDecision = 'approve-once' | 'approve-session' | 'deny' | 'cancel';
/** One select-style choice; answer with `respond.text` set to its opaque `id`. */
export interface WorkspaceApprovalOption { id: string; label: string }
interface ApprovalFieldBase {
  /** Opaque adapter id; the adapter maps it back to the native property. */
  id: string;
  /** Native label (not translated). */
  label: string;
  description?: string;
  required: boolean;
}
/** One primitive field of a native form request (Codex MCP elicitation). */
export type WorkspaceApprovalField =
  | (ApprovalFieldBase & {
    type: 'text'; default?: string; minLength?: number; maxLength?: number;
    format?: 'email' | 'uri' | 'date' | 'date-time';
  })
  | (ApprovalFieldBase & { type: 'number'; integer: boolean; default?: number; minimum?: number; maximum?: number })
  | (ApprovalFieldBase & { type: 'boolean'; default?: boolean })
  /** A single choice: answer with an option id; `default` is an option id. */
  | (ApprovalFieldBase & { type: 'choice'; default?: string; options: WorkspaceApprovalOption[] });
/**
 * A native form request (a Codex MCP elicitation). Answer `approve-once` with
 * `respond.text` set to a JSON object of field id -> value (string, number,
 * boolean or option id); `deny` declines and `cancel` dismisses it.
 * `limitation` says what PiUI could not show: optional values that stay empty,
 * or a required value, in which case only `deny`/`cancel` are offered.
 */
export interface WorkspaceApprovalForm {
  /** One-line display name of the MCP server that asked (native text). */
  server: string;
  fields: WorkspaceApprovalField[];
  limitation?: 'optional-fields-omitted' | 'input-unsupported';
}
export interface WorkspaceApproval {
  id: string; sessionId: string; kind: 'command' | 'file-change' | 'permission' | 'input';
  title: string; description: string; decisions: ApprovalDecision[]; inputLabel?: string;
  /** Additive v15 field; absent for approvals without native choices. */
  options?: WorkspaceApprovalOption[];
  /** Additive v15 field; absent for approvals that are not native form requests. */
  form?: WorkspaceApprovalForm;
}
export interface SessionSnapshot {
  session: WorkspaceSession; revision: number; blocks: DesktopTimelineBlock[];
  approvals: WorkspaceApproval[]; capabilities: HarnessCapabilities; models: WorkspaceModel[];
}
export interface WorkspaceCatalog {
  protocol: 15; safeMode: boolean; workspaces: WorkspaceSummary[];
  sessions: WorkspaceSession[]; harnesses: HarnessSummary[];
}
export type WorkspaceCommand =
  | { type: 'catalog' }
  | { type: 'createSession'; workspaceId: string; harness: HarnessKind; title?: string; model?: WorkspaceModel; permissionMode: PermissionMode }
  | { type: 'openSession'; sessionId: string }
  | { type: 'snapshot'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string; mode: 'prompt' | 'steer' | 'follow-up' }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'setModel'; sessionId: string; model: WorkspaceModel; thinkingLevel?: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'respond'; sessionId: string; requestId: string; decision: ApprovalDecision; text?: string };
export type WorkspaceResult =
  | { type: 'catalog'; catalog: WorkspaceCatalog }
  | { type: 'session'; snapshot: SessionSnapshot }
  | { type: 'accepted'; sessionId: string };
export type WorkspaceEventPayload =
  | { type: 'session'; session: WorkspaceSession }
  | { type: 'block'; block: DesktopTimelineBlock }
  | { type: 'textDelta'; blockId: string; text: string }
  | { type: 'approval'; approval: WorkspaceApproval }
  | { type: 'approvalResolved'; requestId: string }
  | { type: 'error'; message: string };
export interface WorkspaceEvent {
  protocol: 15; sessionId: string; revision: number; event: WorkspaceEventPayload;
}
