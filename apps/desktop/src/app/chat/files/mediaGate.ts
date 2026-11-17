/**
 * One chat's media memory (ADR-074, ADR-077). Every preview a chat shows (a file card, a
 * gallery, a player or an image in an Intelligent UI answer) becomes a `blob:` URL that holds its
 * bytes in memory, and each one crosses the host boundary as base64 first. The gate keeps that
 * bounded for the whole chat, not per widget: a budget that is reserved before a preview is
 * requested (from the size the host listed), and a limit on previews in flight at once.
 *
 * Whoever shows a preview reserves its size, and gives it back when it lets the preview go (the
 * card scrolled far away, a collapsed block, the chat closing). A preview that was let go is
 * fetched again when it is needed.
 */

/** Bytes of previews one chat holds at most. */
export const MEDIA_BUDGET_BYTES = 192 * 1024 * 1024;
/** Previews fetched at once; each one is base64 text plus the decoded bytes while it travels. */
export const MAX_PARALLEL_PREVIEWS = 3;

interface Waiting {
  start(): void;
  cancel(): void;
}

export class MediaGate {
  private held = 0;
  private active = 0;
  private waiting: Waiting[] = [];

  constructor(
    readonly limit: number = MEDIA_BUDGET_BYTES,
    private readonly parallel: number = MAX_PARALLEL_PREVIEWS,
  ) {}

  /** Bytes reserved right now. */
  get heldBytes(): number {
    return this.held;
  }

  /** Reserves `bytes` before a preview is requested. False when they would not fit: nothing is reserved. */
  reserve(bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0 || this.held + bytes > this.limit) return false;
    this.held += bytes;
    return true;
  }

  /** Gives reserved bytes back. */
  release(bytes: number): void {
    this.held = Math.max(0, this.held - bytes);
  }

  /** Runs `task` once fewer than `parallel` transfers are running; the rest wait their turn. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.waiting.shift()?.start();
          });
      };
      if (this.active < this.parallel) start();
      else this.waiting.push({ start, cancel: () => reject(new Error('The chat was closed.')) });
    });
  }

  /** The chat closed: queued transfers are refused and the budget is empty again. */
  reset(): void {
    const queued = this.waiting;
    this.waiting = [];
    this.held = 0;
    for (const entry of queued) entry.cancel();
  }
}
