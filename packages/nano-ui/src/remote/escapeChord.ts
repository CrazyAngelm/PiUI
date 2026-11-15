/**
 * Escape belongs to the shell: it closes menus, dialogs and the drawer, so a single press must never
 * end the remote session. Pressing it twice in quick succession asks the host page, which owns the
 * Disconnect bar, to move keyboard focus there. The page does the rest (Enter or Escape on the bar
 * disconnects). The message carries no data beyond its kind, and only the same origin may send it.
 */
export const FOCUS_BAR_MESSAGE = Object.freeze({ nanoRemote: 1, type: 'focus-bar' });

export const ESCAPE_CHORD_MS = 800;

interface KeyLike {
  readonly key: string;
  readonly repeat: boolean;
  readonly timeStamp: number;
}

/** Returns a function that says whether this key press completes the double-Escape chord. */
export function createEscapeChord(windowMs: number = ESCAPE_CHORD_MS): (event: KeyLike) => boolean {
  let last: number | undefined;
  return (event) => {
    if (event.key !== 'Escape') {
      last = undefined;
      return false;
    }
    if (event.repeat) return false;
    if (last !== undefined && event.timeStamp - last <= windowMs && event.timeStamp >= last) {
      last = undefined;
      return true;
    }
    last = event.timeStamp;
    return false;
  };
}

/** Posts the chord to the embedding page. Does nothing when the page is not in a frame. */
export function installEscapeChord(target: Window): void {
  const chord = createEscapeChord();
  target.addEventListener('keydown', (event) => {
    if (!chord(event)) return;
    if (target.parent === target) return;
    target.parent.postMessage(FOCUS_BAR_MESSAGE, target.location.origin);
  });
}
