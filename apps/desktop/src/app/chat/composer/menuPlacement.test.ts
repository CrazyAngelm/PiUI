import { describe, expect, it } from 'vitest';
import { MENU_MAX_HEIGHT, MENU_MIN_HEIGHT, menuPlacement } from './menuPlacement';

describe('menu placement', () => {
  it('opens above and grows to the limit when there is room', () => {
    expect(menuPlacement({ above: 900, below: 100 })).toEqual({ side: 'above', height: MENU_MAX_HEIGHT });
  });
  it('shrinks to the room above, so the menu scrolls instead of running off the top', () => {
    expect(menuPlacement({ above: 220, below: 40 })).toEqual({ side: 'above', height: 220 });
  });
  it('opens below when the room above is too short to be useful and below has more', () => {
    expect(menuPlacement({ above: MENU_MIN_HEIGHT - 1, below: 500 })).toEqual({ side: 'below', height: MENU_MAX_HEIGHT });
    expect(menuPlacement({ above: 60, below: 200 })).toEqual({ side: 'below', height: 200 });
  });
  it('stays above when both sides are short but above is not smaller', () => {
    expect(menuPlacement({ above: 120, below: 90 })).toEqual({ side: 'above', height: 120 });
  });
  it('fits the room it has instead of overflowing a short pane', () => {
    expect(menuPlacement({ above: 55, below: 0 })).toEqual({ side: 'above', height: 55 });
  });
  it('never makes the menu a sliver, and treats negative room as none', () => {
    expect(menuPlacement({ above: -30, below: -10 }).height).toBe(48);
    expect(menuPlacement({ above: 300, below: 300 }, 200)).toEqual({ side: 'above', height: 200 });
  });
});
