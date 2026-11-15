import { describe, expect, it, vi } from 'vitest';
import { createEscapeChord, FOCUS_BAR_MESSAGE, installEscapeChord } from './escapeChord';

const press = (key: string, timeStamp: number, repeat = false) => ({ key, repeat, timeStamp });

describe('escape chord', () => {
  it('needs two Escape presses close together', () => {
    const chord = createEscapeChord(800);
    expect(chord(press('Escape', 1000))).toBe(false);
    expect(chord(press('Escape', 1500))).toBe(true);
    // The chord starts over after it fires.
    expect(chord(press('Escape', 1600))).toBe(false);
  });

  it('forgets a single press after the window, and any other key in between', () => {
    const chord = createEscapeChord(800);
    expect(chord(press('Escape', 1000))).toBe(false);
    expect(chord(press('Escape', 2000))).toBe(false);
    expect(chord(press('a', 2100))).toBe(false);
    expect(chord(press('Escape', 2200))).toBe(false);
  });

  it('ignores a held key', () => {
    const chord = createEscapeChord(800);
    expect(chord(press('Escape', 1000))).toBe(false);
    expect(chord(press('Escape', 1050, true))).toBe(false);
    expect(chord(press('Escape', 1100, true))).toBe(false);
  });

  it('tells only a framed page, with a fixed message to its own origin', () => {
    const listeners: ((event: ReturnType<typeof press>) => void)[] = [];
    const post = vi.fn();
    const framed = {
      addEventListener: (_type: string, listener: (event: ReturnType<typeof press>) => void) => listeners.push(listener),
      parent: { postMessage: post },
      location: { origin: 'https://nano.example' },
    } as unknown as Window;
    installEscapeChord(framed);
    listeners[0]?.(press('Escape', 1));
    expect(post).not.toHaveBeenCalled();
    listeners[0]?.(press('Escape', 100));
    expect(post).toHaveBeenCalledWith(FOCUS_BAR_MESSAGE, 'https://nano.example');
    expect(FOCUS_BAR_MESSAGE).toEqual({ nanoRemote: 1, type: 'focus-bar' });

    const top: { parent?: unknown; location: { origin: string }; addEventListener: (type: string, listener: (event: ReturnType<typeof press>) => void) => void } = {
      location: { origin: 'https://nano.example' },
      addEventListener: (_type, listener) => void listeners.push(listener),
    };
    top.parent = top;
    post.mockClear();
    installEscapeChord(top as unknown as Window);
    listeners[1]?.(press('Escape', 1));
    listeners[1]?.(press('Escape', 100));
    expect(post).not.toHaveBeenCalled();
  });
});
