/**
 * Typed refusals of the session tools (review v1, placement v1, adopt v1).
 * The host answers `{ code, message, recoverable }`; the UI shows fixed copy
 * per code. A few host messages add the one next step for a refusal code and
 * are forwarded only when they are one of the known strings below, so the
 * locale catalog can translate them and no other host text reaches the UI.
 */
export const SESSION_TOOL_ERROR_COPY: Readonly<Record<string, string>> = {
  SAFE_MODE: 'Safe mode is on: PiUI does not change files, git or chats.',
  NOT_TRUSTED: 'Trust this project folder first.',
  NOT_FOUND: 'This chat or file is no longer available. Refresh and try again.',
  INVALID_ARGUMENT: 'Check the request and try again.',
  PROJECT_UNAVAILABLE: 'The project folder is unavailable.',
  CONFLICT: 'This changed while PiUI was working on it. Try again.',
  NOT_A_REPOSITORY: 'This folder is not a git repository.',
  NO_COMMITS: 'The repository has no commits yet. Make a first commit before creating a worktree.',
  INVALID_BRANCH: "Choose a branch name with letters, digits, '.', '_', '-' and '/'.",
  BRANCH_EXISTS: 'A branch with this name already exists. Choose another name.',
  STALE: 'This changed since you reviewed it. Check it again before continuing.',
  NOT_SUPPORTED: 'This action is not available here.',
  TOO_LARGE: 'This change is too large for PiUI to show. Use git directly for it.',
  GIT_UNAVAILABLE: 'Git was not found. Install git and make sure it is on PATH.',
  GIT_REFUSED: 'Git refused this folder because it belongs to another account. Add it to safe.directory in your git settings.',
  GIT_BUSY: 'Another git command is using this repository. Try again in a moment.',
  GIT_FAILED: 'Git could not complete the operation.',
  TRASH_UNAVAILABLE: 'This system has no trash PiUI can use. The file was not changed.',
  TRASH_FAILED: 'The file could not be moved to the trash and was left in place.',
  WORKTREE_REMOVED: "This chat's worktree was removed. Its history stays readable; start a new chat to keep working.",
  WORKTREE_UNAVAILABLE: "This chat's worktree folder is missing or no longer belongs to the project's repository.",
  SESSION_ALREADY_ACTIVE: 'This session was written moments ago and may still be open in the Pi terminal app. Close it there, then try again.',
  IO_ERROR: 'PiUI could not save this change. Nothing was lost.',
  RUNTIME_FAILED: 'The harness could not start. Its saved history has not been removed.',
  SIGN_IN_REQUIRED: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.',
  UNAVAILABLE: 'The selected harness is unavailable. Check it in Settings → Harnesses.',
  ACP_TRUST_REQUIRED: 'Review and trust this agent in Settings → Harnesses before starting it.',
  ACP_VERSION_UNCONFIRMED: "Confirm this agent's version in Settings → Harnesses before starting it.",
  ACP_SIGN_IN_REQUIRED: 'Sign in to this agent with its own app, then try again. Settings → Harnesses shows how.',
  unknown: 'The operation could not be completed.',
};

/** Host messages that name the next step for a code; forwarded verbatim. */
export const SESSION_TOOL_HOST_MESSAGES: readonly string[] = [
  'Resolve this conflict with your tools or the agent first.',
  'Manage submodules with git directly.',
  'This change can only be handled as a whole file.',
  'Stage a new file as a whole.',
  'Move a new file to the trash as a whole.',
  'PiUI moves only regular files to the trash. Remove this link yourself.',
  'Unstage this new file first, then move it to the trash.',
  'This change is too large to show, so PiUI does not revert it.',
  'Unstage these changes first, then revert them.',
  'Worktrees are for project folders. Personal chats have no repository.',
  'This chat does not run in a worktree.',
  'That chat does not run in a worktree.',
  'The chat this one continues is no longer available.',
];

export class SessionToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionToolError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Maps a rejected invoke to a typed error with safe copy. */
export function sessionToolError(cause: unknown): SessionToolError {
  if (cause instanceof SessionToolError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const payload = record(value);
  const code = typeof payload?.code === 'string' && Object.hasOwn(SESSION_TOOL_ERROR_COPY, payload.code) ? payload.code : 'unknown';
  const hostMessage = typeof payload?.message === 'string' && SESSION_TOOL_HOST_MESSAGES.includes(payload.message) ? payload.message : undefined;
  return new SessionToolError(code, hostMessage ?? SESSION_TOOL_ERROR_COPY[code] ?? SESSION_TOOL_ERROR_COPY.unknown ?? '');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return record(value) !== undefined;
}

export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function optionalCount(value: unknown): boolean {
  return value === undefined || count(value);
}
