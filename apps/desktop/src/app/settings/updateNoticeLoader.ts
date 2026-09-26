/**
 * Starts update notices well after first paint. The notices, the update client
 * and the About page load as separate chunks, so the first paint never ships
 * update code and never waits for the host.
 */
const NOTICE_DELAY_MS = 4_000;

export function scheduleUpdateNotices(open: () => void): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  const timer = setTimeout(() => {
    void import('./updateNotices')
      .then((module) => module.watchUpdateNotices(open))
      .then(
        (unsubscribe) => {
          if (stopped) unsubscribe();
          else stop = unsubscribe;
        },
        () => undefined,
      );
  }, NOTICE_DELAY_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    stop?.();
  };
}
