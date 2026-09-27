import { describe, expect, it } from 'vitest';
import { interleave } from './interleave';

const items = [
  { id: 'a', at: '2026-09-28T10:00:00.000Z' },
  { id: 'b' },
  { id: 'c', at: '2026-09-28T10:05:00.000Z' },
];
const time = (item: { at?: string }) => (item.at ? Date.parse(item.at) : Number.NaN);
const ids = (rows: ReturnType<typeof interleave<(typeof items)[number]>>) => rows.map((row) => (row.type === 'item' ? row.item.id : `run:${row.id}`));

describe('interleave', () => {
  it('puts each run before the first later item', () => {
    expect(ids(interleave(items, time, [{ id: '1', at: '2026-09-28T10:01:00.000Z' }]))).toEqual(['a', 'b', 'run:1', 'c']);
    expect(ids(interleave(items, time, [{ id: '0', at: '2026-09-28T09:00:00.000Z' }]))).toEqual(['run:0', 'a', 'b', 'c']);
  });

  it('appends runs later than every item, in time order', () => {
    const rows = interleave(items, time, [
      { id: 'late', at: '2026-09-28T11:00:00.000Z' },
      { id: 'later', at: '1800000000000' },
    ]);
    expect(ids(rows)).toEqual(['a', 'b', 'c', 'run:late', 'run:later']);
  });

  it('shows runs in an empty chat', () => {
    expect(ids(interleave<(typeof items)[number]>([], time, [{ id: 'x', at: '2026-09-28T10:00:00.000Z' }]))).toEqual(['run:x']);
  });
});
