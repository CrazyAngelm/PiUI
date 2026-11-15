/**
 * Turns the computer's `gap` frames (an event was too big to forward) into at most one reload of the
 * shell state. A burst of gaps settles into a single run, and runs keep a distance from each other,
 * so a session that keeps producing oversized events cannot make the screen reload in a loop.
 */

export const RESYNC_SETTLE_MS = 300;
export const RESYNC_COOLDOWN_MS = 5000;

export interface Resync {
  /** Asks for a run; coalesced with a run that is already scheduled. */
  request(): void;
  /** Drops a scheduled run. */
  cancel(): void;
}

export function createResync(run: () => Promise<void> | void, settleMs: number = RESYNC_SETTLE_MS, cooldownMs: number = RESYNC_COOLDOWN_MS): Resync {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRun: number | undefined;

  const fire = (): void => {
    timer = undefined;
    lastRun = Date.now();
    // A failing run must not become an unhandled rejection; the caller owns its own error screen.
    void Promise.resolve()
      .then(run)
      .catch(() => undefined);
  };

  return {
    request() {
      if (timer !== undefined) return;
      const wait = lastRun === undefined ? settleMs : Math.max(settleMs, lastRun + cooldownMs - Date.now());
      timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
