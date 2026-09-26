import type { OrchestrationHostErrorCode } from './labContracts';

/**
 * Rejection values exactly as the Rust host serializes them. Tauri rejects an
 * `invoke` with the serialized error object itself (not an `Error`), so the
 * lab throws plain objects and lets the typed clients map them.
 */
export interface HostErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export type WorkspaceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SAFE_MODE'
  | 'NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'CONFLICT'
  | 'IO_ERROR'
  | 'NOT_SUPPORTED'
  | 'RUNTIME_FAILED'
  | 'APPROVAL_EXPIRED'
  | 'NOT_TRUSTED'
  | 'PROJECT_UNAVAILABLE'
  | 'TURN_ACTIVE'
  | 'NO_ACTIVE_TURN'
  | 'QUEUE_PENDING'
  | 'DELIVERY_UNCERTAIN';

/** `SESSION_CLOSED` is the host's `closed()` constructor: code NOT_FOUND with its own message. */
const WORKSPACE_ERRORS: Readonly<Record<WorkspaceErrorCode, readonly [string, string]>> = {
  INVALID_ARGUMENT: ['INVALID_ARGUMENT', 'The workspace request is invalid.'],
  SAFE_MODE: ['SAFE_MODE', 'Only the workspace catalog is available in safe mode.'],
  NOT_FOUND: ['NOT_FOUND', 'The workspace session was not found.'],
  SESSION_CLOSED: ['NOT_FOUND', 'Open the workspace session before using it.'],
  CONFLICT: ['CONFLICT', 'The workspace session changed during this operation.'],
  IO_ERROR: ['IO_ERROR', 'PiUI could not update the local workspace catalog.'],
  NOT_SUPPORTED: ['NOT_SUPPORTED', 'The selected native harness does not support this operation.'],
  RUNTIME_FAILED: ['RUNTIME_FAILED', 'The native harness could not complete the request.'],
  APPROVAL_EXPIRED: ['APPROVAL_EXPIRED', 'That approval is no longer pending for this session.'],
  NOT_TRUSTED: ['NOT_TRUSTED', 'Trust this project before starting a runtime.'],
  PROJECT_UNAVAILABLE: ['PROJECT_UNAVAILABLE', 'This project folder is currently unavailable. Its cached read-only history remains local.'],
  TURN_ACTIVE: ['TURN_ACTIVE', 'Wait for the current turn.'],
  NO_ACTIVE_TURN: ['NO_ACTIVE_TURN', 'There is no active turn to steer.'],
  QUEUE_PENDING: ['QUEUE_PENDING', 'Resolve queued messages before compacting.'],
  DELIVERY_UNCERTAIN: ['DELIVERY_UNCERTAIN', 'Check native history before dismissing the uncertain message.'],
};

export function workspaceFailure(kind: WorkspaceErrorCode): HostErrorPayload {
  const [code, message] = WORKSPACE_ERRORS[kind];
  return { code, message, recoverable: true };
}

export type ApiErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOT_TRUSTED' | 'PROJECT_UNAVAILABLE';

const API_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  INVALID_ARGUMENT: 'The request is not valid.',
  NOT_FOUND: 'The requested local record is unavailable.',
  NOT_TRUSTED: 'Trust this project before starting a runtime.',
  PROJECT_UNAVAILABLE: 'This project folder is currently unavailable. Its cached read-only history remains local.',
};

/** Classic `api.rs` errors (bootstrap, preferences, projects). */
export function apiFailure(code: ApiErrorCode): HostErrorPayload {
  return { code, message: API_MESSAGES[code], recoverable: true };
}

/** Orchestration errors carry only a stable code. */
export function orchestrationFailure(code: OrchestrationHostErrorCode): { readonly code: OrchestrationHostErrorCode } {
  return { code };
}

export function isHostErrorPayload(value: unknown): value is HostErrorPayload {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';
}

/**
 * Argument decoding failure. The router converts it to the plain string Tauri
 * produces when serde rejects command arguments (for example unknown fields).
 */
export class LabDecodeFailure extends Error {
  constructor(readonly detail: string, readonly argument?: string, readonly missing = false) {
    super(detail);
    this.name = 'LabDecodeFailure';
  }
}

export function tauriArgumentError(command: string, failure: LabDecodeFailure): string {
  const argument = failure.argument ?? 'args';
  const detail = failure.missing ? `command ${command} missing required key ${argument}` : failure.detail;
  return `invalid args \`${argument}\` for command \`${command}\`: ${detail}`;
}

/**
 * A native adapter refusing an operation. Routes map it to their own codes,
 * as the host does (plain `send` reports RUNTIME_FAILED, the composer is specific).
 */
export type NativeRejectionCode = 'no-active-turn' | 'turn-active' | 'unsupported' | 'exited' | 'invalid';

export class NativeRejection extends Error {
  constructor(readonly code: NativeRejectionCode) {
    super(code);
    this.name = 'NativeRejection';
  }
}
