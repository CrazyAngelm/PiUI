/**
 * The saved pipeline a project's editor had open last, so leaving the editor
 * for Runs or Automations and coming back does not start from an empty draft.
 * It lives in the WebView per project and is only a convenience: the id may
 * name a pipeline that is gone, and a blocked or broken storage is ignored.
 */
const KEY = 'piui.pipelines.last.v1:';

export function lastPipelineKey(workspaceId: string): string {
  return KEY + workspaceId;
}

/** The launch command id of the last open pipeline of a project, if any is remembered. */
export function readLastPipeline(workspaceId: string): string | undefined {
  try {
    const id = localStorage.getItem(lastPipelineKey(workspaceId));
    return id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function rememberLastPipeline(workspaceId: string, id: string): void {
  if (!id) return;
  try {
    localStorage.setItem(lastPipelineKey(workspaceId), id);
  } catch {
    // Remembering the pipeline is a convenience.
  }
}

/** A new pipeline starts a fresh editor: nothing is reopened afterwards. */
export function forgetLastPipeline(workspaceId: string): void {
  try {
    localStorage.removeItem(lastPipelineKey(workspaceId));
  } catch {
    // Nothing to forget.
  }
}
