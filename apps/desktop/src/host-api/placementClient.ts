import { hostInvoke, type HostInvoke } from './transport';
import type {
  ChatPlacementV1,
  WorkspacePlacementCommandV1,
  WorkspacePlacementResultV1,
  WorktreePreviewV1,
  WorktreeStateV1,
} from '../../../../contracts/workspace-placement-v1';
import { count, isRecord, optionalString, SessionToolError, sessionToolError } from './sessionToolErrors';

export type * from '../../../../contracts/workspace-placement-v1';

/**
 * Client of `workspace_placement_v1`: worktree chats, handoff links and where
 * each chat came from. Shapes are checked; refusals map to safe copy.
 */
const STATES: readonly WorktreeStateV1[] = ['ready', 'missing', 'removed'];

export function isPlacement(value: unknown): value is ChatPlacementV1 {
  if (!isRecord(value) || typeof value.sessionId !== 'string') return false;
  const worktree = value.worktree;
  const worktreeValid =
    worktree === undefined ||
    (isRecord(worktree) &&
      typeof worktree.branch === 'string' &&
      typeof worktree.path === 'string' &&
      STATES.includes(worktree.state as WorktreeStateV1) &&
      typeof worktree.base === 'string');
  return worktreeValid && optionalString(value.continuedFrom) && (value.adopted === undefined || value.adopted === true);
}

function isPreview(value: unknown): value is WorktreePreviewV1 {
  if (!isRecord(value) || !isRecord(value.base)) return false;
  return (
    typeof value.workspaceId === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.folder === 'string' &&
    typeof value.path === 'string' &&
    typeof value.base.commit === 'string' &&
    typeof value.base.short === 'string' &&
    optionalString(value.base.branch) &&
    typeof value.projectChanges === 'boolean'
  );
}

/** The result exactly as the contract describes it, or undefined. */
export function decodePlacementResult(value: unknown): WorkspacePlacementResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  switch (value.type) {
    case 'placements':
      return Array.isArray(value.placements) && value.placements.every(isPlacement)
        ? (value as unknown as WorkspacePlacementResultV1)
        : undefined;
    case 'preview':
      return isPreview(value.preview) ? (value as unknown as WorkspacePlacementResultV1) : undefined;
    case 'created':
      return isRecord(value.snapshot) && isRecord(value.snapshot.session) && isPlacement(value.placement)
        ? (value as unknown as WorkspacePlacementResultV1)
        : undefined;
    case 'removed':
      return typeof value.sessionId === 'string' && isPlacement(value.placement)
        ? (value as unknown as WorkspacePlacementResultV1)
        : undefined;
    case 'dirty':
      return typeof value.sessionId === 'string' && count(value.changes) && typeof value.fingerprint === 'string'
        ? (value as unknown as WorkspacePlacementResultV1)
        : undefined;
    default:
      return undefined;
  }
}

export interface PlacementClient {
  request(command: WorkspacePlacementCommandV1): Promise<WorkspacePlacementResultV1>;
}

export function createPlacementClient(invoke: HostInvoke): PlacementClient {
  return {
    async request(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('workspace_placement_v1', { command });
      } catch (error) {
        throw sessionToolError(error);
      }
      const decoded = decodePlacementResult(result);
      if (decoded === undefined) throw new SessionToolError('unknown', 'The operation could not be completed.');
      return decoded;
    },
  };
}

export const placementHost: PlacementClient = createPlacementClient((command, args) => hostInvoke(command, args));
