export interface CoalescedReads<A> {
  /** Resolves after a read that started after this call: starts one when idle, else joins the single follow-up. */
  request(arg: A): Promise<void>;
  /** The newest read in flight or queued, without starting one. */
  pending(arg: A): Promise<void> | undefined;
}

interface Flight {
  readonly done: Promise<void>;
  next: Promise<void> | undefined;
}

/**
 * At most one `read` in flight per key; requests that arrive meanwhile share
 * exactly one more read that starts after it finishes, so the final state is
 * never older than the last request. `read` reports its own failures: a
 * rejection is swallowed here so a failed read never blocks the next one.
 */
export function coalesceReads<A = void>(read: (arg: A) => Promise<void>, keyOf: (arg: A) => string = () => ''): CoalescedReads<A> {
  const flights = new Map<string, Flight>();

  async function attempt(arg: A): Promise<void> {
    try {
      await read(arg);
    } catch {
      // The reader owns error reporting.
    }
  }

  function start(arg: A, key: string): Promise<void> {
    const done: Promise<void> = attempt(arg).then(() => {
      const current = flights.get(key);
      if (current?.done === done && current.next === undefined) flights.delete(key);
    });
    flights.set(key, { done, next: undefined });
    return done;
  }

  return {
    request(arg) {
      const key = keyOf(arg);
      const flight = flights.get(key);
      if (flight === undefined) return start(arg, key);
      flight.next ??= flight.done.then(() => start(arg, key));
      return flight.next;
    },
    pending(arg) {
      const flight = flights.get(keyOf(arg));
      return flight === undefined ? undefined : (flight.next ?? flight.done);
    },
  };
}
