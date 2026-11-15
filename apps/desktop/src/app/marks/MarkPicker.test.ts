import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import MarkChoices from './MarkChoices.svelte';
import { MARK_EMOJI, pickColor, pickShape, startingChoice } from './markPicker';
import { MARK_COLORS, MARK_SHAPES, marks, validMark, type Mark } from './marks.svelte';

const square: Mark = { kind: 'shape', shape: 'square', color: 'green' };

afterEach(() => {
  marks.forgetSession('s1');
  vi.unstubAllGlobals();
});

function html(): string {
  return render(MarkChoices, { props: { target: { kind: 'session', id: 's1' }, onClose: () => undefined } }).body;
}

describe('MarkPicker body markup (the dialog itself portals, so the body is rendered)', () => {
  it('offers a color row, a shape row and an emoji grid, each labelled', () => {
    const body = html();
    expect(body).toContain('role="radiogroup" aria-label="Color"');
    expect(body).toContain('role="radiogroup" aria-label="Shape"');
    expect(body).toContain('role="group" aria-label="Emoji"');
    for (const name of ['Red', 'Gray', 'Circle', 'Hexagon']) expect(body).toContain(`aria-label="${name}"`);
    expect(body.match(/role="radio"/g)).toHaveLength(MARK_COLORS.length + MARK_SHAPES.length);
    expect(body.match(/aria-pressed=/g)).toHaveLength(MARK_EMOJI.length);
  });

  it('offers removal only when the target has a mark', () => {
    expect(html()).not.toContain('Remove mark');
    marks.setSession('s1', square);
    const body = html();
    expect(body).toContain('Remove mark');
    expect(body).toContain('aria-checked="true" aria-label="Square"');
  });
});

describe('choosing', () => {
  it('starts on the current shape and color, else blue and no shape', () => {
    expect(startingChoice(square)).toEqual({ color: 'green', shape: 'square' });
    expect(startingChoice({ kind: 'emoji', value: '🚀' })).toEqual({ color: 'blue', shape: undefined });
    expect(startingChoice(undefined)).toEqual({ color: 'blue', shape: undefined });
  });

  it('a shape applies with the chosen color', () => {
    expect(pickShape('pink', 'star')).toEqual({ kind: 'shape', shape: 'star', color: 'pink' });
  });

  it('a color recolors a shape mark at once and otherwise only waits for a shape', () => {
    expect(pickColor(square, 'red')).toEqual({ color: 'red', commit: { kind: 'shape', shape: 'square', color: 'red' } });
    expect(pickColor(undefined, 'red')).toEqual({ color: 'red', commit: undefined });
    expect(pickColor({ kind: 'emoji', value: '🚀' }, 'red').commit).toBeUndefined();
  });

  it('every offered emoji is a valid mark', () => {
    expect(MARK_EMOJI).toHaveLength(48);
    expect(new Set(MARK_EMOJI).size).toBe(48);
    for (const value of MARK_EMOJI) expect(validMark({ kind: 'emoji', value }), value).toBeDefined();
  });
});
