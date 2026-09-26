/**
 * Lab time. Seeded content is expressed as offsets from a fixed epoch so every
 * scenario renders identically on every machine. Live simulation adds only the
 * real time elapsed since the lab host was created.
 */
export const LAB_BASE_TIME = Date.UTC(2026, 8, 26, 9, 30, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Timer seam. Tests substitute fake timers; nothing else in the lab reads the clock. */
export interface LabTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserTimers: LabTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

/** RFC 3339 with the same shape chrono emits: no fractional part for whole seconds. */
export function labIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

/** A seeded instant relative to the lab epoch (negative offsets are in the past). */
export function seededIso(offsetMs: number): string {
  return labIso(LAB_BASE_TIME + offsetMs);
}

export class LabClock {
  private readonly origin: number;

  constructor(readonly timers: LabTimers = browserTimers) {
    this.origin = timers.now();
  }

  /** Simulated wall time: the fixed lab epoch plus real elapsed time. */
  now(): number {
    return LAB_BASE_TIME + Math.max(0, this.timers.now() - this.origin);
  }

  iso(): string {
    return labIso(this.now());
  }

  /** Schedules live simulation work and returns its cancellation. */
  after(ms: number, callback: () => void): () => void {
    const handle = this.timers.setTimeout(callback, Math.max(0, ms));
    return () => this.timers.clearTimeout(handle);
  }

  /** Resolves after `ms`; used for simulated native latency. */
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.after(ms, resolve);
    });
  }
}
