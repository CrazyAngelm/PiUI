import type { BesideOutcome } from './branchChat';

/** The shell's own breakpoint: below it the selected chat is shown alone and no panes are drawn. */
const NARROW_QUERY = '(max-width: 760px)';

/** Opens a chat in a pane beside the active one, and says what came of it. Everything about the screen layout stays here. */
export async function openBesideChat(sessionId: string): Promise<BesideOutcome> {
  try {
    if (window.matchMedia(NARROW_QUERY).matches) return 'in-place';
    const { workbench } = await import('../shell/panes/workbench.svelte');
    if (workbench.openBeside(sessionId)) return 'opened';
    return workbench.full ? 'full' : 'in-place';
  } catch {
    return 'in-place';
  }
}
