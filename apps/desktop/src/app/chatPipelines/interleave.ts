/**
 * Places extra rows (a chat's pipeline runs) among transcript items by time.
 * Items without a readable time keep their order and never move a row; rows
 * later than every item go last.
 */
export interface TimedInsert {
  readonly id: string;
  /** ISO 8601 (or epoch milliseconds as text). */
  readonly at: string;
}

export type InterleavedRow<T> = { readonly type: 'item'; readonly item: T } | { readonly type: 'insert'; readonly id: string };

export function timeOf(value: string | undefined): number {
  if (!value) return Number.NaN;
  return /^\d{10,}$/u.test(value) ? Number(value) : Date.parse(value);
}

export function interleave<T>(items: readonly T[], time: (item: T) => number, inserts: readonly TimedInsert[]): InterleavedRow<T>[] {
  const pending = [...inserts].sort((a, b) => (timeOf(a.at) || 0) - (timeOf(b.at) || 0));
  const rows: InterleavedRow<T>[] = [];
  for (const item of items) {
    const at = time(item);
    if (Number.isFinite(at)) {
      while (pending.length && !(timeOf(pending[0]!.at) > at)) rows.push({ type: 'insert', id: pending.shift()!.id });
    }
    rows.push({ type: 'item', item });
  }
  for (const insert of pending) rows.push({ type: 'insert', id: insert.id });
  return rows;
}
