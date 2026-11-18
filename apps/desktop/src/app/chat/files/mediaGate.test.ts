import { describe, expect, it } from 'vitest';
import { MAX_PARALLEL_PREVIEWS, MEDIA_BUDGET_BYTES, MediaGate } from './mediaGate';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('MediaGate budget', () => {
  it('reserves before a preview is requested and refuses what does not fit', () => {
    expect(MEDIA_BUDGET_BYTES).toBe(192 * 1024 * 1024);
    const gate = new MediaGate(100);
    expect(gate.reserve(60)).toBe(true);
    expect(gate.reserve(41)).toBe(false);
    expect(gate.heldBytes).toBe(60);
    expect(gate.reserve(40)).toBe(true);
    gate.release(60);
    expect(gate.heldBytes).toBe(40);
    gate.release(1_000);
    expect(gate.heldBytes).toBe(0);
  });

  it('refuses sizes that are not sizes', () => {
    const gate = new MediaGate(100);
    for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(gate.reserve(bytes)).toBe(false);
    expect(gate.heldBytes).toBe(0);
  });
});

describe('MediaGate transfers', () => {
  it('runs at most three at a time and starts the next as one ends', async () => {
    expect(MAX_PARALLEL_PREVIEWS).toBe(3);
    const gate = new MediaGate();
    const open: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const task = () =>
      new Promise<void>((done) => {
        running += 1;
        peak = Math.max(peak, running);
        open.push(() => {
          running -= 1;
          done();
        });
      });
    const all = Array.from({ length: 5 }, () => gate.run(task));
    await settle();
    expect(running).toBe(3);
    open.shift()?.();
    await settle();
    expect(running).toBe(3);
    while (open.length) {
      open.shift()?.();
      await settle();
    }
    await Promise.all(all);
    expect(peak).toBe(3);
  });

  it('refuses queued transfers and empties the budget when the chat closes', async () => {
    const gate = new MediaGate(100, 1);
    gate.reserve(70);
    let finish!: () => void;
    const first = gate.run(() => new Promise<void>((done) => { finish = done; }));
    const second = gate.run(async () => undefined);
    gate.reset();
    expect(gate.heldBytes).toBe(0);
    await expect(second).rejects.toBeInstanceOf(Error);
    finish();
    await expect(first).resolves.toBeUndefined();
  });

  it('keeps going after a task fails', async () => {
    const gate = new MediaGate(100, 1);
    const failed = gate.run(() => Promise.reject(new Error('x')));
    const next = gate.run(async () => 'ok');
    await expect(failed).rejects.toBeInstanceOf(Error);
    await expect(next).resolves.toBe('ok');
  });
});
