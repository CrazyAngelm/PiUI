import type { AgentGraph } from '../../features/orchestration/agentGraph';

/** Why a draft opens in the editor; decides the notice shown with it. */
export type DraftSource = 'run' | 'template';

interface PendingDraft {
  readonly workspaceId: string;
  readonly graph: AgentGraph;
  readonly source: DraftSource;
}

/**
 * A draft another screen asks the pipeline editor to open, e.g. a template
 * chosen in the chat composer. It is taken once, by the editor of the same
 * project; nothing is saved until the person saves it there.
 */
class PendingDrafts {
  private current = $state.raw<PendingDraft | undefined>();

  offer(workspaceId: string, graph: AgentGraph, source: DraftSource): void {
    this.current = { workspaceId, graph, source };
  }

  take(workspaceId: string): PendingDraft | undefined {
    const draft = this.current;
    if (!draft || draft.workspaceId !== workspaceId) return undefined;
    this.current = undefined;
    return draft;
  }
}

export const pendingDrafts = new PendingDrafts();
