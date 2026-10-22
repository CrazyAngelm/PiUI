/**
 * Guards an action that loads a lazy module before it navigates. The inputs
 * are captured when the action begins; when the load finishes the action may
 * only go on if nothing changed meanwhile: the same key (for example the
 * selected project), no newer attempt and a composer that is still mounted.
 */
export interface OpenGuard<K> {
  /** Starts an attempt for `key`; the returned check says whether it may still complete. */
  begin(key: K, current: () => K): () => boolean;
  /** The owner went away: no pending attempt may complete. */
  close(): void;
}

export function createOpenGuard<K>(): OpenGuard<K> {
  let latest = 0;
  let closed = false;
  return {
    begin(key, current) {
      const attempt = ++latest;
      return () => !closed && attempt === latest && current() === key;
    },
    close() {
      closed = true;
    },
  };
}
