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

export function resolveNewCatalogSession<T extends { id: string; createdAt?: string }>(
  sessions: readonly T[],
  knownSessionIds: ReadonlySet<string>,
  startedAt: number | undefined,
): T | undefined {
  const unseen = sessions.filter((session) => !knownSessionIds.has(session.id));
  if (startedAt === undefined) return unseen.length === 1 ? unseen[0] : undefined;

  // A catalog snapshot captured before initial hydration can make every old
  // chat look "new". Pi timestamps the real session when the runtime starts,
  // so retain only candidates created around or after this pending start.
  const recent = unseen.filter((session) => {
    if (session.createdAt === undefined) return false;
    const createdAt = Date.parse(session.createdAt);
    return Number.isFinite(createdAt) && createdAt >= startedAt - 2_000;
  });
  return recent.length === 1 ? recent[0] : undefined;
}

export function withoutPersistedLiveBlocks<T extends { id: string }>(
  blocks: readonly T[],
  persistedBlockIds: ReadonlySet<string>,
): T[] {
  return blocks.filter((block) => !persistedBlockIds.has(block.id));
}
