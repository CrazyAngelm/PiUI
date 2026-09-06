export const SESSION_PERSISTENCE_FEEDBACK_DELAY_MS = 8_500;
export const PRIME_RUNTIME_BINDING_ERROR = 'Prime Agent binding failed.';
export const PRIME_RUNTIME_BINDING_PENDING = 'Prime Agent runtime session binding is still pending.';

const PENDING_PERSISTENCE_MESSAGES = new Set([
  'Pi has not persisted the completed personal turn yet.',
  'Pi has not persisted the completed project turn yet.',
  PRIME_RUNTIME_BINDING_PENDING,
]);

export function isPendingSessionPersistenceError(error: unknown): boolean {
  return error instanceof Error && PENDING_PERSISTENCE_MESSAGES.has(error.message);
}

export function didResolveNewSession(previousSessionId: string | undefined, nextSessionId: string | undefined): boolean {
  return previousSessionId === undefined && nextSessionId !== undefined;
}

/**
 * Resolves only the host-indexed opaque id handed back by a new Prime runtime.
 * Prime must never infer a session from catalog timing or ordering because other
 * Prime runtimes can add rows to the same project at the same time.
 */
export function resolvePrimeRuntimeCatalogSession<T extends { id: string }>(
  sessions: readonly T[],
  opaqueSessionId: string | undefined,
): T | undefined {
  return opaqueSessionId === undefined
    ? undefined
    : sessions.find((session) => session.id === opaqueSessionId);
}

export function acceptsPrimeRuntimeBindingSnapshot<T extends { id: string }>(
  sessions: readonly T[],
  opaqueSessionId: string,
  snapshotSequence: number,
  bindingSequence: number,
): boolean {
  return snapshotSequence > bindingSequence
    || resolvePrimeRuntimeCatalogSession(sessions, opaqueSessionId) !== undefined;
}

export function ownsRuntimeBinding(
  selectedProjectId: string | undefined,
  projectId: string,
  sessionEpoch: number,
  expectedSessionEpoch: number,
  chatEpoch: number,
  expectedChatEpoch: number,
): boolean {
  return selectedProjectId === projectId
    && sessionEpoch === expectedSessionEpoch
    && chatEpoch === expectedChatEpoch;
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
