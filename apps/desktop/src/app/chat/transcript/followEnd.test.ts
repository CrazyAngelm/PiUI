import { afterEach, describe, expect, it, vi } from 'vitest';
import { followEnd } from './followEnd';

/** The parts of a scroll box the action touches. */
function box(height = 500, view = 100) {
  const listeners = new Map<string, () => void>();
  const node = {
    scrollTop: 0,
    scrollHeight: height,
    clientHeight: view,
    addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
    removeEventListener: (type: string) => void listeners.delete(type),
  };
  return { node, listeners, element: node as unknown as HTMLElement };
}

let notify: (() => void) | undefined;
vi.stubGlobal(
  'MutationObserver',
  class {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe(): void {}
    disconnect(): void {
      notify = undefined;
    }
  },
);

afterEach(() => {
  notify = undefined;
});

describe('followEnd', () => {
  it('starts at the end and follows new output while the command runs', () => {
    const { node, element } = box();
    followEnd(element, true);
    expect(node.scrollTop).toBe(500);

    node.scrollHeight = 900;
    notify?.();
    expect(node.scrollTop).toBe(900);
  });

  it('stays where the reader scrolled it until they come back to the end', () => {
    const { node, listeners, element } = box();
    followEnd(element, true);

    node.scrollTop = 120;
    listeners.get('scroll')?.();
    node.scrollHeight = 900;
    notify?.();
    expect(node.scrollTop).toBe(120);

    node.scrollTop = 900 - 100;
    listeners.get('scroll')?.();
    node.scrollHeight = 1_000;
    notify?.();
    expect(node.scrollTop).toBe(1_000);
  });

  it('does not move a finished command and cleans up after itself', () => {
    const { node, listeners, element } = box();
    const action = followEnd(element, false);
    expect(node.scrollTop).toBe(0);

    node.scrollHeight = 900;
    notify?.();
    expect(node.scrollTop).toBe(0);

    action.update(true);
    expect(node.scrollTop).toBe(900);
    action.destroy();
    expect(listeners.size).toBe(0);
  });
});
