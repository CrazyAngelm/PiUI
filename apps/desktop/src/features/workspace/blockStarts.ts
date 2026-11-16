/**
 * When this window saw a tool call start (ADR-072). A live timeline block
 * carries no start instant, so the arrival of its first streaming event stands
 * in for it; a call that was already running when its chat was loaded has none.
 */
const LIMIT = 256;
const starts = new Map<string, number>();
const key = (sessionId: string, blockId: string): string => `${sessionId}\n${blockId}`;

export function noteBlockStart(sessionId: string, blockId: string, now: number = Date.now()): void {
  const id = key(sessionId, blockId);
  if (starts.has(id)) return;
  if (starts.size >= LIMIT) {
    const oldest = starts.keys().next();
    if (!oldest.done) starts.delete(oldest.value);
  }
  starts.set(id, now);
}

export function blockStartedAt(sessionId: string, blockId: string): number | undefined {
  return starts.get(key(sessionId, blockId));
}

/** Tests only. */
export function forgetBlockStarts(): void {
  starts.clear();
}
