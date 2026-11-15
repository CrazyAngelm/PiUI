/**
 * Times reasoning blocks that were seen while they streamed. Native histories
 * carry no reasoning duration, so a block that was never seen running has none.
 */
export interface ReasoningClock {
  /** Records the block's state at `now` (milliseconds); whole seconds once it has finished. */
  observe(id: string, live: boolean, now: number): number | undefined;
}

const LIMIT = 400;

export function createReasoningClock(): ReasoningClock {
  const timings = new Map<string, { startedAt: number; seconds?: number }>();
  return {
    observe(id, live, now) {
      const known = timings.get(id);
      if (live) {
        if (!known) {
          if (timings.size >= LIMIT) {
            const oldest = timings.keys().next();
            if (!oldest.done) timings.delete(oldest.value);
          }
          timings.set(id, { startedAt: now });
        }
        return undefined;
      }
      if (!known) return undefined;
      known.seconds ??= Math.max(0, Math.round((now - known.startedAt) / 1000));
      return known.seconds;
    },
  };
}

/** Minutes and seconds for the label; nothing under one second. */
export function reasoningDuration(seconds: number): { minutes: number; seconds: number } | undefined {
  if (seconds < 1) return undefined;
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}
