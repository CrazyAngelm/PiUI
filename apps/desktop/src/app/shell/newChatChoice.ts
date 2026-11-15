import type { HarnessKind, PermissionMode } from '../../../../../contracts/workspace-v15';

/**
 * Who handled the project's last new chat: a saved pipeline, or the harness
 * picked in the same choice (`pipeline` empty). It is remembered per project:
 * a pipeline belongs to the project it was saved in.
 */
export interface RememberedExecutor {
  /** Launch command id of the saved pipeline; empty when the harness answered directly. */
  pipeline: string;
  /**
   * The project's default chat pipeline when this was remembered ('' for none, absent when
   * it was not known). A different default now means the project's setting changed since:
   * the new default wins over this memory.
   */
  chatDefault?: string;
}

/** What the new-chat composer remembers per project (local UI metadata). */
export interface NewChatChoice {
  harness?: HarnessKind;
  modelKey?: string;
  thinkingLevel?: string;
  fast?: boolean;
  permissionMode?: PermissionMode;
  executor?: RememberedExecutor;
}

/** Remembered choices: one per project, and the latest one for a project that has none yet. */
export interface NewChatChoices {
  projects: Record<string, NewChatChoice>;
  last?: NewChatChoice;
}

/**
 * A project's own choice, else the latest one made in any project: a new project starts like
 * the last one, except for the executor, which is project-scoped.
 */
export function choiceFor(choices: NewChatChoices, workspaceId: string): NewChatChoice | undefined {
  const own = choices.projects[workspaceId];
  if (own) return own;
  const last = choices.last;
  if (!last?.executor) return last;
  const { executor: _projectOnly, ...carried } = last;
  return carried;
}

/** The remembered executor of a choice; a malformed stored value (the storage is editable) counts as none. */
export function executorOf(choice: NewChatChoice | undefined): RememberedExecutor | undefined {
  const value: unknown = choice?.executor;
  if (!value || typeof value !== 'object') return undefined;
  const { pipeline, chatDefault } = value as Record<string, unknown>;
  if (typeof pipeline !== 'string') return undefined;
  return { pipeline, ...(typeof chatDefault === 'string' ? { chatDefault } : {}) };
}

export function withChoice(choices: NewChatChoices, workspaceId: string, choice: NewChatChoice): NewChatChoices {
  return { projects: { ...choices.projects, [workspaceId]: choice }, last: choice };
}

/** The composer's current picks. */
export interface NewChatSelection {
  harness: HarnessKind | '';
  modelKey: string;
  thinkingLevel: string;
  fast: boolean;
  permissionMode: PermissionMode;
}

/** The picks a project starts with: its remembered choice, else the first available harness. */
export function restoredSelection(choice: NewChatChoice | undefined, available: readonly HarnessKind[]): NewChatSelection {
  const remembered = choice?.harness && available.includes(choice.harness) ? choice.harness : undefined;
  const harness = remembered ?? available[0] ?? '';
  // Model settings belong to the remembered harness only.
  const same = remembered !== undefined;
  return {
    harness,
    modelKey: same ? (choice?.modelKey ?? '') : '',
    thinkingLevel: same ? (choice?.thinkingLevel ?? '') : '',
    fast: same ? (choice?.fast ?? false) : false,
    permissionMode: choice?.permissionMode ?? 'native',
  };
}

/**
 * The picks after the harness catalog refreshed. The catalog refreshes on
 * every session change; the user's picks stay as long as the chosen harness
 * is still available. A harness that disappeared (or none chosen yet, before
 * the first catalog) falls back to the remembered choice, and so does a
 * fallback harness once the remembered one becomes available.
 */
export function reconcileSelection(
  current: NewChatSelection,
  available: readonly HarnessKind[],
  choice: NewChatChoice | undefined,
): NewChatSelection {
  if (current.harness && available.includes(current.harness)) {
    // The remembered harness was not available when the project was restored (an
    // agent still being checked at startup): it takes over once it is. Every pick
    // is remembered at once, so this never undoes one.
    if (choice?.harness && choice.harness !== current.harness && available.includes(choice.harness)) {
      return { ...restoredSelection(choice, available), permissionMode: current.permissionMode };
    }
    return current;
  }
  return { ...restoredSelection(choice, available), permissionMode: current.permissionMode };
}

/** What the composer knows when it decides how a new chat starts. */
export interface ExecutorFacts {
  /** Pipelines may be used here at all (a trusted project outside safe mode). */
  allowed: boolean;
  /** The project's default chat pipeline ('' for none); undefined until its library is read. */
  chatDefault: string | undefined;
  /** The library could not be read: the default is unknown and stays out of the decision. */
  libraryFailed: boolean;
  /** Whether the remembered pipeline still exists and takes a chat message; undefined while that is checked. */
  rememberedUsable: boolean | undefined;
}

/** `pipeline` is a launch command id, or empty for a direct chat. `ready: false` means "ask again when the facts change". */
export type StartingExecutor = { ready: false } | { ready: true; pipeline: string };

/**
 * How a new chat of a project starts: like its last chat, else through the project's default
 * chat pipeline, else directly. The memory gives way when the pipeline it names is gone or no
 * longer takes a message, and when the project's default changed after it was made. Without
 * the right to use pipelines everything is direct.
 */
export function startingExecutor(remembered: RememberedExecutor | undefined, facts: ExecutorFacts): StartingExecutor {
  if (!facts.allowed) return { ready: true, pipeline: '' };
  const defaultKnown = facts.chatDefault !== undefined;
  const libraryPending = !defaultKnown && !facts.libraryFailed;
  // Without a snapshot of the default the memory stands as it is; with one, the default must be known to compare.
  const comparable = remembered?.chatDefault !== undefined && defaultKnown;
  if (remembered && remembered.chatDefault !== undefined && libraryPending) return { ready: false };
  const current = remembered && (!comparable || remembered.chatDefault === facts.chatDefault) ? remembered : undefined;
  if (current) {
    if (!current.pipeline) return { ready: true, pipeline: '' };
    if (facts.rememberedUsable === undefined) return { ready: false };
    if (facts.rememberedUsable) return { ready: true, pipeline: current.pipeline };
  }
  if (libraryPending) return { ready: false };
  return { ready: true, pipeline: facts.chatDefault ?? '' };
}
