/**
 * PiUI workspace adoption protocol v1 (`workspace_adopt_v1`): continue a Pi
 * session that was started in the Pi terminal app as a PiUI chat
 * (docs/CLASSIC_PARITY.md gap 1). Independently versioned; workspace v15 is
 * unchanged.
 *
 * `sessionId` is the index session id from the session history view;
 * without `projectId` it names a personal (projectless) Pi chat. In a
 * trusted Pi folder, outside safe mode, the host checks the session file as
 * the classic live start did (indexed ownership, the header's project, a
 * stable revision, separate Pi and Prime Agent roots), refuses Prime Agent
 * folders (`NOT_SUPPORTED`) and a session the classic live runtime holds or
 * that was written in the last seconds (`SESSION_ALREADY_ACTIVE` — it may
 * still be open in the terminal), then returns the chat already bound to that
 * file (`created: false`) or registers a closed Pi chat bound to it
 * (`created: true`). Open it with the ordinary workspace v15 `openSession`,
 * which resumes it with `pi --session`. PiUI never writes the session file
 * and never renames the session. The terminal and PiUI must not write the
 * same session at the same time (risk R-06).
 */
export const WORKSPACE_ADOPT_PROTOCOL = 1 as const;

export interface WorkspaceAdoptRequestV1 {
  projectId?: string;
  sessionId: string;
}

export interface WorkspaceAdoptResultV1 {
  protocol: 1;
  /** The workspace chat to open. */
  sessionId: string;
  created: boolean;
}

export type AdoptErrorCode =
  | 'SAFE_MODE'
  | 'NOT_TRUSTED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'NOT_SUPPORTED'
  | 'CONFLICT'
  | 'SESSION_ALREADY_ACTIVE'
  | 'PROJECT_UNAVAILABLE'
  | 'IO_ERROR';

export interface AdoptErrorV1 { code: AdoptErrorCode; message: string; recoverable: boolean }
