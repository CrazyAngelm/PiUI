import type { ChatPlacementV1, WorkspacePlacementCommandV1, WorkspacePlacementResultV1 } from '../../../../../contracts/workspace-placement-v1';

/** The placement client, loaded on first use so first paint stays small. */
export async function placementRequest(command: WorkspacePlacementCommandV1): Promise<WorkspacePlacementResultV1> {
  const { placementHost } = await import('../../host-api/placementClient');
  return placementHost.request(command);
}

/**
 * Where each chat runs and where it came from (workspace placement v1):
 * worktree chats, handoff links and adopted terminal sessions. Loaded when
 * the set of chats changes; the host stays the authority.
 */
export class Placements {
  byId = $state.raw<Readonly<Record<string, ChatPlacementV1>>>({});
  private signature = '';
  private pending: Promise<void> | undefined;
  private again = false;

  constructor(private readonly request: typeof placementRequest = placementRequest) {}

  get(sessionId: string): ChatPlacementV1 | undefined {
    return this.byId[sessionId];
  }

  /** Chats that run in the same worktree as `sessionId`, itself included. */
  sharingWorktree(sessionId: string): string[] {
    const path = this.byId[sessionId]?.worktree?.path;
    if (path === undefined) return [];
    return Object.values(this.byId)
      .filter((placement) => placement.worktree?.path === path)
      .map((placement) => placement.sessionId);
  }

  put(placement: ChatPlacementV1): void {
    this.byId = { ...this.byId, [placement.sessionId]: placement };
  }

  /** Reloads the list; concurrent calls coalesce into one more load. */
  refresh(): Promise<void> {
    if (this.pending !== undefined) {
      this.again = true;
      return this.pending;
    }
    this.pending = (async () => {
      try {
        do {
          this.again = false;
          const result = await this.request({ type: 'list' });
          if (result.type === 'placements') {
            this.byId = Object.fromEntries(result.placements.map((placement) => [placement.sessionId, placement]));
          }
        } while (this.again);
      } catch {
        // Placement is extra metadata; chats stay usable without it.
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  /** Refreshes when the set of chats changed since the last load. */
  sync(sessionIds: readonly string[]): void {
    const signature = [...sessionIds].sort().join(',');
    if (signature === this.signature) return;
    this.signature = signature;
    void this.refresh();
  }
}

export const placements = new Placements();
