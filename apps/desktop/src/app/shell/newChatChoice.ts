import type { HarnessKind, PermissionMode } from '../../../../../contracts/workspace-v15';

/** What the new-chat composer remembers per project (local UI metadata). */
export interface NewChatChoice {
  harness?: HarnessKind;
  modelKey?: string;
  thinkingLevel?: string;
  fast?: boolean;
  permissionMode?: PermissionMode;
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
 * is still available. Only a harness that disappeared (or none chosen yet,
 * before the first catalog) falls back to the project's remembered choice.
 */
export function reconcileSelection(
  current: NewChatSelection,
  available: readonly HarnessKind[],
  choice: NewChatChoice | undefined,
): NewChatSelection {
  if (current.harness && available.includes(current.harness)) return current;
  return { ...restoredSelection(choice, available), permissionMode: current.permissionMode };
}
