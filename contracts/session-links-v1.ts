import type { HarnessKind, PermissionMode } from './workspace-v15';

/** Linked-chat metadata only. Native transcripts and inference remain harness-owned. */
export type SessionsToolOperationV1 =
  | { op: 'start'; title: string; prompt: string; harness?: HarnessKind; model?: { provider: string; id: string }; permissionMode?: PermissionMode; wait?: boolean; waitSeconds?: number }
  | { op: 'list' }
  | { op: 'message'; sessionId: string; text: string; wait?: boolean; waitSeconds?: number }
  | { op: 'read'; sessionId: string; page?: number }
  | { op: 'wait'; sessionId: string; waitSeconds?: number }
  | { op: 'stop'; sessionId: string };

export type LinkKindV1 = 'agent' | 'branch' | 'peer';
export type LinkedChatStateV1 = 'starting' | 'running' | 'idle' | 'failed' | 'closed';
export interface LinkedChatV1 {
  sessionId: string;
  title: string;
  harness: HarnessKind;
  kind: LinkKindV1;
  relation: 'child' | 'parent' | 'peer';
  state: LinkedChatStateV1;
  pending: number;
  lastReport?: { at: string; excerpt: string };
}
export type SessionsErrorCodeV1 = 'invalid-operation' | 'unknown-session' | 'authority-denied' | 'depth-limit' | 'child-limit' | 'harness-unavailable' | 'not-allowed' | 'busy' | 'unavailable';
export type SessionsToolResultV1 =
  | { ok: false; code: SessionsErrorCodeV1; message: string }
  | { ok: true; sessionId: string; title: string; state: LinkedChatStateV1; answer?: string; cut?: boolean }
  | { ok: true; chats: LinkedChatV1[] }
  | { ok: true; state: LinkedChatStateV1; answer?: string; cut?: boolean; queued?: boolean }
  | { ok: true; text: string; page: number; pages: number };

export type SessionLinksCommandV1 =
  | { op: 'find'; sessionId: string }
  | { op: 'link'; sessionId: string; otherSessionId: string }
  | { op: 'unlink'; sessionId: string; otherSessionId: string }
  | { op: 'send'; fromSessionId: string; toSessionId: string; text: string }
  | { op: 'deliver'; sessionId: string; fromSessionId: string }
  | { op: 'settings' }
  | { op: 'update'; enabled: boolean };
export type SessionLinksResultV1 =
  | { type: 'links'; sessionId: string; chats: LinkedChatV1[]; revision: number }
  | { type: 'done' }
  | { type: 'settings'; enabled: boolean; readOnly: boolean };
export type SessionLinksErrorCodeV1 = SessionsErrorCodeV1 | 'read-only' | 'io';
export interface SessionLinksErrorV1 { code: SessionLinksErrorCodeV1; message: string }
export interface SessionLinksChangedV1 { sessionId: string; revision: number }
export const SESSION_LINKS_EVENT_V1 = 'piui://session-links-v1';
export interface SessionLinksHostCommandsV1 {
  session_links_command_v1(command: SessionLinksCommandV1): Promise<SessionLinksResultV1>;
}

/** Strict JSON literals: parsed by the Rust and bridge compatibility tests. */
export const SESSION_LINKS_TOOL_EXAMPLES_V1 = [
  {"op":"start","title":"Review parser","prompt":"Review the parser and report the concrete findings."},
  {"op":"start","title":"Check tests","prompt":"Check the focused tests.","harness":"codex","model":{"provider":"openai","id":"native-model"},"permissionMode":"read-only","wait":true,"waitSeconds":240},
  {"op":"list"},
  {"op":"message","sessionId":"11111111-1111-4111-8111-111111111111","text":"Report your findings.","wait":true,"waitSeconds":0},
  {"op":"read","sessionId":"11111111-1111-4111-8111-111111111111","page":1},
  {"op":"wait","sessionId":"11111111-1111-4111-8111-111111111111","waitSeconds":240},
  {"op":"stop","sessionId":"11111111-1111-4111-8111-111111111111"}
] satisfies readonly SessionsToolOperationV1[];
