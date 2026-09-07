import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';

/** A project switch never starts or stops a native session. */
export function sessionForProject(sessions: WorkspaceSession[], projectId: string, currentId: string): string {
  return sessions.some((session) => session.id === currentId && session.workspaceId === projectId) ? currentId : '';
}

export function shortcutModifier(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl+';
}

/** Focus belongs to the modal until it closes; restore the initiating control. */
export function modalFocus(node: HTMLElement, onEscape: () => void): { destroy: () => void } {
  const previous = document.activeElement;
  const controls = () => Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter((item) => item.getClientRects().length > 0);
  node.focus();
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (event.key === 'Tab') {
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); node.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) { event.preventDefault(); first.focus(); }
    }
  }
  node.addEventListener('keydown', keydown);
  return { destroy() { node.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); } };
}
