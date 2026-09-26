import { desktopAvailable, hostInvoke, hostListen } from './transport';
import type { WorkspaceCatalog, WorkspaceCommand, WorkspaceEvent, WorkspaceResult, SessionSnapshot } from '../../../../contracts/workspace-v15';
export type { WorkspaceCatalog, WorkspaceCommand, WorkspaceEvent, WorkspaceResult, SessionSnapshot } from '../../../../contracts/workspace-v15';
export type WorkspaceInvoke = (route: string, args: { command: WorkspaceCommand }) => Promise<WorkspaceResult>;
export type WorkspaceListen = (channel: string, handler: (event: WorkspaceEvent) => void) => Promise<() => void>;
export interface WorkspaceClient {
  request(command: WorkspaceCommand): Promise<WorkspaceResult>;
  catalog(): Promise<WorkspaceCatalog>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  listen(handler: (event: WorkspaceEvent) => void): Promise<() => void>;
}
const SAFE_ERRORS: Record<string, string> = {
  NOT_TRUSTED: 'Trust this project before starting or controlling its agents.',
  NOT_FOUND: 'This workspace or session is no longer available.',
  CONFLICT: 'The project or session changed. Refresh it before continuing.',
  INVALID_ARGUMENT: 'Check the required fields and try again.',
  NOT_SUPPORTED: 'This operation is not supported by the selected harness or current mode.',
  UNAVAILABLE: 'The selected harness is unavailable. Check its installation and native sign-in.',
  SIGN_IN_REQUIRED: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.',
  TURN_ACTIVE: 'Wait for the current turn.',
  NO_ACTIVE_TURN: 'There is no active turn to steer.',
  QUEUE_PENDING: 'Resolve queued messages before compacting.',
  DELIVERY_UNCERTAIN: 'Check native history before dismissing the uncertain message.',
  RUNTIME_FAILED: 'The harness could not complete the operation. Its saved history has not been removed.',
  SESSION_ALREADY_ACTIVE: 'This session is already active in another client. Stop it there before reopening it.',
  SAFE_MODE: 'Runtime actions are disabled in safe mode.',
  APPROVAL_EXPIRED: 'This approval is no longer pending. Refresh the session.',
  IO_ERROR: 'The local workspace data could not be saved. Your native session history has not been removed.',
  ACP_TRUST_REQUIRED: 'Review and trust this agent in Settings → Harnesses before starting it.',
  ACP_VERSION_UNCONFIRMED: "Confirm this agent's version in Settings → Harnesses before starting it.",
  ACP_SIGN_IN_REQUIRED: 'Sign in to this agent with its own app, then try again. Settings → Harnesses shows how.',
  // Composer inputs v1 and composer v19 attachments.
  IMAGES_UNSUPPORTED: 'This harness or its current model does not accept images. Remove the images or switch models.',
  ATTACHMENT_UNAVAILABLE: 'An attached image is no longer available. Attach it again.',
  FILES_UNAVAILABLE: 'The project files could not be listed.',
  DROP_EXPIRED: 'The dropped files are no longer available. Drop them again.',
  PROJECT_UNAVAILABLE: 'The project folder is unavailable.',
  // Worktree chats (workspace placement v1) refused by the ordinary open.
  WORKTREE_REMOVED: "This chat's worktree was removed. Its history stays readable; start a new chat to keep working.",
  WORKTREE_UNAVAILABLE: "This chat's worktree folder is missing or no longer belongs to the project's repository.",
  GIT_UNAVAILABLE: 'Git was not found. Install git and make sure it is on PATH.',
};
export class WorkspaceOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkspaceOperationError'; }
}
export function workspaceError(cause: unknown): WorkspaceOperationError {
  let value: unknown = cause;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { value = undefined; }
  }
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code : 'UNKNOWN';
  return new WorkspaceOperationError(code, SAFE_ERRORS[code] ?? 'The workspace operation could not be completed.');
}
export function createWorkspaceClient(invokeCommand: WorkspaceInvoke, listenEvents: WorkspaceListen): WorkspaceClient {
  async function request(command: WorkspaceCommand): Promise<WorkspaceResult> {
    try { return await invokeCommand('workspace_command_v15', { command }); }
    catch (error) { throw workspaceError(error); }
  }
  return {
    request,
    async catalog() {
      const result = await request({ type: 'catalog' });
      if (result.type !== 'catalog' || result.catalog.protocol !== 15) throw workspaceError(undefined);
      return result.catalog;
    },
    async snapshot(sessionId) {
      const result = await request({ type: 'snapshot', sessionId });
      if (result.type !== 'session' || result.snapshot.session.id !== sessionId) throw workspaceError(undefined);
      return result.snapshot;
    },
    async listen(handler) {
      return listenEvents('piui://workspace-event', (event) => {
        if (event.protocol === 15 && Number.isSafeInteger(event.revision) && event.revision >= 0) handler(event);
      });
    },
  };
}
export const workspaceDesktopAvailable = desktopAvailable;
export const workspaceHost: WorkspaceClient = createWorkspaceClient(
  (route, args) => hostInvoke<WorkspaceResult>(route, args),
  (channel, handler) => hostListen<WorkspaceEvent>(channel, handler),
);
