import { describe, expect, it } from 'vitest';
import { coalesceReads } from './coalescedReads';

/** A reader whose reads finish only when the test settles them, oldest first. */
function gatedReader() {
  const gates: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const started: string[] = [];
  const read = (arg: string): Promise<void> => {
    started.push(arg);
    return new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
  };
  const settle = async (index: number): Promise<void> => {
    gates[index]?.resolve();
    await tick();
  };
  return { read, started, gates, settle };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coalesceReads', () => {
  it('starts one read at once for a single request', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read);
    const done = reads.request('a');
    expect(reader.started).toEqual(['a']);
    reader.gates[0]?.resolve();
    await done;
    expect(reader.started).toEqual(['a']);
  });

  it('runs exactly one more read for a burst that arrives while one is in flight', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read);
    const first = reads.request('a');
    const burst = [reads.request('b'), reads.request('c'), reads.request('d')];
    expect(reader.started).toEqual(['a']);
    await reader.settle(0);
    // The follow-up starts after the first read finished and carries the first queued request.
    expect(reader.started).toEqual(['a', 'b']);
    await first;
    await reader.settle(1);
    await Promise.all(burst);
    expect(reader.started).toEqual(['a', 'b']);
  });

  it('resolves an awaited request only after a read that started after it', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read);
    void reads.request('a');
    let resolved = false;
    void reads.request('b').then(() => {
      resolved = true;
    });
    await reader.settle(0);
    expect(resolved).toBe(false);
    await reader.settle(1);
    expect(resolved).toBe(true);
  });

  it('goes idle again and reads on the next request', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read);
    const first = reads.request('a');
    await reader.settle(0);
    await first;
    void reads.request('b');
    expect(reader.started).toEqual(['a', 'b']);
    expect(reads.pending('x')).toBeDefined();
    await reader.settle(1);
    expect(reads.pending('x')).toBeUndefined();
  });

  it('keeps reading after a failed read', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read);
    const first = reads.request('a');
    const second = reads.request('b');
    reader.gates[0]?.reject(new Error('host down'));
    await expect(first).resolves.toBeUndefined();
    expect(reader.started).toEqual(['a', 'b']);
    reader.gates[1]?.reject(new Error('host down'));
    await expect(second).resolves.toBeUndefined();
    void reads.request('c');
    expect(reader.started).toEqual(['a', 'b', 'c']);
  });

  it('keeps keys apart and joins the newest read through pending', async () => {
    const reader = gatedReader();
    const reads = coalesceReads(reader.read, (arg) => arg[0] ?? '');
    void reads.request('a1');
    void reads.request('b1');
    expect(reader.started).toEqual(['a1', 'b1']);
    const queued = reads.request('a2');
    expect(reads.pending('a3')).toBe(queued);
    await reader.settle(0);
    expect(reader.started).toEqual(['a1', 'b1', 'a2']);
  });
});
