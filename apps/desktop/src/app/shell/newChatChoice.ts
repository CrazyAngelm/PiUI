import type { HarnessKind, PermissionMode } from '../../../../../contracts/workspace-v15';

/** What the new-chat composer remembers per project (local UI metadata). */
export interface NewChatChoice {
  harness?: HarnessKind;
  modelKey?: string;
  thinkingLevel?: string;
  fast?: boolean;
  permissionMode?: PermissionMode;
}

/** Remembered choices: one per project, and the latest one for a project that has none yet. */
export interface NewChatChoices {
  projects: Record<string, NewChatChoice>;
  last?: NewChatChoice;
}

/** A project's own choice, else the latest one made in any project: a new project starts like the last one. */
export function choiceFor(choices: NewChatChoices, workspaceId: string): NewChatChoice | undefined {
  return choices.projects[workspaceId] ?? choices.last;
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
