/** Additive lifecycle route; v11 history and command contracts stay unchanged.
 * Deletion removes the PiUI entry, retaining harness-owned history.
 */
export type WorkspaceLifecycleCommand = { type: 'deleteSession'; sessionId: string };
export interface WorkspaceLifecycleResult { protocol: 17; sessionId: string }
