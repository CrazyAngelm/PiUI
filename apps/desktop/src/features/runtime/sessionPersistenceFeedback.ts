export const SESSION_PERSISTENCE_FEEDBACK_DELAY_MS = 8_500;

const PENDING_PERSISTENCE_MESSAGES = new Set([
  'Pi has not persisted the completed personal turn yet.',
  'Pi has not persisted the completed project turn yet.',
]);

export function isPendingSessionPersistenceError(error: unknown): boolean {
  return error instanceof Error && PENDING_PERSISTENCE_MESSAGES.has(error.message);
}

export function didResolveNewSession(previousSessionId: string | undefined, nextSessionId: string | undefined): boolean {
  return previousSessionId === undefined && nextSessionId !== undefined;
}

export function withoutPersistedLiveBlocks<T extends { id: string }>(
  blocks: readonly T[],
  persistedBlockIds: ReadonlySet<string>,
): T[] {
  return blocks.filter((block) => !persistedBlockIds.has(block.id));
}
