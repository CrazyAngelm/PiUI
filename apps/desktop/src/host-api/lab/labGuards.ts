import type { WorkspaceModel } from './labContracts';
import { workspaceFailure } from './labErrors';
import { isUuid } from './labRandom';
import { verifiedProject, type LabLiveState, type LabSessionRecord, type LabState } from './labState';

/**
 * Input rules and access gates shared by the workspace routes. Each helper
 * mirrors a named Rust validator so rejections carry the host's error codes.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

/** `validate_token` */
export function validToken(value: string): boolean {
  return value.trim() !== '' && !hasControl(value);
}

/** `validate_text` */
export function validText(value: string): boolean {
  return value.trim() !== '' && !value.includes('\u0000');
}

/** `normalized_title` */
export function normalizedTitle(value: string): string | undefined {
  const title = value.trim();
  return title !== '' && !hasControl(title) ? title : undefined;
}

/** `validate_model`: identifiers are tokens and a requested level must be offered by the model. */
export function validateModel(model: WorkspaceModel, thinkingLevel: string | undefined): void {
  if (!validToken(model.id) || !validToken(model.name)) throw workspaceFailure('INVALID_ARGUMENT');
  if (typeof model.provider === 'string' && !validToken(model.provider)) throw workspaceFailure('INVALID_ARGUMENT');
  if (thinkingLevel === undefined) return;
  if (!validToken(thinkingLevel)) throw workspaceFailure('INVALID_ARGUMENT');
  if (model.thinkingLevels && !model.thinkingLevels.includes(thinkingLevel)) throw workspaceFailure('INVALID_ARGUMENT');
}

/** `host.workspace.record`: registry lookup only. */
export function requireRecord(state: LabState, sessionId: string): LabSessionRecord {
  const record = state.sessions.get(sessionId);
  if (record === undefined) throw workspaceFailure('NOT_FOUND');
  return record;
}

/** `authorize_live_session`: the record exists and its project is trusted. */
export function authorizeLive(state: LabState, sessionId: string): LabSessionRecord {
  const record = requireRecord(state, sessionId);
  verifiedProject(state, record.workspaceId, true);
  return record;
}

/** `live_runtime(..).ok_or_else(closed)`: a UUID address with an open runtime. */
export function requireLive(record: LabSessionRecord): LabLiveState {
  if (!isUuid(record.id)) throw workspaceFailure('INVALID_ARGUMENT');
  if (record.live === undefined) throw workspaceFailure('SESSION_CLOSED');
  return record.live;
}
