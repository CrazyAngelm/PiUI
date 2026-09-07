import type {
  HarnessKind,
  SessionSnapshot,
  WorkspaceApproval,
  WorkspaceCatalog,
  WorkspaceEvent,
  WorkspaceSession,
} from '../../../../../contracts/workspace-v15';

export type EventApplication =
  | { type: 'applied'; snapshot: SessionSnapshot }
  | { type: 'stale'; snapshot: SessionSnapshot }
  | { type: 'gap'; snapshot: SessionSnapshot; expectedRevision: number; receivedRevision: number; reason: 'revision' | 'missing-block' };

export function applyWorkspaceEvent(snapshot: SessionSnapshot, incoming: WorkspaceEvent): EventApplication {
  if (incoming.sessionId !== snapshot.session.id || incoming.revision <= snapshot.revision) {
    return { type: 'stale', snapshot };
  }
  // Closed is the host-authoritative lifecycle watermark. Late events from the
  // disposed generation cannot reopen the session or recreate approvals. Only
  // an explicit openSession result followed by a snapshot may replace it.
  if (snapshot.session.status === 'closed') return { type: 'stale', snapshot };
  const expectedRevision = snapshot.revision + 1;
  if (incoming.revision !== expectedRevision) {
    return { type: 'gap', snapshot, expectedRevision, receivedRevision: incoming.revision, reason: 'revision' };
  }

  const event = incoming.event;
  let next: SessionSnapshot = { ...snapshot, revision: incoming.revision };
  switch (event.type) {
    case 'session':
      next = { ...next, session: event.session };
      break;
    case 'block': {
      const index = next.blocks.findIndex((block) => block.id === event.block.id);
      const blocks = index < 0
        ? [...next.blocks, event.block]
        : next.blocks.map((block, blockIndex) => blockIndex === index ? event.block : block);
      next = { ...next, blocks };
      break;
    }
    case 'textDelta': {
      if (!next.blocks.some((block) => block.id === event.blockId)) {
        return { type: 'gap', snapshot, expectedRevision, receivedRevision: incoming.revision, reason: 'missing-block' };
      }
      const blocks = next.blocks.map((block) => block.id === event.blockId
        ? { ...block, text: `${block.text ?? ''}${event.text}` }
        : block);
      next = { ...next, blocks };
      break;
    }
    case 'approval': {
      const approvals = upsertApproval(next.approvals, event.approval);
      next = { ...next, approvals };
      break;
    }
    case 'approvalResolved':
      next = { ...next, approvals: next.approvals.filter((request) => request.id !== event.requestId) };
      break;
    case 'error':
      break;
    default:
      return assertNever(event);
  }
  return { type: 'applied', snapshot: next };
}

function upsertApproval(approvals: WorkspaceApproval[], approval: WorkspaceApproval): WorkspaceApproval[] {
  const index = approvals.findIndex((request) => request.id === approval.id);
  return index < 0
    ? [...approvals, approval]
    : approvals.map((request, requestIndex) => requestIndex === index ? approval : request);
}

export function mergeCatalogSession(catalog: WorkspaceCatalog, session: WorkspaceSession): WorkspaceCatalog {
  const index = catalog.sessions.findIndex((item) => item.id === session.id);
  const sessions = index < 0
    ? [...catalog.sessions, session]
    : catalog.sessions.map((item, itemIndex) => itemIndex === index ? session : item);
  return { ...catalog, sessions };
}

export function acceptWorkspaceSnapshot(
  current: SessionSnapshot | undefined,
  incoming: SessionSnapshot,
  allowClosedReopen = false,
): SessionSnapshot {
  if (current?.session.status === 'closed' && incoming.session.status !== 'closed' && !allowClosedReopen) return current;
  if (current && current.revision > incoming.revision && !allowClosedReopen) return current;
  return incoming;
}

export function retainSnapshotWithCatalogSession(snapshot: SessionSnapshot, session: WorkspaceSession): SessionSnapshot {
  if (snapshot.session.id !== session.id) return snapshot;
  return { ...snapshot, session, approvals: session.status === 'closed' ? [] : snapshot.approvals };
}

export interface CloseCatalogResolution {
  snapshot: SessionSnapshot;
  error: string | undefined;
}

export function resolveCloseAfterCatalog(
  snapshot: SessionSnapshot,
  catalogSession: WorkspaceSession | undefined,
  commandError: string | undefined,
): CloseCatalogResolution {
  return {
    snapshot: catalogSession ? retainSnapshotWithCatalogSession(snapshot, catalogSession) : snapshot,
    error: commandError,
  };
}

export function protectClosedCatalogSessions(catalog: WorkspaceCatalog, snapshots: Record<string, SessionSnapshot>): WorkspaceCatalog {
  return {
    ...catalog,
    sessions: catalog.sessions.map((session) => {
      const retained = snapshots[session.id];
      return retained?.session.status === 'closed' && session.status !== 'closed' ? retained.session : session;
    }),
  };
}

export function harnessLabel(kind: HarnessKind): string {
  switch (kind) {
    case 'pi': return 'Pi';
    case 'prime-agent': return 'Prime Agent';
    case 'codex': return 'Codex';
    case 'hermes': return 'Hermes';
    default: return assertNever(kind);
  }
}

export function statusLabel(status: WorkspaceSession['status']): string {
  switch (status) {
    case 'starting': return 'Starting';
    case 'idle': return 'Idle';
    case 'running': return 'Running';
    case 'stopping': return 'Stopping';
    case 'closed': return 'Closed';
    case 'failed': return 'Failed';
    default: return assertNever(status);
  }
}

export function sortedSessions(sessions: WorkspaceSession[]): WorkspaceSession[] {
  return [...sessions].sort((left, right) => {
    const timeOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return Number.isNaN(timeOrder) || timeOrder === 0
      ? left.title.localeCompare(right.title)
      : timeOrder;
  });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected workspace value: ${String(value)}`);
}
